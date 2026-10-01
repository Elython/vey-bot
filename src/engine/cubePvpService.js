const { EventEmitter } = require('events');
const { ActionExecutor } = require('./actionExecutor');
const { CUBE_PVP_NODES } = require('./cubeCatalog');
const {
  ReadPriority,
  WorldDomain,
  assertAccountKey,
  assertAccountScope,
  createCollectorResult,
} = require('./worldState');

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const CUBE_UI_MAX_AGE_MS = 2_500;
const CUBE_RESOURCE_PATTERN = /^instance:(\d{1,30})$/;

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cubeResourceKey(instanceId) {
  const normalized = String(instanceId || '');
  if (!/^\d{1,30}$/.test(normalized)) throw new Error('Cube resource requires a numeric instance ID');
  return `instance:${normalized}`;
}

function parseCubeResourceKey(resourceKey) {
  const match = String(resourceKey || '').match(CUBE_RESOURCE_PATTERN);
  if (!match) throw new Error('Invalid Cube world-state resource key');
  return match[1];
}

function sameCommitment(left, right) {
  if (!left || !right) return false;
  return Number(left.instanceId) === Number(right.instanceId)
    && Number(left.nodeId) === Number(right.nodeId)
    && Number(left.matchNo) === Number(right.matchNo);
}

function nodeCooldownKey(instanceId, nodeId) {
  return `${Number(instanceId)}:${Number(nodeId)}`;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Cube PvP read cancelled');
  error.name = 'AbortError';
  error.code = 'READ_ABORTED';
  throw error;
}

function normalizeCubeObservation({ cube, nodePages = [], now = Date.now() } = {}) {
  const instanceId = String(cube?.instanceId || '');
  if (!/^\d{1,30}$/.test(instanceId)) throw new Error('Cube observation has no verified instance ID');
  const pageByNode = new Map(nodePages.map(entry => [Number(entry.nodeId), entry]));
  const nodes = [];
  const nodeCooldowns = [];
  let serverCommitment = null;

  for (const definition of CUBE_PVP_NODES) {
    const cubeNode = (cube.nodes || []).find(node => Number(node.id) === definition.id) || null;
    const pageEntry = pageByNode.get(definition.id) || null;
    const page = pageEntry?.page || null;
    const matches = (page?.matches || []).map(match => ({
      matchNo: Number(match.matchNo),
      title: String(match.title || `Match #${match.matchNo}`),
      status: ['open', 'live', 'cleared'].includes(match.status) ? match.status : 'unknown',
      occupiedSlots: Math.max(0, Number(match.occupiedSlots) || 0),
      maximumSlots: Math.max(0, Number(match.maximumSlots) || 0),
      emptySlots: (match.emptySlots || []).map(Number).filter(value => Number.isInteger(value) && value > 0),
      joined: match.joined === true,
    })).filter(match => Number.isInteger(match.matchNo) && match.matchNo > 0);

    if (page?.commitment) {
      const committedMatch = matches.find(match => match.matchNo === Number(page.commitment.matchNo));
      const observedCommitment = {
        instanceId: Number(instanceId),
        nodeId: definition.id,
        nodeName: String(cubeNode?.name || definition.label),
        matchNo: Number(page.commitment.matchNo),
        matchTitle: String(committedMatch?.title || `Match #${page.commitment.matchNo}`),
        slotIndex: Number(page.commitment.slotIndex) || null,
        cooldownRemainingMs: Math.max(0, Number(page.commitment.cooldownRemainingMs) || 0),
      };
      nodeCooldowns.push({
        instanceId: observedCommitment.instanceId,
        nodeId: observedCommitment.nodeId,
        cooldownRemainingMs: observedCommitment.cooldownRemainingMs,
      });
      if (!serverCommitment && committedMatch && committedMatch.status !== 'cleared') serverCommitment = observedCommitment;
    }

    nodes.push({
      id: definition.id,
      name: String(cubeNode?.name || definition.label),
      status: ['hidden', 'available', 'in_progress', 'cleared'].includes(cubeNode?.status)
        ? cubeNode.status
        : 'hidden',
      openCount: matches.filter(match => match.status === 'open').length
        || Math.max(0, Number(cubeNode?.stateMeta?.pvp_rooms_open) || 0),
      maximumMatches: definition.maximumMatches,
      matches,
      error: pageEntry?.error ? String(pageEntry.error) : null,
    });
  }

  return {
    recognized: true,
    cube: { instanceId: Number(instanceId), url: String(cube.url || '') },
    nodes,
    nodeCooldowns,
    serverCommitment,
    observedAt: Number(now),
  };
}

class CubePvPService extends EventEmitter {
  constructor({
    gameAPI,
    windowManager,
    configManager,
    accountDatabase = null,
    areaDirectoryService = null,
    readCoordinator = null,
    worldStateService = null,
    accountKey = null,
    accountName,
    mode = 'shared',
    now = () => Date.now(),
    uiMaxAgeMs = CUBE_UI_MAX_AGE_MS,
  }) {
    super();
    this.gameAPI = gameAPI;
    this.windowManager = windowManager;
    this.configManager = configManager;
    this.accountName = accountName;
    this.accountDatabase = accountDatabase;
    this.areaDirectoryService = areaDirectoryService;
    this.readCoordinator = readCoordinator;
    this.worldStateService = worldStateService || readCoordinator?.worldStateService || null;
    this.mode = mode;
    if (!['shared', 'legacy'].includes(this.mode)) throw new Error(`Unsupported Cube PvP mode: ${this.mode}`);
    if (this.mode === 'shared' && (!readCoordinator || !areaDirectoryService)) {
      throw new TypeError('Shared Cube PvP requires ReadCoordinator and AreaDirectoryService');
    }
    this.accountKey = this.mode === 'shared' ? assertAccountKey(accountKey) : null;
    this.accountRef = this.accountKey || this.accountName;
    this.now = now;
    this.uiMaxAgeMs = Math.max(0, Number(uiMaxAgeMs) || 0);
    this.sourceRevision = 0;
    this.running = false;
    this.timer = null;
    this.inFlight = null;
    this.runtimeConfig = null;
    this.runtimeCommitment = null;
    this.nodeCooldowns = new Map();
    this.pendingJoin = null;
    this.lastRecordedState = null;
    this.statusRevision = 0;
    this.status = { state: 'idle', lastStateAt: null, error: null, commitment: null };
    this.executor = new ActionExecutor({
      CUBE_SCAN: () => this._discover(),
      CUBE_PVP_JOIN: params => this.gameAPI.joinCubePvpSlot(params),
    });
  }

  getCollector() {
    return this;
  }

  _selectCubeInstance(instances = []) {
    const cubes = (instances || []).filter(entry => entry.areaKey === 'polyhedral_crucible'
      || /polyhedral crucible/i.test(String(entry.name || '')))
      .sort((left, right) => Number(right.instanceId) - Number(left.instanceId));
    return cubes.find(entry => entry.active === true || entry.state === 'active') || cubes[0] || null;
  }

  async _readRawObservation(directoryEntry, signal = null) {
    throwIfAborted(signal);
    const directoryInstances = directoryEntry ? [directoryEntry] : null;
    const cube = await this.gameAPI.getCubeHome({ directoryInstances });
    throwIfAborted(signal);
    if (directoryEntry && Number(cube.instanceId) !== Number(directoryEntry.instanceId)) {
      throw new Error('Cube instance changed while its observation was being collected');
    }
    const nodePages = [];
    for (const definition of CUBE_PVP_NODES) {
      throwIfAborted(signal);
      const cubeNode = (cube.nodes || []).find(node => Number(node.id) === definition.id) || null;
      if (!cubeNode || cubeNode.status === 'hidden') {
        nodePages.push({ nodeId: definition.id, page: null, error: 'That route is still sealed.' });
        continue;
      }
      try {
        nodePages.push({ nodeId: definition.id, page: await this.gameAPI.getCubePvpNode(cube.instanceId, definition.id), error: null });
      } catch (error) {
        nodePages.push({ nodeId: definition.id, page: null, error: error?.message || String(error) });
      }
    }
    throwIfAborted(signal);
    return normalizeCubeObservation({ cube, nodePages, now: this.now() });
  }

  async collect(request = {}) {
    assertAccountScope(this.accountKey, request.accountKey);
    const instanceId = parseCubeResourceKey(request.resourceKey);
    const directory = this.areaDirectoryService?.peekDirectory?.();
    if (!directory) throw new Error('Cube directory must be resolved before Cube collection');
    const directoryEntry = (directory.instances || []).find(entry => String(entry.instanceId) === instanceId
      && entry.areaKey === 'polyhedral_crucible');
    if (!directoryEntry) throw new Error(`Cube instance ${instanceId} is no longer present in the shared directory`);
    const observation = await this._readRawObservation(directoryEntry, request.signal);
    return createCollectorResult({
      accountKey: this.accountKey,
      domain: WorldDomain.CUBE,
      resourceKey: request.resourceKey,
      observation,
      observedAt: Number(this.now()),
      sourceRevision: ++this.sourceRevision,
      source: `GET Cube instance ${instanceId} and PvP nodes 7-9`,
    });
  }

  async _readObservation({
    priority = ReadPriority.VISIBLE_UI,
    maxAgeMs = this.uiMaxAgeMs,
    force = false,
    directoryPriority = priority,
    directoryMaxAgeMs = maxAgeMs,
    forceDirectory = false,
    signal = null,
  } = {}) {
    let directoryEntry = null;
    if (this.areaDirectoryService) {
      const directory = await this.areaDirectoryService.readDirectory({
        priority: directoryPriority,
        maxAgeMs: directoryMaxAgeMs,
        force: forceDirectory,
        signal,
      });
      if (directory?.guildMember === false) {
        return {
          unavailable: true,
          availability: {
            state: 'unavailable',
            available: false,
            verified: true,
            reason: directory.reason || 'not_in_guild',
            source: 'guild_dungeon.php',
          },
          cube: null,
          nodes: [],
          serverCommitment: null,
          nodeCooldowns: [],
        };
      }
      directoryEntry = this._selectCubeInstance(directory?.instances || []);
      if (!directoryEntry) throw new Error('The Polyhedral Crucible is not available');
    }
    throwIfAborted(signal);
    if (this.mode === 'legacy') return this._readRawObservation(directoryEntry, signal);
    if (!directoryEntry) throw new Error('Shared Cube PvP requires the shared Cube directory');
    const resourceKey = cubeResourceKey(directoryEntry.instanceId);
    this.worldStateService?.prune?.(this.accountKey, (_value, identity) => (
      identity.domain === WorldDomain.CUBE && identity.resourceKey !== resourceKey
    ));
    let snapshot;
    try {
      snapshot = await this.readCoordinator.read({
        accountKey: this.accountKey,
        domain: WorldDomain.CUBE,
        resourceKey,
        priority,
        maxAgeMs: force ? 0 : maxAgeMs,
        force,
        signal,
      });
    } catch (error) {
      if (error?.code !== 'READ_ABORTED' && error?.name !== 'AbortError') {
        this.readCoordinator.invalidate(this.accountKey, WorldDomain.CUBE, resourceKey, 'Cube PvP refresh failed');
      }
      throw error;
    }
    const observation = clone(snapshot?.value);
    if (observation && typeof observation === 'object') delete observation.meta;
    return observation;
  }

  _runtimeCommitmentFromObserved(observed) {
    if (!observed) return null;
    const sameRuntime = sameCommitment(observed, this.runtimeCommitment);
    const remaining = Math.max(0, Number(observed.cooldownRemainingMs) || 0);
    return {
      instanceId: Number(observed.instanceId),
      nodeId: Number(observed.nodeId),
      nodeName: String(observed.nodeName || ''),
      matchNo: Number(observed.matchNo),
      matchTitle: String(observed.matchTitle || ''),
      slotIndex: Number(observed.slotIndex) || Number(sameRuntime ? this.runtimeCommitment?.slotIndex : 0) || null,
      joinedAt: sameRuntime && Number(this.runtimeCommitment?.joinedAt)
        ? Number(this.runtimeCommitment.joinedAt)
        : this.now() - Math.max(0, TWO_HOURS_MS - remaining),
      lastLogId: sameRuntime ? Math.max(0, Number(this.runtimeCommitment?.lastLogId) || 0) : 0,
      cooldownRemainingMs: remaining,
    };
  }

  _pruneNodeCooldowns(instanceId) {
    const now = this.now();
    for (const [key, expiresAt] of this.nodeCooldowns) {
      if (!key.startsWith(`${Number(instanceId)}:`) || Number(expiresAt) <= now) this.nodeCooldowns.delete(key);
    }
  }

  _setNodeCooldown(instanceId, nodeId, expiresAt) {
    const key = nodeCooldownKey(instanceId, nodeId);
    const normalized = Math.max(this.now(), Number(expiresAt) || 0);
    const existing = Number(this.nodeCooldowns.get(key)) || 0;
    if (normalized > existing) this.nodeCooldowns.set(key, normalized);
  }

  _syncObservedNodeCooldowns(observation) {
    const instanceId = Number(observation?.cube?.instanceId);
    if (!Number.isInteger(instanceId)) return;
    this._pruneNodeCooldowns(instanceId);
    for (const cooldown of observation?.nodeCooldowns || []) {
      const remaining = Math.max(0, Number(cooldown.cooldownRemainingMs) || 0);
      if (remaining > 0) this._setNodeCooldown(instanceId, cooldown.nodeId, this.now() + remaining);
    }
  }

  _markCommitmentCooldown(commitment) {
    if (!commitment) return;
    const remaining = Number(commitment.cooldownRemainingMs);
    const joinedAt = Number(commitment.joinedAt);
    const expiresAt = Number.isFinite(joinedAt) && joinedAt > 0
      ? joinedAt + TWO_HOURS_MS
      : this.now() + Math.max(0, Number.isFinite(remaining) ? remaining : TWO_HOURS_MS);
    this._setNodeCooldown(commitment.instanceId, commitment.nodeId, expiresAt);
  }

  _nodeCooldownRemaining(instanceId, nodeId) {
    const key = nodeCooldownKey(instanceId, nodeId);
    const remaining = Math.max(0, (Number(this.nodeCooldowns.get(key)) || 0) - this.now());
    if (remaining === 0) this.nodeCooldowns.delete(key);
    return remaining;
  }

  _projectObservation(observation, config) {
    this._syncObservedNodeCooldowns(observation);
    const instanceId = Number(observation?.cube?.instanceId);
    const candidates = [];
    const nodes = (observation?.nodes || []).map(rawNode => {
      const policy = config.cubePvp?.nodes?.[String(rawNode.id)] || { enabled: false, matches: {} };
      const cooldownRemainingMs = this._nodeCooldownRemaining(instanceId, rawNode.id);
      const matches = (rawNode.matches || []).map(match => {
        const matchPolicy = policy.matches?.[String(match.matchNo)] || {};
        const projected = {
          ...clone(match),
          enabled: matchPolicy.enabled !== false,
          priority: Math.max(0, Math.trunc(Number(matchPolicy.priority) || 0)),
        };
        if (policy.enabled === true && cooldownRemainingMs === 0
          && projected.enabled && projected.status === 'open' && projected.emptySlots.length > 0) {
          candidates.push({ nodeId: Number(rawNode.id), match: projected });
        }
        return projected;
      });
      return { ...clone(rawNode), enabled: policy.enabled === true, cooldownRemainingMs, matches };
    });
    for (const candidate of candidates) candidate.node = nodes.find(node => Number(node.id) === candidate.nodeId);
    candidates.sort((left, right) => left.match.priority - right.match.priority
      || left.match.matchNo - right.match.matchNo
      || Number(left.node.id) - Number(right.node.id));
    const serverCommitment = this._runtimeCommitmentFromObserved(observation?.serverCommitment || null);
    const status = this.getStatus();
    // Runtime commitment is the scheduler/watcher authority. A visible UI read
    // can complete after the service has already released an old node and
    // joined a new one, so an older observed commitment must never redraw the
    // previous node over the current runtime state.
    if (serverCommitment && (!status.commitment || sameCommitment(serverCommitment, status.commitment))) {
      const joinedMatch = nodes.flatMap(node => node.matches).find(match => match.joined
        && Number(match.matchNo) === Number(serverCommitment.matchNo));
      status.commitment = serverCommitment;
      status.cooldownRemainingMs = Math.max(0, Number(serverCommitment.cooldownRemainingMs) || 0);
      status.state = joinedMatch?.status === 'live' ? 'live'
        : joinedMatch?.status === 'cleared' ? 'cleared' : 'joined';
    }
    return {
      cube: clone(observation?.cube),
      available: observation?.unavailable !== true,
      availability: clone(observation?.availability || null),
      nodes,
      candidate: candidates[0] || null,
      serverCommitment,
      status,
      moduleSelected: this._cubeModuleSelected(config),
    };
  }

  async getOverview(config = this.configManager.getConfig(), options = {}) {
    const observation = await this._readObservation({
      priority: options.priority || options.directoryPriority || ReadPriority.VISIBLE_UI,
      maxAgeMs: options.maxAgeMs ?? this.uiMaxAgeMs,
      force: options.force === true || options.forceCube === true,
      directoryPriority: options.directoryPriority || options.priority || ReadPriority.VISIBLE_UI,
      directoryMaxAgeMs: options.directoryMaxAgeMs ?? options.maxAgeMs ?? this.uiMaxAgeMs,
      forceDirectory: options.forceDirectory === true,
      signal: options.signal || null,
    });
    return this._projectObservation(observation, config);
  }

  invalidate(instanceId, reason = 'Cube PvP observation invalidated') {
    if (this.mode !== 'shared' || !instanceId) return false;
    return this.readCoordinator.invalidate(this.accountKey, WorldDomain.CUBE, cubeResourceKey(instanceId), reason);
  }

  getStatus() {
    const commitment = clone(this.runtimeCommitment);
    const waitingCooldownRemainingMs = Number(this.status?.cooldownUntil) > 0
      ? Math.max(0, Number(this.status.cooldownUntil) - this.now())
      : Math.max(0, Number(this.status?.cooldownRemainingMs) || 0);
    return {
      ...clone(this.status),
      revision: this.statusRevision,
      commitment,
      pendingJoin: this.pendingJoin ? clone(this.pendingJoin) : null,
      cooldownRemainingMs: commitment
        ? Math.max(0, (Number(commitment.joinedAt) + TWO_HOURS_MS) - this.now())
        : waitingCooldownRemainingMs,
    };
  }

  _waitingStatus(overview) {
    const enabledNodes = (overview?.nodes || []).filter(node => node.enabled === true);
    const cooldownBlocked = enabledNodes.flatMap(node => (node.matches || [])
      .filter(match => match.enabled !== false && match.status === 'open' && match.emptySlots.length > 0
        && Number(node.cooldownRemainingMs) > 0)
      .map(match => ({ node, match })))
      .sort((left, right) => Number(left.node.cooldownRemainingMs) - Number(right.node.cooldownRemainingMs)
        || Number(left.match.priority) - Number(right.match.priority)
        || Number(left.match.matchNo) - Number(right.match.matchNo));
    if (cooldownBlocked.length > 0) {
      const { node, match } = cooldownBlocked[0];
      return {
        state: 'waiting_for_node_cooldown',
        cooldownRemainingMs: Math.max(0, Number(node.cooldownRemainingMs) || 0),
        cooldownUntil: this.now() + Math.max(0, Number(node.cooldownRemainingMs) || 0),
        waitReason: `${node.name || `Node ${node.id}`} · match #${match.matchNo}`,
      };
    }

    const erroredNodes = enabledNodes.filter(node => node.error);
    if (erroredNodes.length > 0 && erroredNodes.length === enabledNodes.length) {
      return {
        state: 'waiting_for_node_data',
        cooldownRemainingMs: 0,
        waitReason: erroredNodes.map(node => node.name || `Node ${node.id}`).join(', '),
      };
    }

    const fullOpenMatches = enabledNodes.flatMap(node => (node.matches || [])
      .filter(match => match.enabled !== false && match.status === 'open' && match.emptySlots.length === 0)
      .map(match => ({ node, match })));
    return {
      state: 'waiting_for_open_match',
      cooldownRemainingMs: 0,
      waitReason: fullOpenMatches.length > 0
        ? 'Open matches currently have no empty slot'
        : 'No enabled OPEN match is currently available',
    };
  }

  async start(config = this.configManager.getConfig()) {
    const wasRunning = this.running;
    this.running = true;
    this.runtimeConfig = clone(config);
    if (config.cubePvp?.enabled !== true || !this._cubeModuleSelected(config)) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.status = {
        state: config.cubePvp?.enabled === true ? 'waiting_for_cube_module' : 'disabled',
        lastStateAt: new Date(this.now()).toISOString(),
        error: null,
        commitment: this.runtimeCommitment,
      };
      return this._publish();
    }
    // A service that was started while another Dungeon was selected remains
    // alive with no timer. Starting it again after Cube becomes active must
    // reconfigure and scan immediately instead of returning the stale waiting
    // state. This is also the safe idempotent path used by Resume/Apply.
    if (wasRunning && this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this._runTick(config).catch(error => this._setError(error));
    this._schedule();
    return this.getStatus();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight?.catch?.(() => null);
    this.windowManager.destroyCubePvpWatcher(this.accountName);
    this.status = { ...this.status, state: this.runtimeCommitment ? 'paused' : 'idle' };
    this._publish();
    return true;
  }

  async openMatch() {
    if (!this.runtimeCommitment) return false;
    return this.windowManager.openCubePvpMatch(this.accountName, this._matchUrl(this.runtimeCommitment));
  }

  _schedule() {
    if (!this.running || this.timer) return;
    const minutes = Math.max(1, Number(this.runtimeConfig?.cubePvp?.recheckMinutes) || 5);
    this.timer = setTimeout(() => {
      this.timer = null;
      this._runTick(this.runtimeConfig || this.configManager.getConfig())
        .catch(error => this._setError(error))
        .finally(() => this._schedule());
    }, minutes * 60 * 1000);
  }

  _runTick(config) {
    if (this.inFlight) return this.inFlight;
    const operation = this._tick(config).finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  async _tick(config) {
    if (!this.running || config.cubePvp?.enabled !== true || !this._cubeModuleSelected(config)) return null;
    const overview = await this.getOverview(config, {
      priority: ReadPriority.ACTIVE_MODULE,
      maxAgeMs: 0,
      forceCube: true,
      directoryPriority: ReadPriority.ACTIVE_MODULE,
      directoryMaxAgeMs: 0,
      forceDirectory: true,
    });
    if (overview.serverCommitment) this._adoptServerCommitment(overview.serverCommitment, 'server_reconciled');
    if (this.pendingJoin && !overview.serverCommitment) {
      const reconciliation = await this._reconcilePendingJoin(overview);
      if (reconciliation?.released === true && this.running) {
        return this._tick(this.runtimeConfig || this.configManager.getConfig());
      }
      return reconciliation;
    }
    if (this.runtimeCommitment) {
      const reconciliation = await this._reconcile(this.runtimeCommitment, overview);
      if (reconciliation?.released === true && this.running) {
        return this._tick(this.runtimeConfig || this.configManager.getConfig());
      }
      return reconciliation;
    }
    if (!overview.candidate) {
      this.status = {
        ...this._waitingStatus(overview),
        lastStateAt: new Date(this.now()).toISOString(),
        error: null,
        commitment: null,
      };
      return this._publish();
    }

    const { node, match } = overview.candidate;
    const params = {
      instanceId: overview.cube.instanceId,
      nodeId: node.id,
      matchNo: match.matchNo,
      slotIndex: match.emptySlots[0],
      nodeName: node.name,
      matchTitle: match.title,
    };
    let result;
    try {
      result = await this.executor.execute({ action: 'CUBE_PVP_JOIN', params }, { dryRun: config.safety?.dryRun === true });
    } catch (error) {
      if (!['TIMEOUT', 'REQUEST_FAILED', 'SESSION_DESTROYED'].includes(error?.code)) throw error;
      this.pendingJoin = { ...params, joinedAt: this.now(), lastLogId: 0, ambiguous: true };
      return this._confirmPendingJoin(overview, 'Join response was ambiguous');
    }
    if (result?.dryRun) {
      this.status = { state: 'dry_run', lastStateAt: new Date(this.now()).toISOString(), error: null, commitment: null };
      return this._publish();
    }
    if (!result?.success) {
      this.status = { state: 'join_rejected', lastStateAt: new Date(this.now()).toISOString(), error: result?.message || 'Join rejected', commitment: null };
      return this._publish();
    }
    this.pendingJoin = { ...params, joinedAt: this.now(), lastLogId: 0, ambiguous: false };
    return this._confirmPendingJoin(overview, null);
  }

  async _confirmPendingJoin(overview, warning = null) {
    const pending = this.pendingJoin;
    if (!pending) return null;
    this.invalidate(pending.instanceId, 'Cube PvP join requires authoritative revalidation');
    let refreshed = overview;
    try {
      refreshed = await this.getOverview(this.runtimeConfig || this.configManager.getConfig(), {
        priority: ReadPriority.MUTATION_REVALIDATION,
        maxAgeMs: 0,
        forceCube: true,
        directoryPriority: ReadPriority.MUTATION_REVALIDATION,
        directoryMaxAgeMs: this.uiMaxAgeMs,
      });
    } catch (error) {
      warning ||= error.message;
    }
    if (refreshed?.serverCommitment && sameCommitment(refreshed.serverCommitment, pending)) {
      this._adoptServerCommitment(refreshed.serverCommitment, 'join_confirmed');
      return this._reconcile(this.runtimeCommitment, refreshed);
    }
    await this.windowManager.ensureCubePvpWatcher(this.accountName, this._matchUrl(pending));
    try {
      const state = await this.gameAPI.getCubePvpState(pending, pending.lastLogId || 0);
      if (state.roomJoined === true || state.inMatch === true || state.ended === true
        || ['live', 'cleared'].includes(state.roomStatus)) {
        this._adoptPendingJoin(state);
        return this._reconcile(this.runtimeCommitment, refreshed, state);
      }
    } catch (error) {
      warning ||= error.message;
    }
    this.status = {
      state: 'reconciling_join',
      lastStateAt: new Date(this.now()).toISOString(),
      error: warning,
      commitment: null,
    };
    this._publish();
    return { pending: true };
  }

  async _reconcilePendingJoin(overview) {
    if (!this.pendingJoin) return null;
    if (Number(overview?.cube?.instanceId) !== Number(this.pendingJoin.instanceId)) {
      this.windowManager.destroyCubePvpWatcher(this.accountName);
      this.pendingJoin = null;
      return { released: true, releaseReason: 'new_cube_instance' };
    }
    return this._confirmPendingJoin(overview, null);
  }

  _adoptPendingJoin(state) {
    const pending = this.pendingJoin;
    if (!pending) return;
    this.runtimeCommitment = {
      ...pending,
      slotIndex: Number(state.roomSlot) || Number(pending.slotIndex) || null,
      lastLogId: Math.max(0, Number(state.lastLogId) || 0),
    };
    this._markCommitmentCooldown(this.runtimeCommitment);
    this.pendingJoin = null;
    this._recordJoin(this.runtimeCommitment, 'watcher_confirmed');
  }

  _adoptServerCommitment(commitment, reason) {
    const changed = !sameCommitment(commitment, this.runtimeCommitment);
    if (changed && this.runtimeCommitment) this.windowManager.destroyCubePvpWatcher(this.accountName);
    this.runtimeCommitment = clone(commitment);
    this._markCommitmentCooldown(this.runtimeCommitment);
    this.pendingJoin = null;
    if (changed) this._recordJoin(this.runtimeCommitment, reason);
  }

  _recordJoin(commitment, releaseReason) {
    this.accountDatabase?.recordEvent(this.accountRef, 'cube_pvp_join', {
      instanceId: commitment.instanceId,
      nodeId: commitment.nodeId,
      nodeName: commitment.nodeName,
      matchNo: commitment.matchNo,
      slotIndex: commitment.slotIndex,
      releaseReason,
    });
  }

  async _discover() {
    const overview = await this.getOverview(this.runtimeConfig || this.configManager.getConfig(), {
      priority: ReadPriority.ACTIVE_MODULE,
      maxAgeMs: 0,
      forceCube: true,
      directoryPriority: ReadPriority.ACTIVE_MODULE,
      directoryMaxAgeMs: 0,
      forceDirectory: true,
    });
    return overview.candidate
      ? { cube: overview.cube, node: overview.candidate.node, candidate: overview.candidate.match }
      : { cube: overview.cube, node: null, candidate: null };
  }

  _cubeModuleSelected(config) {
    return config.general?.module === 'dungeons' && config.general?.dungeonMap === 'polyhedral_crucible';
  }

  _releaseCommitment(commitment, state, releaseReason) {
    this._markCommitmentCooldown(commitment);
    this.accountDatabase?.recordEvent(this.accountRef, 'cube_pvp_result', {
      instanceId: commitment.instanceId,
      nodeId: commitment.nodeId,
      nodeName: commitment.nodeName,
      matchNo: commitment.matchNo,
      slotIndex: commitment.slotIndex,
      winnerSide: state.winnerSide,
      durationMs: Math.max(0, this.now() - Number(commitment.joinedAt || this.now())),
      releaseReason,
    });
    this.runtimeCommitment = null;
    this.pendingJoin = null;
    this.invalidate(commitment.instanceId, `Cube PvP commitment released: ${releaseReason}`);
    this.windowManager.destroyCubePvpWatcher(this.accountName);
    return state.winnerSide ? `cleared_${String(state.winnerSide).toLowerCase()}` : 'cleared';
  }

  async _reconcile(commitment, overview, suppliedState = null) {
    if (Number(overview?.cube?.instanceId) !== Number(commitment.instanceId)) {
      this._releaseCommitment(commitment, { winnerSide: null }, 'new_cube_instance');
      this.status = { state: 'cleared', lastStateAt: new Date(this.now()).toISOString(), error: null, commitment: null, winnerSide: null };
      this._publish();
      return { released: true, releaseReason: 'new_cube_instance' };
    }
    const node = overview.nodes?.find(entry => Number(entry.id) === Number(commitment.nodeId));
    const observedMatch = node?.matches?.find(entry => Number(entry.matchNo) === Number(commitment.matchNo));
    let state = suppliedState || {
      ended: observedMatch?.status === 'cleared',
      winnerSide: null,
      roomStatus: observedMatch?.status || '',
      lastLogId: commitment.lastLogId || 0,
    };
    if (!state.ended && !suppliedState) {
      await this.windowManager.ensureCubePvpWatcher(this.accountName, this._matchUrl(commitment));
      try {
        state = await this.gameAPI.getCubePvpState(commitment, commitment.lastLogId || 0);
      } catch (error) {
        if (!observedMatch) throw error;
      }
    }
    const next = { ...commitment, lastLogId: Math.max(0, Number(state.lastLogId) || 0) };
    this.runtimeCommitment = next;
    const label = state.ended ? 'cleared'
      : state.roomStatus === 'live' || observedMatch?.status === 'live' ? 'live' : 'joined';
    const releaseReason = state.ended ? 'match_cleared' : null;
    if (state.ended) this._releaseCommitment(commitment, state, releaseReason);
    this.status = {
      state: label,
      lastStateAt: new Date(this.now()).toISOString(),
      error: null,
      commitment: releaseReason ? null : next,
      winnerSide: state.winnerSide,
    };
    if (this.status.state !== this.lastRecordedState) {
      this.lastRecordedState = this.status.state;
      this.accountDatabase?.recordEvent(this.accountRef, 'cube_pvp_state', {
        instanceId: commitment.instanceId,
        nodeId: commitment.nodeId,
        nodeName: commitment.nodeName,
        matchNo: commitment.matchNo,
        slotIndex: commitment.slotIndex,
        state: this.status.state,
      });
    }
    this._publish();
    return { released: releaseReason !== null, releaseReason };
  }

  _matchUrl(locator) {
    return `https://demonicscans.org/pvp_style_battle.php?source=cube&instance_id=${encodeURIComponent(locator.instanceId)}&node_id=${encodeURIComponent(locator.nodeId)}&match_no=${encodeURIComponent(locator.matchNo)}`;
  }

  _setError(error) {
    this.status = { ...this.status, state: 'error', error: error?.message || String(error), lastStateAt: new Date(this.now()).toISOString() };
    this._publish();
  }

  _publish() {
    this.statusRevision += 1;
    const status = this.getStatus();
    this.emit('status', status);
    return status;
  }
}

module.exports = {
  CUBE_UI_MAX_AGE_MS,
  CubePvPService,
  TWO_HOURS_MS,
  cubeResourceKey,
  normalizeCubeObservation,
  parseCubeResourceKey,
};
