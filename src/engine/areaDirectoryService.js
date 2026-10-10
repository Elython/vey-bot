const { getMonsterArea, listMonsterAreas } = require('./monsterCatalog');
const {
  AreaInstanceState,
  ReadPriority,
  WorldDomain,
  assertAccountKey,
  assertAccountScope,
  buildAreaInstanceKey,
  createCollectorResult,
} = require('./worldState');

const DIRECTORY_RESOURCE_KEY = 'dungeon_directory';
const DEFAULT_UI_MAX_AGE_MS = 2_500;
const DEFAULT_BACKGROUND_MAX_AGE_MS = 60_000;
const GAME_ORIGIN = 'https://demonicscans.org';

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function directoryProjection(value) {
  if (!value) return null;
  const { meta: _meta, ...directory } = value;
  return clone(directory);
}

function readAbortedError() {
  const error = new Error('Area directory read cancelled');
  error.name = 'AbortError';
  error.code = 'READ_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw readAbortedError();
}

function normalizedName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameOriginRelativeUrl(value) {
  try {
    const parsed = new URL(String(value || ''), GAME_ORIGIN);
    if (parsed.origin !== GAME_ORIGIN) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function directoryAreaIndex() {
  const byName = new Map();
  for (const area of listMonsterAreas({ includeHidden: true }).filter(entry => entry.type === 'dungeon')) {
    const key = normalizedName(area.label);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(area);
  }
  return byName;
}

function normalizeDirectoryState(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'active') return AreaInstanceState.ACTIVE;
  if (value === 'ended' || value === 'cleared') return AreaInstanceState.CLEARED;
  if (value === 'failed') return AreaInstanceState.FAILED;
  return AreaInstanceState.UNKNOWN;
}

function normalizeDirectoryObservation(instances = [], metadata = {}) {
  const knownAreas = directoryAreaIndex();
  const normalized = [];
  const unmapped = [];
  const byArea = {};
  const seenInstances = new Set();

  for (const raw of Array.isArray(instances) ? instances : []) {
    const instanceId = /^\d+$/.test(String(raw?.instanceId || '')) ? String(raw.instanceId) : null;
    const name = String(raw?.name || '').trim().replace(/\s+/g, ' ');
    const url = sameOriginRelativeUrl(raw?.url);
    const matches = knownAreas.get(normalizedName(name)) || [];
    if (!instanceId || !name || !url || matches.length !== 1 || seenInstances.has(instanceId)) {
      unmapped.push({
        name,
        instanceId,
        status: String(raw?.status || '').toLowerCase() || 'unknown',
        reason: seenInstances.has(instanceId)
          ? 'duplicate_instance'
          : matches.length > 1
            ? 'ambiguous_area'
            : matches.length === 0
              ? 'unknown_area'
              : !instanceId
                ? 'invalid_instance_id'
                : 'invalid_url',
      });
      continue;
    }
    seenInstances.add(instanceId);
    const area = matches[0];
    const state = normalizeDirectoryState(raw.status);
    const guildLootState = ['pending', 'claimed', 'none', 'unknown'].includes(raw.guildLootState)
      ? raw.guildLootState
      : 'unknown';
    const active = state === AreaInstanceState.ACTIVE;
    const lootDiscoverable = active
      || state === AreaInstanceState.CLEARED
      || state === AreaInstanceState.FAILED;
    const entry = {
      areaInstanceKey: buildAreaInstanceKey({ areaKey: area.key, instanceId }),
      areaKey: area.key,
      name,
      instanceId,
      url,
      state,
      status: state === AreaInstanceState.CLEARED ? 'ended' : state,
      active,
      attackable: active,
      lootDiscoverable,
      guildLootState,
    };
    normalized.push(entry);
    byArea[area.key] ||= [];
    byArea[area.key].push(clone(entry));
  }

  return {
    recognized: true,
    guildMember: metadata.guildMember !== false,
    reason: metadata.guildMember === false ? String(metadata.reason || 'not_in_guild') : null,
    instances: normalized,
    byArea,
    unmapped,
  };
}

class AreaDirectoryService {
  constructor({
    gameAPI,
    readCoordinator = null,
    accountKey,
    mode = 'shared',
    now = () => Date.now(),
    uiMaxAgeMs = DEFAULT_UI_MAX_AGE_MS,
    backgroundMaxAgeMs = DEFAULT_BACKGROUND_MAX_AGE_MS,
  } = {}) {
    if (!gameAPI || (typeof gameAPI.getDungeonDirectory !== 'function'
      && typeof gameAPI.getDungeonInstances !== 'function')) {
      throw new TypeError('AreaDirectoryService requires GameAPI dungeon discovery');
    }
    if (mode !== 'shared') throw new Error(`Unsupported area-directory mode: ${mode}`);
    if (!readCoordinator || typeof readCoordinator.read !== 'function') {
      throw new TypeError('Shared area directory requires ReadCoordinator');
    }
    if (typeof gameAPI.getDungeonDirectory !== 'function') {
      throw new TypeError('Shared area directory requires GameAPI.getDungeonDirectory');
    }
    this.gameAPI = gameAPI;
    this.readCoordinator = readCoordinator;
    this.accountKey = assertAccountKey(accountKey);
    this.mode = mode;
    this.now = now;
    this.uiMaxAgeMs = Math.max(0, Number(uiMaxAgeMs) || 0);
    this.backgroundMaxAgeMs = Math.max(0, Number(backgroundMaxAgeMs) || 0);
    this.sourceRevision = 0;
  }

  async _discover(signal = null) {
    throwIfAborted(signal);
    const directory = await this.gameAPI.getDungeonDirectory();
    throwIfAborted(signal);
    return normalizeDirectoryObservation(directory.instances, directory);
  }

  async collect(request = {}) {
    assertAccountScope(this.accountKey, request.accountKey);
    if (request.resourceKey !== DIRECTORY_RESOURCE_KEY) throw new Error('Unknown area-directory resource');
    const observation = await this._discover(request.signal);
    return createCollectorResult({
      accountKey: this.accountKey,
      domain: WorldDomain.AREA_INSTANCES,
      resourceKey: DIRECTORY_RESOURCE_KEY,
      observation,
      observedAt: Number(this.now()),
      sourceRevision: ++this.sourceRevision,
      source: 'GET /guild_dungeon.php',
    });
  }

  async readDirectory({
    priority = ReadPriority.VISIBLE_UI,
    maxAgeMs = priority === ReadPriority.BACKGROUND ? this.backgroundMaxAgeMs : this.uiMaxAgeMs,
    force = false,
    signal = null,
  } = {}) {

    const snapshot = await this.readCoordinator.read({
      accountKey: this.accountKey,
      domain: WorldDomain.AREA_INSTANCES,
      resourceKey: DIRECTORY_RESOURCE_KEY,
      priority,
      maxAgeMs,
      force,
      signal,
    });
    return directoryProjection(snapshot?.value);
  }

  peekDirectory() {
    const snapshot = this.readCoordinator.peek(this.accountKey, WorldDomain.AREA_INSTANCES, DIRECTORY_RESOURCE_KEY);
    return directoryProjection(snapshot?.value);
  }

  listAreaInstances(areaKey, { includeRetained = false } = {}) {
    const area = getMonsterArea(areaKey);
    if (!area || area.type !== 'dungeon') return [];
    const entries = this.peekDirectory()?.byArea?.[areaKey] || [];
    return clone(entries.filter(entry => includeRetained ? entry.lootDiscoverable === true : entry.attackable === true));
  }

  invalidate(reason = 'area directory invalidated') {
    return this.readCoordinator.invalidate(
      this.accountKey,
      WorldDomain.AREA_INSTANCES,
      DIRECTORY_RESOURCE_KEY,
      reason,
    );
  }
}

module.exports = {
  AreaDirectoryService,
  DEFAULT_BACKGROUND_MAX_AGE_MS,
  DEFAULT_UI_MAX_AGE_MS,
  DIRECTORY_RESOURCE_KEY,
  normalizeDirectoryObservation,
  normalizeDirectoryState,
  readAbortedError,
};
