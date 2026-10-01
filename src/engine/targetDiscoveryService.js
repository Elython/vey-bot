const { getMonsterArea } = require('./monsterCatalog');
const {
  ReadPriority,
  WorldDomain,
  assertAccountKey,
  assertAccountScope,
  createCollectorResult,
} = require('./worldState');

const DEFAULT_UI_MAX_AGE_MS = 2_500;

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function readAbortedError() {
  const error = new Error('Target discovery cancelled');
  error.name = 'AbortError';
  error.code = 'READ_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw readAbortedError();
}

class TargetDiscoveryService {
  constructor({
    monsterCatalogService,
    areaDirectoryService = null,
    readCoordinator = null,
    accountKey,
    mode = 'shared',
    now = () => Date.now(),
    uiMaxAgeMs = DEFAULT_UI_MAX_AGE_MS,
  } = {}) {
    if (!monsterCatalogService || typeof monsterCatalogService.listArea !== 'function'
      || typeof monsterCatalogService.getLiveMonsters !== 'function') {
      throw new TypeError('TargetDiscoveryService requires MonsterCatalogService');
    }
    if (!['shared', 'legacy'].includes(mode)) throw new Error(`Unsupported Target discovery mode: ${mode}`);
    if (mode === 'shared' && (!readCoordinator || typeof readCoordinator.read !== 'function'
      || !areaDirectoryService || typeof areaDirectoryService.readDirectory !== 'function')) {
      throw new TypeError('Shared Target discovery requires ReadCoordinator and AreaDirectoryService');
    }
    this.monsterCatalogService = monsterCatalogService;
    this.areaDirectoryService = areaDirectoryService;
    this.readCoordinator = readCoordinator;
    this.accountKey = assertAccountKey(accountKey);
    this.mode = mode;
    this.now = now;
    this.uiMaxAgeMs = Math.max(0, Number(uiMaxAgeMs) || 0);
    this.sourceRevision = 0;
  }

  async _discover(areaKey, signal = null) {
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    throwIfAborted(signal);
    const directory = area.type === 'dungeon' && this.areaDirectoryService
      ? this.areaDirectoryService.peekDirectory()
      : null;
    if (area.type === 'dungeon' && this.areaDirectoryService && !directory) {
      throw new Error('Dungeon directory must be resolved before Target collection');
    }
    const noGuildAvailability = area.type === 'dungeon' && directory?.guildMember === false
      ? {
          state: 'unavailable',
          available: false,
          verified: true,
          reason: directory.reason || 'not_in_guild',
          source: 'guild_dungeon.php',
        }
      : null;
    const catalog = noGuildAvailability
      ? this.monsterCatalogService.unavailableArea(
        areaKey,
        noGuildAvailability,
        'Join a guild to access Dungeons.',
      )
      : await this.monsterCatalogService.listArea(areaKey, {
        directoryInstances: directory?.instances || null,
      });
    throwIfAborted(signal);
    return {
      catalog: clone(catalog),
      liveMonsters: clone(this.monsterCatalogService.getLiveMonsters(areaKey)),
    };
  }

  async collect(request = {}) {
    assertAccountScope(this.accountKey, request.accountKey);
    const observation = await this._discover(request.resourceKey, request.signal);
    return createCollectorResult({
      accountKey: this.accountKey,
      domain: WorldDomain.MONSTER_INSTANCES,
      resourceKey: request.resourceKey,
      observation,
      observedAt: Number(this.now()),
      sourceRevision: ++this.sourceRevision,
      source: `target_discovery:${getMonsterArea(request.resourceKey)?.type || 'unknown'}`,
    });
  }

  async readAreaSnapshot(areaKey, {
    priority = ReadPriority.VISIBLE_UI,
    maxAgeMs = this.uiMaxAgeMs,
    force = false,
    signal = null,
  } = {}) {
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    if (area.type === 'dungeon' && this.areaDirectoryService) {
      await this.areaDirectoryService.readDirectory({
        priority,
        maxAgeMs,
        force,
        signal,
      });
      throwIfAborted(signal);
    }
    if (this.mode === 'legacy') {
      return {
        value: await this._discover(areaKey, signal),
        meta: null,
        revision: null,
      };
    }
    return this.readCoordinator.read({
      accountKey: this.accountKey,
      domain: WorldDomain.MONSTER_INSTANCES,
      resourceKey: areaKey,
      priority,
      maxAgeMs,
      force,
      signal,
    });
  }

  async listArea(areaKey, options = {}) {
    const snapshot = await this.readAreaSnapshot(areaKey, {
      priority: ReadPriority.VISIBLE_UI,
      maxAgeMs: options.maxAgeMs ?? this.uiMaxAgeMs,
      force: options.force === true,
      signal: options.signal || null,
    });
    return clone(snapshot?.value?.catalog || null);
  }

  async listCombatMonsters(areaKey, options = {}) {
    const snapshot = await this.readAreaSnapshot(areaKey, {
      priority: ReadPriority.COMBAT,
      maxAgeMs: 0,
      force: options.force === true,
      signal: options.signal || null,
    });
    return clone(snapshot?.value?.liveMonsters || []);
  }

  peekArea(areaKey) {
    if (this.mode !== 'shared') return null;
    const snapshot = this.readCoordinator.peek(this.accountKey, WorldDomain.MONSTER_INSTANCES, areaKey);
    return snapshot ? clone(snapshot) : null;
  }

  invalidate(areaKey, reason = 'target discovery invalidated') {
    if (this.mode !== 'shared') return false;
    return this.readCoordinator.invalidate(this.accountKey, WorldDomain.MONSTER_INSTANCES, areaKey, reason);
  }
}

module.exports = {
  DEFAULT_UI_MAX_AGE_MS,
  TargetDiscoveryService,
  readAbortedError,
};
