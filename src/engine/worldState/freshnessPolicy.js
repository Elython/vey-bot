const FreshnessState = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  REFRESHING: 'refreshing',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

const ResourceTemperature = Object.freeze({
  HOT: 'hot',
  WARM: 'warm',
  COLD: 'cold',
});

const VALID_FRESHNESS = new Set(Object.values(FreshnessState));

function finiteTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)
    ? Date.parse(value)
    : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeFreshness(value, fallback = FreshnessState.UNKNOWN) {
  return VALID_FRESHNESS.has(value) ? value : fallback;
}

function classifyFreshness(meta = {}, { now = Date.now() } = {}) {
  const explicit = normalizeFreshness(meta.freshness);
  if ([FreshnessState.REFRESHING, FreshnessState.UNAVAILABLE].includes(explicit)) return explicit;
  const observedAt = finiteTimestamp(meta.observedAt);
  if (observedAt === null) return FreshnessState.UNKNOWN;
  const staleAt = finiteTimestamp(meta.staleAt);
  if (staleAt !== null && Number(now) >= staleAt) return FreshnessState.STALE;
  return explicit === FreshnessState.STALE ? FreshnessState.STALE : FreshnessState.FRESH;
}

function isFreshEnough(meta = {}, { now = Date.now(), maxAgeMs = null } = {}) {
  if (classifyFreshness(meta, { now }) !== FreshnessState.FRESH) return false;
  if (maxAgeMs === null || maxAgeMs === undefined) return true;
  const observedAt = finiteTimestamp(meta.observedAt);
  return observedAt !== null && Number(now) - observedAt <= Math.max(0, Number(maxAgeMs) || 0);
}

function resourceTemperature({ active = false, enabled = false, visible = false } = {}) {
  if (active) return ResourceTemperature.HOT;
  if (enabled || visible) return ResourceTemperature.WARM;
  return ResourceTemperature.COLD;
}

module.exports = {
  FreshnessState,
  ResourceTemperature,
  classifyFreshness,
  finiteTimestamp,
  isFreshEnough,
  normalizeFreshness,
  resourceTemperature,
};
