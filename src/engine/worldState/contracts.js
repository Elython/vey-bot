const { assertAccountKey, assertAccountScope } = require('./identity');
const { FreshnessState, finiteTimestamp, normalizeFreshness } = require('./freshnessPolicy');

const WORLD_STATE_SCHEMA_VERSION = 1;

const AreaType = Object.freeze({
  GATE: 'gate',
  EVENT: 'event',
  DUNGEON: 'dungeon',
  CUBE: 'cube',
});

const AreaInstanceState = Object.freeze({
  ACTIVE: 'active',
  CLEARED: 'cleared',
  FAILED: 'failed',
  CLOSED: 'closed',
  SEALED: 'sealed',
  UNKNOWN: 'unknown',
});

const WorldDomain = Object.freeze({
  STATS: 'stats',
  AREA_DEFINITIONS: 'areaDefinitions',
  AREA_INSTANCES: 'areaInstances',
  MONSTER_TYPES: 'monsterTypes',
  MONSTER_INSTANCES: 'monsterInstances',
  LOOT_CANDIDATES: 'lootCandidates',
  BATTLE_PASS: 'battlePass',
  ADVENTURE_QUESTS: 'adventureQuests',
  AUTO_FARM: 'autoFarm',
  CUBE: 'cube',
  LOADOUT: 'loadout',
});

const ReadPriority = Object.freeze({
  MUTATION_REVALIDATION: 'mutation_revalidation',
  COMBAT: 'combat',
  ACTIVE_MODULE: 'active_module',
  VISIBLE_UI: 'visible_ui',
  BACKGROUND: 'background',
});

const VALID_AREA_TYPES = new Set(Object.values(AreaType));
const VALID_AREA_STATES = new Set(Object.values(AreaInstanceState));
const VALID_DOMAINS = new Set(Object.values(WorldDomain));
const VALID_READ_PRIORITIES = new Set(Object.values(ReadPriority));
const SINGLETON_DOMAINS = new Set([
  WorldDomain.STATS,
  WorldDomain.BATTLE_PASS,
  WorldDomain.AUTO_FARM,
]);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function createObservationMeta({
  accountKey,
  observedAt,
  source,
  freshness = FreshnessState.FRESH,
  staleAt = null,
  sourceRevision = 0,
} = {}) {
  const observed = finiteTimestamp(observedAt);
  if (observed === null) throw new Error('Observation timestamp is required');
  const stale = finiteTimestamp(staleAt);
  if (stale !== null && stale < observed) throw new Error('Observation staleAt cannot be earlier than observedAt');
  return {
    accountKey: assertAccountKey(accountKey),
    observedAt: observed,
    source: requiredText(source, 'Observation source'),
    freshness: normalizeFreshness(freshness, FreshnessState.UNKNOWN),
    staleAt: stale,
    sourceRevision: Math.max(0, Math.trunc(Number(sourceRevision) || 0)),
  };
}

function normalizeStatsObservation(value = {}, meta) {
  return {
    level: finiteOrNull(value.level),
    xp: finiteOrNull(value.xp),
    requiredXp: finiteOrNull(value.requiredXp),
    stamina: finiteOrNull(value.stamina),
    maxStamina: finiteOrNull(value.maxStamina),
    hp: finiteOrNull(value.hp),
    maxHp: finiteOrNull(value.maxHp),
    mana: finiteOrNull(value.mana),
    maxMana: finiteOrNull(value.maxMana),
    attack: finiteOrNull(value.attack),
    defense: finiteOrNull(value.defense),
    gold: value.gold ?? null,
    gems: value.gems ?? null,
    potionCounts: value.potionCounts && typeof value.potionCounts === 'object' ? clone(value.potionCounts) : null,
    lootXpBoost: value.lootXpBoost && typeof value.lootXpBoost === 'object' ? clone(value.lootXpBoost) : null,
    meta: createObservationMeta(meta),
  };
}

function normalizeAreaDefinition(value = {}, meta) {
  const type = String(value.type || '').toLowerCase();
  if (!VALID_AREA_TYPES.has(type)) throw new Error(`Unsupported area type: ${type || 'missing'}`);
  return {
    areaKey: requiredText(value.areaKey || value.key, 'Area key'),
    type,
    displayName: requiredText(value.displayName || value.label, 'Area display name'),
    route: value.route ? String(value.route) : null,
    hidden: value.hidden === true,
    deleted: value.deleted === true,
    capabilities: {
      target: value.capabilities?.target === true,
      loot: value.capabilities?.loot === true,
      progression: value.capabilities?.progression === true,
      autoFarm: value.capabilities?.autoFarm === true,
      cubePvp: value.capabilities?.cubePvp === true,
    },
    meta: createObservationMeta(meta),
  };
}

function normalizeAreaInstance(value = {}, meta) {
  const state = VALID_AREA_STATES.has(value.state) ? value.state : AreaInstanceState.UNKNOWN;
  return {
    areaInstanceKey: requiredText(value.areaInstanceKey, 'Area instance key'),
    areaKey: requiredText(value.areaKey, 'Area key'),
    instanceId: value.instanceId === null || value.instanceId === undefined ? null : String(value.instanceId),
    state,
    attackable: value.attackable === true,
    lootDiscoverable: value.lootDiscoverable === true,
    openedAt: finiteTimestamp(value.openedAt),
    endedAt: finiteTimestamp(value.endedAt),
    meta: createObservationMeta(meta),
  };
}

function normalizeMonsterTypeObservation(value = {}, meta) {
  const scope = value.scope && typeof value.scope === 'object' ? clone(value.scope) : { kind: 'global' };
  return {
    monsterTypeKey: requiredText(value.monsterTypeKey, 'Monster type key'),
    areaKey: requiredText(value.areaKey, 'Area key'),
    displayName: requiredText(value.displayName || value.name, 'Monster display name'),
    normalizedName: requiredText(value.normalizedName, 'Normalized monster name'),
    boss: value.boss === true,
    bossEvidence: value.bossEvidence ? String(value.bossEvidence) : null,
    autoFarmTypeId: value.autoFarmTypeId === null || value.autoFarmTypeId === undefined
      ? null
      : String(value.autoFarmTypeId),
    stats: value.stats && typeof value.stats === 'object' ? clone(value.stats) : null,
    rewards: Array.isArray(value.rewards) ? clone(value.rewards) : [],
    scope,
    meta: createObservationMeta(meta),
  };
}

function normalizeMonsterInstanceObservation(value = {}, meta) {
  return {
    monsterInstanceKey: requiredText(value.monsterInstanceKey, 'Monster instance key'),
    areaInstanceKey: requiredText(value.areaInstanceKey, 'Area instance key'),
    monsterTypeKey: requiredText(value.monsterTypeKey, 'Monster type key'),
    battleRef: value.battleRef && typeof value.battleRef === 'object'
      ? clone(value.battleRef)
      : (value.battleRef == null ? null : String(value.battleRef)),
    hp: finiteOrNull(value.hp),
    maxHp: finiteOrNull(value.maxHp),
    alive: booleanOrNull(value.alive),
    attackable: value.attackable === true,
    joinable: value.joinable === true,
    lootable: value.lootable === true,
    alreadyLooted: value.alreadyLooted === true,
    userDamage: finiteOrNull(value.userDamage),
    stackSize: Math.max(1, Math.trunc(Number(value.stackSize) || 1)),
    meta: createObservationMeta(meta),
  };
}

function normalizeLootCandidateObservation(value = {}, meta) {
  return {
    candidateKey: requiredText(value.candidateKey, 'Loot candidate key'),
    monsterInstanceKey: requiredText(value.monsterInstanceKey, 'Monster instance key'),
    areaKey: requiredText(value.areaKey, 'Area key'),
    areaInstanceKey: requiredText(value.areaInstanceKey, 'Area instance key'),
    monsterTypeKey: requiredText(value.monsterTypeKey, 'Monster type key'),
    displayName: requiredText(value.displayName || value.name, 'Monster display name'),
    userDamage: finiteOrNull(value.userDamage),
    expPerDamage: finiteOrNull(value.expPerDamage),
    baseXp: finiteOrNull(value.baseXp),
    stackSize: Math.max(1, Math.trunc(Number(value.stackSize) || 1)),
    eligible: value.eligible === true,
    verified: value.verified === true,
    semanticHash: value.semanticHash ? String(value.semanticHash) : null,
    meta: createObservationMeta(meta),
  };
}

function createReadDiagnostics() {
  return {
    requestsStarted: 0,
    requestsCompleted: 0,
    requestsFailed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    staleServed: 0,
    coalescedWaiters: 0,
    activeReads: 0,
    queuedReads: 0,
    droppedStaleObservations: 0,
    byDomain: {},
  };
}

function createEmptyWorldSnapshot(accountKey, displayName = '') {
  return {
    schemaVersion: WORLD_STATE_SCHEMA_VERSION,
    account: { accountKey: assertAccountKey(accountKey), displayName: String(displayName || '') },
    revision: 0,
    stats: null,
    areas: { definitions: {}, instances: {}, monsterTypes: {}, monsterInstances: {} },
    lootCandidates: {},
    objectives: { battlePass: null, adventureQuests: {} },
    autoFarm: null,
    cube: {},
    loadout: {},
    diagnostics: createReadDiagnostics(),
    observationIndex: {},
  };
}

function createWorldPatch(input = {}) {
  const {
    accountKey,
    domain,
    resourceKey = 'current',
    operation = 'replace',
    value = null,
    meta: suppliedMeta = null,
    ...meta
  } = input;
  if (!VALID_DOMAINS.has(domain)) throw new Error(`Unsupported world-state domain: ${domain || 'missing'}`);
  if (!['replace', 'remove', 'merge'].includes(operation)) throw new Error(`Unsupported world-state operation: ${operation}`);
  if (operation === 'merge' && (domain !== WorldDomain.STATS || resourceKey !== 'current')) {
    throw new Error('World-state merge is restricted to stats/current');
  }
  if (operation !== 'remove' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(operation === 'replace'
      ? 'World-state replacement value must be an object'
      : 'World-state merge value must be an object');
  }
  if (SINGLETON_DOMAINS.has(domain) && resourceKey !== 'current') {
    throw new Error(`${domain} is a singleton world-state domain`);
  }
  const normalizedAccountKey = assertAccountKey(accountKey);
  const normalizedMeta = suppliedMeta
    ? createObservationMeta(suppliedMeta)
    : createObservationMeta({ accountKey: normalizedAccountKey, ...meta });
  assertAccountScope(normalizedAccountKey, normalizedMeta.accountKey);
  return {
    accountKey: normalizedAccountKey,
    domain,
    resourceKey: requiredText(resourceKey, 'World-state resource key'),
    operation,
    value: operation === 'remove' ? null : clone(value),
    meta: normalizedMeta,
  };
}

function compareObservationMeta(left = {}, right = {}) {
  const leftTime = Number(left.observedAt) || 0;
  const rightTime = Number(right.observedAt) || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return (Number(left.sourceRevision) || 0) - (Number(right.sourceRevision) || 0);
}

function applyStatsMerge(snapshot, patch, indexKey) {
  const previousStats = snapshot.stats && typeof snapshot.stats === 'object'
    ? snapshot.stats
    : {};
  const previousFieldMeta = previousStats.fieldMeta && typeof previousStats.fieldMeta === 'object'
    ? previousStats.fieldMeta
    : {};
  const acceptedFields = [];
  const nextValues = {};
  const nextFieldMeta = clone(previousFieldMeta);

  for (const [field, value] of Object.entries(patch.value || {})) {
    if (field === 'meta' || field === 'fieldMeta' || value === null || value === undefined) continue;
    const previousMeta = previousFieldMeta[field] || null;
    if (previousMeta && compareObservationMeta(patch.meta, previousMeta) <= 0) continue;
    nextValues[field] = clone(value);
    nextFieldMeta[field] = clone(patch.meta);
    acceptedFields.push(field);
  }

  if (acceptedFields.length === 0) {
    return { snapshot, applied: false, reason: 'stale_observation', acceptedFields: [] };
  }

  const next = clone(snapshot);
  const previousResourceMeta = snapshot.observationIndex[indexKey] || previousStats.meta || null;
  const resourceMeta = !previousResourceMeta || compareObservationMeta(patch.meta, previousResourceMeta) > 0
    ? clone(patch.meta)
    : clone(previousResourceMeta);
  next.stats = {
    ...clone(previousStats),
    ...nextValues,
    fieldMeta: nextFieldMeta,
    meta: resourceMeta,
  };
  next.revision = Math.max(0, Number(snapshot.revision) || 0) + 1;
  next.observationIndex[indexKey] = resourceMeta;
  return { snapshot: next, applied: true, reason: 'merge', acceptedFields };
}

function createCollectorRequest({ accountKey, resourceKey, previous = null, signal = null } = {}) {
  return {
    accountKey: assertAccountKey(accountKey),
    resourceKey: requiredText(resourceKey, 'Collector resource key'),
    previous: previous && typeof previous === 'object' ? clone(previous) : null,
    signal,
  };
}

function createCollectorResult({
  accountKey,
  domain,
  resourceKey,
  observation,
  operation = 'replace',
  observedAt,
  source,
  staleAt = null,
  sourceRevision = 0,
} = {}) {
  return createWorldPatch({
    accountKey,
    domain,
    resourceKey,
    operation,
    value: observation,
    observedAt,
    source,
    staleAt,
    sourceRevision,
  });
}

function createReadRequest({
  accountKey,
  domain,
  resourceKey,
  priority = ReadPriority.BACKGROUND,
  maxAgeMs = 0,
  force = false,
  signal = null,
} = {}) {
  if (!VALID_DOMAINS.has(domain)) throw new Error(`Unsupported world-state domain: ${domain || 'missing'}`);
  if (!VALID_READ_PRIORITIES.has(priority)) throw new Error(`Unsupported read priority: ${priority}`);
  const normalizedMaxAgeMs = Number(maxAgeMs);
  if (!Number.isFinite(normalizedMaxAgeMs) || normalizedMaxAgeMs < 0) {
    throw new Error('Read maxAgeMs must be a non-negative finite number');
  }
  if (typeof force !== 'boolean') throw new Error('Read force must be a boolean');
  if (signal !== null && (
    typeof signal !== 'object'
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function'
  )) throw new Error('Read signal must be an AbortSignal');
  return {
    accountKey: assertAccountKey(accountKey),
    domain,
    resourceKey: requiredText(resourceKey, 'Read resource key'),
    priority,
    maxAgeMs: normalizedMaxAgeMs,
    force,
    signal,
  };
}

function targetForDomain(snapshot, domain) {
  switch (domain) {
    case WorldDomain.AREA_DEFINITIONS: return snapshot.areas.definitions;
    case WorldDomain.AREA_INSTANCES: return snapshot.areas.instances;
    case WorldDomain.MONSTER_TYPES: return snapshot.areas.monsterTypes;
    case WorldDomain.MONSTER_INSTANCES: return snapshot.areas.monsterInstances;
    case WorldDomain.LOOT_CANDIDATES: return snapshot.lootCandidates;
    case WorldDomain.ADVENTURE_QUESTS: return snapshot.objectives.adventureQuests;
    case WorldDomain.CUBE: return snapshot.cube;
    case WorldDomain.LOADOUT: return snapshot.loadout;
    default: return null;
  }
}

function setSingleton(snapshot, domain, value) {
  if (domain === WorldDomain.STATS) snapshot.stats = value;
  else if (domain === WorldDomain.BATTLE_PASS) snapshot.objectives.battlePass = value;
  else if (domain === WorldDomain.AUTO_FARM) snapshot.autoFarm = value;
  else throw new Error(`Unsupported singleton domain: ${domain}`);
}

function applyWorldPatch(snapshot, rawPatch) {
  if (!snapshot || snapshot.schemaVersion !== WORLD_STATE_SCHEMA_VERSION) throw new Error('World snapshot is invalid');
  const patch = createWorldPatch(rawPatch);
  assertAccountScope(snapshot.account.accountKey, patch.accountKey);
  const indexKey = `${patch.domain}\u0000${patch.resourceKey}`;
  if (patch.operation === 'merge') return applyStatsMerge(snapshot, patch, indexKey);
  const previous = snapshot.observationIndex[indexKey] || null;
  if (previous) {
    const olderTime = patch.meta.observedAt < previous.observedAt;
    const duplicateOrOlderRevision = patch.meta.observedAt === previous.observedAt
      && patch.meta.sourceRevision <= previous.sourceRevision;
    if (olderTime || duplicateOrOlderRevision) {
      return { snapshot, applied: false, reason: 'stale_observation' };
    }
  }

  const next = clone(snapshot);
  const stored = patch.operation === 'remove' ? null : { ...clone(patch.value), meta: clone(patch.meta) };
  if (SINGLETON_DOMAINS.has(patch.domain)) {
    setSingleton(next, patch.domain, stored);
  } else {
    const target = targetForDomain(next, patch.domain);
    if (!target) throw new Error(`World-state domain is not mapped: ${patch.domain}`);
    if (patch.operation === 'remove') delete target[patch.resourceKey];
    else target[patch.resourceKey] = stored;
  }
  next.revision = Math.max(0, Number(snapshot.revision) || 0) + 1;
  next.observationIndex[indexKey] = { ...clone(patch.meta), removed: patch.operation === 'remove' };
  return { snapshot: next, applied: true, reason: patch.operation };
}

function recordReadDiagnostic(diagnostics, event = {}) {
  const next = clone(diagnostics || createReadDiagnostics());
  const type = String(event.type || '');
  const fieldByType = {
    started: 'requestsStarted',
    completed: 'requestsCompleted',
    failed: 'requestsFailed',
    cache_hit: 'cacheHits',
    cache_miss: 'cacheMisses',
    stale_served: 'staleServed',
    coalesced_waiter: 'coalescedWaiters',
    dropped_stale: 'droppedStaleObservations',
  };
  const field = fieldByType[type];
  if (field) next[field] = Math.max(0, Number(next[field]) || 0) + 1;
  if (Number.isFinite(Number(event.activeReads))) next.activeReads = Math.max(0, Number(event.activeReads));
  if (Number.isFinite(Number(event.queuedReads))) next.queuedReads = Math.max(0, Number(event.queuedReads));
  const domain = event.domain ? String(event.domain) : null;
  if (domain) {
    next.byDomain[domain] ||= { started: 0, completed: 0, failed: 0, durationMs: 0 };
    if (['started', 'completed', 'failed'].includes(type)) next.byDomain[domain][type] += 1;
    if (Number.isFinite(Number(event.durationMs))) next.byDomain[domain].durationMs += Math.max(0, Number(event.durationMs));
  }
  return next;
}

module.exports = {
  AreaInstanceState,
  AreaType,
  ReadPriority,
  SINGLETON_DOMAINS,
  WORLD_STATE_SCHEMA_VERSION,
  WorldDomain,
  applyWorldPatch,
  createEmptyWorldSnapshot,
  createCollectorRequest,
  createCollectorResult,
  createObservationMeta,
  createReadDiagnostics,
  createReadRequest,
  createWorldPatch,
  normalizeAreaDefinition,
  normalizeAreaInstance,
  normalizeLootCandidateObservation,
  normalizeMonsterInstanceObservation,
  normalizeMonsterTypeObservation,
  normalizeStatsObservation,
  recordReadDiagnostic,
};
