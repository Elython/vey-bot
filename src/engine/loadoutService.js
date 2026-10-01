const { buildLoadoutSnapshot } = require('./loadoutCatalog');
const {
  ReadPriority,
  WorldDomain,
  assertAccountKey,
  assertAccountScope,
  createCollectorResult,
} = require('./worldState');

const LOADOUT_CONTEXTS = new Set(['attack', 'pvp_attack', 'defense']);
const LOADOUT_KINDS = new Set(['gear', 'pets']);
const ACTIVE_LOADOUT_PREFIX = 'active';
const SAVED_LOADOUT_PREFIX = 'saved';

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function requireContext(value) {
  const context = String(value || '');
  if (!LOADOUT_CONTEXTS.has(context)) throw new Error('Unknown loadout context');
  return context;
}

function requireKind(value) {
  const kind = String(value || '');
  if (!LOADOUT_KINDS.has(kind)) throw new Error('Unknown loadout kind');
  return kind;
}

function requireSetNumber(value) {
  const setNumber = Number(value);
  if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 10) {
    throw new Error('Unknown Quick Set number');
  }
  return setNumber;
}

function activeLoadoutResourceKey(gearContext = 'attack', petContext = 'attack') {
  return `${ACTIVE_LOADOUT_PREFIX}:${requireContext(gearContext)}:${requireContext(petContext)}`;
}

function savedLoadoutResourceKey(kind, context = 'attack', setNumber) {
  return `${SAVED_LOADOUT_PREFIX}:${requireKind(kind)}:${requireContext(context)}:${requireSetNumber(setNumber)}`;
}

function parseLoadoutResourceKey(resourceKey) {
  const parts = String(resourceKey || '').split(':');
  if (parts[0] === ACTIVE_LOADOUT_PREFIX && parts.length === 3) {
    return {
      type: ACTIVE_LOADOUT_PREFIX,
      gearContext: requireContext(parts[1]),
      petContext: requireContext(parts[2]),
    };
  }
  if (parts[0] === SAVED_LOADOUT_PREFIX && parts.length === 4) {
    return {
      type: SAVED_LOADOUT_PREFIX,
      kind: requireKind(parts[1]),
      context: requireContext(parts[2]),
      setNumber: requireSetNumber(parts[3]),
    };
  }
  throw new Error('Unknown loadout resource');
}

function normalizeActiveLoadoutObservation(snapshot = {}) {
  if (!snapshot?.hash?.value || !snapshot?.gear?.recognized || !snapshot?.pets?.recognized) {
    throw new Error('Verified active loadout observation was not found');
  }
  const normalized = clone(snapshot);
  delete normalized.accountName;
  delete normalized.meta;
  return normalized;
}

function normalizeSavedSetObservation({ kind, context, parsed } = {}) {
  const normalizedKind = requireKind(kind);
  const normalizedContext = requireContext(context);
  if (!parsed?.recognized || parsed.context !== normalizedContext) {
    throw new Error('Verified saved Quick Set observation was not found');
  }
  const setNumber = requireSetNumber(parsed.quickSetNumber);
  const items = clone(Array.isArray(parsed.equipped) ? parsed.equipped : []);
  return {
    kind: normalizedKind,
    context: normalizedContext,
    quickSetNumber: setNumber,
    items,
    totals: items.reduce((totals, item) => ({
      attack: totals.attack + (Number(item.attack) || 0),
      defense: totals.defense + (Number(item.defense) || 0),
    }), { attack: 0, defense: 0 }),
    warnings: clone(Array.isArray(parsed.warnings) ? parsed.warnings : []),
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Loadout read cancelled');
  error.name = 'AbortError';
  error.code = 'READ_ABORTED';
  throw error;
}

class LoadoutService {
  constructor(gameAPI, accountName = null, options = {}) {
    this.gameAPI = gameAPI;
    this.accountName = accountName;
    this.cacheMaxAgeMs = Number.isFinite(options.cacheMaxAgeMs) ? Math.max(0, options.cacheMaxAgeMs) : 30000;
    this.now = options.now || (() => Date.now());
    this.readCoordinator = options.readCoordinator || null;
    this.mode = options.mode || 'shared';
    if (!['shared', 'legacy'].includes(this.mode)) throw new Error(`Unsupported loadout mode: ${this.mode}`);
    if (this.mode === 'shared' && !this.readCoordinator) throw new TypeError('Shared loadouts require ReadCoordinator');
    this.accountKey = this.mode === 'shared' ? assertAccountKey(options.accountKey) : null;
    this.latest = new Map();
    this.snapshots = new Map();
    this.inFlight = new Map();
    this.activeResourceKeys = new Set();
    this.sourceRevision = 0;
  }

  getCollector() {
    return this;
  }

  setGameAPI(gameAPI, accountName = this.accountName) {
    this.gameAPI = gameAPI;
    this.accountName = accountName;
    this.invalidateActive('Game session changed');
    this.latest.clear();
    this.inFlight.clear();
    this.snapshots.clear();
  }

  async collect(request = {}) {
    assertAccountScope(this.accountKey, request.accountKey);
    const resource = parseLoadoutResourceKey(request.resourceKey);
    const observedAt = Number(this.now());
    const sourceRevision = ++this.sourceRevision;
    throwIfAborted(request.signal);
    let observation;
    let source;
    if (resource.type === ACTIVE_LOADOUT_PREFIX) {
      observation = await this._fetchActiveLoadout(resource.gearContext, resource.petContext, observedAt);
      source = `GET inventory.php?set=${resource.gearContext} + pets.php?team=${resource.petContext}`;
    } else {
      observation = await this._fetchSavedSet(resource.kind, resource.setNumber, resource.context);
      source = resource.kind === 'gear'
        ? `GET inventory.php?set=${resource.context}&qset=${resource.setNumber}`
        : `GET pets.php?team=${resource.context}&qset=${resource.setNumber}`;
    }
    throwIfAborted(request.signal);
    return createCollectorResult({
      accountKey: this.accountKey,
      domain: WorldDomain.LOADOUT,
      resourceKey: request.resourceKey,
      observation,
      observedAt,
      sourceRevision,
      source,
    });
  }

  async getActiveLoadout({
    gearContext = 'attack',
    petContext = 'attack',
    force = false,
    priority = ReadPriority.COMBAT,
    signal = null,
  } = {}) {
    requireContext(gearContext);
    requireContext(petContext);
    if (!this.gameAPI) throw new Error('Game session not active');
    const resourceKey = activeLoadoutResourceKey(gearContext, petContext);
    this.activeResourceKeys.add(resourceKey);
    if (this.mode === 'shared') {
      const observation = await this._sharedRead(resourceKey, {
        force,
        priority,
        maxAgeMs: force ? 0 : this.cacheMaxAgeMs,
        signal,
      });
      const snapshot = { ...observation, accountName: this.accountName };
      this._rememberSnapshot(snapshot);
      return clone(snapshot);
    }
    return this._legacyActiveLoadout(gearContext, petContext, force);
  }

  getSnapshot(hash) {
    const snapshot = this.snapshots.get(String(hash || ''));
    return snapshot ? clone(snapshot) : null;
  }

  invalidateActive(reason = 'Active loadout invalidated') {
    this.latest.clear();
    this.inFlight.clear();
    if (this.mode !== 'shared') return true;
    let changed = false;
    for (const resourceKey of this.activeResourceKeys) {
      changed = this.readCoordinator.invalidate(
        this.accountKey,
        WorldDomain.LOADOUT,
        resourceKey,
        reason,
      ) || changed;
    }
    return changed;
  }

  async isSavedSetActive({ kind, setNumber, context = 'attack', signal = null } = {}) {
    const [saved, active] = await Promise.all([
      this.getSavedSet({
        kind,
        setNumber,
        context,
        priority: ReadPriority.MUTATION_REVALIDATION,
        signal,
      }),
      this.getActiveLoadout({
        gearContext: context,
        petContext: context,
        force: true,
        priority: ReadPriority.MUTATION_REVALIDATION,
        signal,
      }),
    ]);
    const activeItems = kind === 'gear' ? active.gear.equipped : active.pets.equipped;
    const signature = items => (Array.isArray(items) ? items : [])
      .map(item => ({
        name: String(item.name || '').trim().toLowerCase(),
        attack: Number(item.attack) || 0,
        defense: Number(item.defense) || 0,
        ability: String(item.ability || item.effect || item.rawEffect || '').trim(),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify(signature(saved.items)) === JSON.stringify(signature(activeItems));
  }

  async getSavedSet({
    kind,
    setNumber,
    context = 'attack',
    force = false,
    priority = ReadPriority.VISIBLE_UI,
    signal = null,
  } = {}) {
    const normalizedKind = requireKind(kind);
    const normalizedContext = requireContext(context);
    const normalizedSet = requireSetNumber(setNumber);
    if (!this.gameAPI) throw new Error('Game session not active');
    if (this.mode === 'shared') {
      return this._sharedRead(savedLoadoutResourceKey(normalizedKind, normalizedContext, normalizedSet), {
        force,
        priority,
        maxAgeMs: 0,
        signal,
      });
    }
    return clone(await this._fetchSavedSet(normalizedKind, normalizedSet, normalizedContext));
  }

  async _sharedRead(resourceKey, { force, priority, maxAgeMs, signal }) {
    try {
      const snapshot = await this.readCoordinator.read({
        accountKey: this.accountKey,
        domain: WorldDomain.LOADOUT,
        resourceKey,
        priority,
        maxAgeMs,
        force,
        signal,
      });
      const observation = clone(snapshot?.value);
      if (observation && typeof observation === 'object') delete observation.meta;
      return observation;
    } catch (error) {
      if (error?.code !== 'READ_ABORTED' && error?.name !== 'AbortError') {
        this.readCoordinator.invalidate(this.accountKey, WorldDomain.LOADOUT, resourceKey, 'Loadout refresh failed');
      }
      throw error;
    }
  }

  async _legacyActiveLoadout(gearContext, petContext, force) {
    const cacheKey = `${gearContext}:${petContext}`;
    const cached = this.latest.get(cacheKey);
    if (!force && cached && this.now() - cached.readAt <= this.cacheMaxAgeMs) return clone(cached.snapshot);
    if (this.inFlight.has(cacheKey)) return clone(await this.inFlight.get(cacheKey));

    const request = this._fetchActiveLoadout(gearContext, petContext, Number(this.now()))
      .then(observation => ({ ...observation, accountName: this.accountName }));
    this.inFlight.set(cacheKey, request);
    try {
      const snapshot = await request;
      this.latest.set(cacheKey, { readAt: this.now(), snapshot });
      this._rememberSnapshot(snapshot);
      return clone(snapshot);
    } finally {
      if (this.inFlight.get(cacheKey) === request) this.inFlight.delete(cacheKey);
    }
  }

  async _fetchActiveLoadout(gearContext, petContext, observedAt) {
    const [gear, pets] = await Promise.all([
      this.gameAPI.getGearInventory(gearContext),
      this.gameAPI.getPetInventory(petContext),
    ]);
    const snapshot = buildLoadoutSnapshot({
      gear,
      pets,
      accountName: null,
      observedAt: new Date(observedAt).toISOString(),
    });
    return normalizeActiveLoadoutObservation(snapshot);
  }

  async _fetchSavedSet(kind, setNumber, context) {
    const parsed = kind === 'gear'
      ? await this.gameAPI.getGearInventory(context, setNumber)
      : await this.gameAPI.getPetInventory(context, setNumber);
    return normalizeSavedSetObservation({ kind, context, parsed });
  }

  _rememberSnapshot(snapshot) {
    const hash = String(snapshot?.hash?.value || '');
    if (!hash) return;
    this.snapshots.set(hash, clone(snapshot));
    while (this.snapshots.size > 50) this.snapshots.delete(this.snapshots.keys().next().value);
  }
}

module.exports = {
  ACTIVE_LOADOUT_PREFIX,
  LOADOUT_CONTEXTS,
  LOADOUT_KINDS,
  LoadoutService,
  SAVED_LOADOUT_PREFIX,
  activeLoadoutResourceKey,
  normalizeActiveLoadoutObservation,
  normalizeSavedSetObservation,
  parseLoadoutResourceKey,
  savedLoadoutResourceKey,
};
