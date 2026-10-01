const crypto = require('crypto');

const ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;
const NUMERIC_ID_PATTERN = /^\d+$/;

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function encodeComponent(value, label) {
  return encodeURIComponent(requireText(value, label));
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function accountKeyFromUserId(userId) {
  const normalized = requireText(userId, 'Stable game user ID');
  if (!NUMERIC_ID_PATTERN.test(normalized)) throw new Error('Stable game user ID must be numeric');
  return stableHash(normalized);
}

function isAccountKey(value) {
  return ACCOUNT_KEY_PATTERN.test(String(value || ''));
}

function assertAccountKey(value) {
  if (!isAccountKey(value)) throw new Error('Account key must be a SHA-256 hash');
  return String(value);
}

function normalizeStableKey(value, label = 'Stable key') {
  const normalized = requireText(value, label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  if (!normalized) throw new Error(`${label} is invalid`);
  return normalized;
}

function canonicalRoute(route) {
  const raw = requireText(route, 'Route');
  const parsed = new URL(raw, 'https://demonicscans.org');
  if (parsed.origin !== 'https://demonicscans.org') throw new Error('Route must use the verified game origin');
  const entries = [...parsed.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
  const search = new URLSearchParams(entries).toString();
  return `${parsed.pathname}${search ? `?${search}` : ''}`;
}

function buildAreaInstanceKey({ areaKey, instanceId = null, route = null } = {}) {
  const area = encodeComponent(normalizeStableKey(areaKey, 'Area key'), 'Area key');
  if (instanceId !== null && instanceId !== undefined && String(instanceId).trim()) {
    return `${area}::instance:${encodeComponent(instanceId, 'Area instance ID')}`;
  }
  if (route) return `${area}::route:${stableHash(canonicalRoute(route))}`;
  throw new Error('Area instance identity requires a server instance ID or verified route');
}

function buildMonsterTypeKey({ areaKey, monsterKey = null, name = null } = {}) {
  const area = encodeComponent(normalizeStableKey(areaKey, 'Area key'), 'Area key');
  const type = normalizeStableKey(monsterKey || name, 'Monster type');
  return `${area}::type:${encodeComponent(type, 'Monster type')}`;
}

function buildMonsterInstanceKey({
  areaInstanceKey = null,
  areaKey = null,
  instanceId = null,
  route = null,
  dgmid = null,
  battleId = null,
} = {}) {
  const parent = areaInstanceKey || buildAreaInstanceKey({ areaKey, instanceId, route });
  if (dgmid !== null && dgmid !== undefined && String(dgmid).trim()) {
    return `${parent}::dgmid:${encodeComponent(dgmid, 'Dungeon monster ID')}`;
  }
  if (battleId !== null && battleId !== undefined && String(battleId).trim()) {
    return `${parent}::battle:${encodeComponent(battleId, 'Battle ID')}`;
  }
  throw new Error('Monster instance identity requires dgmid or battle ID');
}

function buildObjectiveKey({ kind, serverId = null, provisionalText = null } = {}) {
  const objectiveKind = encodeComponent(normalizeStableKey(kind, 'Objective kind'), 'Objective kind');
  if (serverId !== null && serverId !== undefined && String(serverId).trim()) {
    return `${objectiveKind}::id:${encodeComponent(serverId, 'Objective ID')}`;
  }
  const provisional = requireText(provisionalText, 'Provisional objective text')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return `${objectiveKind}::provisional:${stableHash(provisional)}`;
}

function buildMonsterFactVariantKey({ monsterTypeKey, scope = {} } = {}) {
  const typeKey = requireText(monsterTypeKey, 'Monster type key');
  const kind = normalizeStableKey(scope.kind || 'global', 'Monster fact scope');
  if (kind === 'global') return `${typeKey}::scope:global`;
  if (kind === 'account') {
    return `${typeKey}::scope:account:${assertAccountKey(scope.accountKey)}`;
  }
  if (kind === 'level') {
    const level = Math.max(0, Math.trunc(Number(scope.level)));
    if (!Number.isFinite(level)) throw new Error('Monster fact level is invalid');
    const account = scope.accountKey ? `:${assertAccountKey(scope.accountKey)}` : '';
    return `${typeKey}::scope:level:${level}${account}`;
  }
  if (kind === 'event') {
    const eventKey = encodeComponent(normalizeStableKey(scope.eventKey, 'Event key'), 'Event key');
    let level = '';
    if (scope.level !== null && scope.level !== undefined) {
      const normalizedLevel = Math.max(0, Math.trunc(Number(scope.level)));
      if (!Number.isFinite(normalizedLevel)) throw new Error('Monster fact level is invalid');
      level = `:level:${normalizedLevel}`;
    }
    return `${typeKey}::scope:event:${eventKey}${level}`;
  }
  throw new Error(`Unsupported monster fact scope: ${kind}`);
}

function buildResourceKey({ accountKey, domain, resourceKey } = {}) {
  return `${assertAccountKey(accountKey)}::${encodeComponent(domain, 'Domain')}::${encodeComponent(resourceKey, 'Resource key')}`;
}

function assertAccountScope(expectedAccountKey, actualAccountKey) {
  const expected = assertAccountKey(expectedAccountKey);
  const actual = assertAccountKey(actualAccountKey);
  if (expected !== actual) throw new Error('Cross-account world-state operation rejected');
  return true;
}

module.exports = {
  ACCOUNT_KEY_PATTERN,
  accountKeyFromUserId,
  assertAccountKey,
  assertAccountScope,
  buildAreaInstanceKey,
  buildMonsterFactVariantKey,
  buildMonsterInstanceKey,
  buildMonsterTypeKey,
  buildObjectiveKey,
  buildResourceKey,
  canonicalRoute,
  isAccountKey,
  normalizeStableKey,
  stableHash,
};
