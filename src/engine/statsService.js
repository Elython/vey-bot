const { stateStore: defaultStateStore } = require('./stateStore');
const {
  ReadPriority,
  WorldDomain,
  assertAccountKey,
  assertAccountScope,
  createCollectorResult,
} = require('./worldState');

const STATS_RESOURCE_KEY = 'current';

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function finiteValue(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Stats read cancelled');
  error.name = 'AbortError';
  error.code = 'READ_ABORTED';
  throw error;
}

function canonicalStatsFromSources(raw = {}, resources = {}) {
  const observation = {};
  const numericFields = {
    level: raw.level,
    xp: raw.expCurrent,
    requiredXp: raw.expRequired,
    stamina: raw.stamina,
    maxStamina: raw.maxStamina,
    attack: raw.attack,
    defense: raw.defense,
    serverEpoch: raw.serverEpoch,
    serverTzOff: raw.serverTzOff,
    hp: resources.hp?.current,
    maxHp: resources.hp?.max,
    mana: resources.mp?.current,
    maxMana: resources.mp?.max,
  };
  for (const [key, value] of Object.entries(numericFields)) {
    const normalized = finiteValue(value);
    if (normalized !== undefined) observation[key] = normalized;
  }
  for (const key of ['gold', 'gems', 'username']) {
    if (raw[key] !== null && raw[key] !== undefined && raw[key] !== '') observation[key] = raw[key];
  }
  if (raw.lootXpBoost?.recognized === true) observation.lootXpBoost = clone(raw.lootXpBoost);
  if (raw.potionCounts && typeof raw.potionCounts === 'object') observation.potionCounts = clone(raw.potionCounts);
  return observation;
}

function canonicalStatsFromPartial(partial = {}) {
  const result = {};
  const directNumeric = [
    'level', 'xp', 'requiredXp', 'stamina', 'maxStamina', 'hp', 'maxHp', 'mana', 'maxMana',
    'attack', 'defense', 'serverEpoch', 'serverTzOff',
  ];
  for (const key of directNumeric) {
    if (!hasOwn(partial, key)) continue;
    const value = finiteValue(partial[key]);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ['gold', 'gems', 'username']) {
    if (hasOwn(partial, key) && partial[key] !== null && partial[key] !== undefined) result[key] = partial[key];
  }
  if (partial.stamina && typeof partial.stamina === 'object') {
    const current = finiteValue(partial.stamina.current);
    const maximum = finiteValue(partial.stamina.max);
    if (current !== undefined) result.stamina = current;
    if (maximum !== undefined) result.maxStamina = maximum;
  }
  if (partial.hp && typeof partial.hp === 'object') {
    const current = finiteValue(partial.hp.current);
    const maximum = finiteValue(partial.hp.max);
    if (current !== undefined) result.hp = current;
    if (maximum !== undefined) result.maxHp = maximum;
  }
  const manaPair = partial.mp && typeof partial.mp === 'object' ? partial.mp : null;
  if (manaPair) {
    const current = finiteValue(manaPair.current);
    const maximum = finiteValue(manaPair.max);
    if (current !== undefined) result.mana = current;
    if (maximum !== undefined) result.maxMana = maximum;
  }
  if (hasOwn(partial, 'expCurrent')) {
    const value = finiteValue(partial.expCurrent);
    if (value !== undefined) result.xp = value;
  }
  if (hasOwn(partial, 'expRequired')) {
    const value = finiteValue(partial.expRequired);
    if (value !== undefined) result.requiredXp = value;
  }
  if (partial.lootXpBoost && typeof partial.lootXpBoost === 'object') result.lootXpBoost = clone(partial.lootXpBoost);
  if (partial.potionCounts && typeof partial.potionCounts === 'object') result.potionCounts = clone(partial.potionCounts);
  return result;
}

function projectStatsToStateStore(stats = {}, store = defaultStateStore) {
  if (!stats || typeof stats !== 'object') return store.getState();
  const previous = store.getState();
  const updates = { isConnected: true };
  if (hasOwn(stats, 'stamina') || hasOwn(stats, 'maxStamina')) {
    updates.stamina = {
      current: hasOwn(stats, 'stamina') ? stats.stamina : previous.stamina.current,
      max: hasOwn(stats, 'maxStamina') ? stats.maxStamina : previous.stamina.max,
    };
  }
  if (hasOwn(stats, 'maxStamina')) updates.totalStamina = stats.maxStamina;
  if (hasOwn(stats, 'hp') || hasOwn(stats, 'maxHp')) {
    updates.hp = {
      current: hasOwn(stats, 'hp') ? stats.hp : previous.hp.current,
      max: hasOwn(stats, 'maxHp') ? stats.maxHp : previous.hp.max,
    };
  }
  if (hasOwn(stats, 'mana') || hasOwn(stats, 'maxMana')) {
    updates.mp = {
      current: hasOwn(stats, 'mana') ? stats.mana : previous.mp.current,
      max: hasOwn(stats, 'maxMana') ? stats.maxMana : previous.mp.max,
    };
  }
  for (const key of ['attack', 'defense', 'level', 'gold', 'gems', 'serverEpoch', 'serverTzOff', 'username', 'lootXpBoost']) {
    if (hasOwn(stats, key)) updates[key] = clone(stats[key]);
  }
  if (hasOwn(stats, 'xp')) updates.expCurrent = stats.xp;
  if (hasOwn(stats, 'requiredXp')) updates.expRequired = stats.requiredXp;
  if (hasOwn(stats, 'xp') || hasOwn(stats, 'requiredXp')) {
    const current = hasOwn(stats, 'xp') ? Number(stats.xp) : Number(previous.expCurrent);
    const required = hasOwn(stats, 'requiredXp') ? Number(stats.requiredXp) : Number(previous.expRequired);
    if (Number.isFinite(current) && Number.isFinite(required)) {
      updates.exp = `${current} / ${required}`;
      updates.expPercent = `${required > 0 ? Math.max(0, Math.min(100, Math.floor((current / required) * 100))) : 0}%`;
    }
  }
  store.update(updates);
  return store.getState();
}

class StatsService {
  constructor({
    gameAPI,
    readCoordinator = null,
    worldStateService = null,
    accountKey,
    accountName = null,
    stateStore = defaultStateStore,
    areaAccessService = null,
    mode = 'shared',
    now = () => Date.now(),
  } = {}) {
    if (!gameAPI || typeof gameAPI.fetchStats !== 'function' || typeof gameAPI.fetchDashboard !== 'function') {
      throw new TypeError('StatsService requires GameAPI Stats and Dashboard readers');
    }
    if (mode !== 'shared') throw new Error(`Unsupported Stats mode: ${mode}`);
    if (!readCoordinator || !worldStateService || !areaAccessService) {
      throw new TypeError('Shared Stats requires ReadCoordinator, WorldStateService, and AreaAccessService');
    }
    this.gameAPI = gameAPI;
    this.readCoordinator = readCoordinator;
    this.worldStateService = worldStateService;
    this.accountKey = assertAccountKey(accountKey);
    this.accountName = accountName;
    this.stateStore = stateStore;
    this.areaAccessService = areaAccessService;
    this.mode = mode;
    this.now = now;
    this.sourceRevision = 0;
    this.unsubscribe = worldStateService.subscribe(this.accountKey, event => {
        if (event.changes.some(change => change.domain === WorldDomain.STATS && change.operation !== 'invalidate')) {
          projectStatsToStateStore(event.snapshot.stats, this.stateStore);
        }
      }, { domains: [WorldDomain.STATS] });
  }

  async _readSources(signal = null) {
    const observedAt = Number(this.now());
    const sourceRevision = ++this.sourceRevision;
    throwIfAborted(signal);
    const resourcesRead = (async () => {
      const route = await this.areaAccessService.getPlayerResourceRoute();
      if (!route) return {};
      return this.gameAPI.fetchPlayerResources(route.gateId, route.wave);
    })();
    const [statsResult, dashboardResult, resourcesResult] = await Promise.allSettled([
      this.gameAPI.fetchStats(),
      this.gameAPI.fetchDashboard(),
      resourcesRead,
    ]);
    throwIfAborted(signal);
    if (statsResult.status === 'rejected' && dashboardResult.status === 'rejected') {
      const error = new Error(`${statsResult.reason?.message || 'stats failed'}; ${dashboardResult.reason?.message || 'dashboard failed'}`);
      error.causes = [statsResult.reason, dashboardResult.reason].filter(Boolean);
      throw error;
    }
    const raw = {
      ...(dashboardResult.status === 'fulfilled' ? dashboardResult.value : {}),
      ...(statsResult.status === 'fulfilled' ? statsResult.value : {}),
    };
    const resources = resourcesResult.status === 'fulfilled' ? resourcesResult.value : {};
    return { observedAt, sourceRevision, observation: canonicalStatsFromSources(raw, resources) };
  }

  async collect(request = {}) {
    assertAccountScope(this.accountKey, request.accountKey);
    if (request.resourceKey !== STATS_RESOURCE_KEY) throw new Error('Unknown Stats resource');
    const { observedAt, sourceRevision, observation } = await this._readSources(request.signal);
    return createCollectorResult({
      accountKey: this.accountKey,
      domain: WorldDomain.STATS,
      resourceKey: STATS_RESOURCE_KEY,
      operation: 'merge',
      observation,
      observedAt,
      sourceRevision,
      source: 'GET stats.php + game_dash.php + active_wave.php',
    });
  }

  async read({
    priority = ReadPriority.VISIBLE_UI,
    maxAgeMs = 0,
    force = false,
    signal = null,
  } = {}) {

    try {
      return await this.readCoordinator.read({
        accountKey: this.accountKey,
        domain: WorldDomain.STATS,
        resourceKey: STATS_RESOURCE_KEY,
        priority,
        maxAgeMs,
        force,
        signal,
      });
    } catch (error) {
      if (error?.code !== 'READ_ABORTED' && error?.name !== 'AbortError') {
        this.readCoordinator.invalidate(this.accountKey, WorldDomain.STATS, STATS_RESOURCE_KEY, 'Stats refresh failed');
      }
      throw error;
    }
  }

  observePartial(partial, {
    source = 'verified partial Stats observation',
    observedAt = this.now(),
    sourceRevision = null,
  } = {}) {
    const observation = canonicalStatsFromPartial(partial);
    if (Object.keys(observation).length === 0) return { applied: false, changes: [] };

    return this.worldStateService.applyPatch({
      accountKey: this.accountKey,
      domain: WorldDomain.STATS,
      resourceKey: STATS_RESOURCE_KEY,
      operation: 'merge',
      value: observation,
      observedAt: Number(observedAt),
      sourceRevision: sourceRevision == null ? ++this.sourceRevision : sourceRevision,
      source,
    });
  }

  observeResources(resources, options = {}) {
    return this.observePartial(resources, options);
  }

  peek() {
    return this.readCoordinator.peek(this.accountKey, WorldDomain.STATS, STATS_RESOURCE_KEY);
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

module.exports = {
  STATS_RESOURCE_KEY,
  StatsService,
  canonicalStatsFromPartial,
  canonicalStatsFromSources,
  projectStatsToStateStore,
};
