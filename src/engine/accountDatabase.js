const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDataPath } = require('../dataDirectory');
const {
  assertAccountKey,
  buildMonsterFactVariantKey,
  buildMonsterTypeKey,
  isAccountKey,
} = require('./worldState/identity');

const ACCOUNT_DATABASE_SCHEMA_VERSION = 2;
const ACTIVITY_KINDS = new Set(['target', 'loot']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function accountKey(accountName) {
  return crypto.createHash('sha256').update(String(accountName || '')).digest('hex');
}

function monsterTypeKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = finiteOrNull(value);
  return number === null ? 0 : Math.max(0, number);
}

function emptyAccount() {
  return {
    config: null,
    monsterKnowledge: { types: {}, facts: {} },
    autoFarmTypes: {},
    activities: { target: [], loot: [] },
    aggregates: { target: {}, loot: {} },
    events: [],
    items: {},
    lootSnapshots: {},
  };
}

function emptyDatabase() {
  return {
    schemaVersion: ACCOUNT_DATABASE_SCHEMA_VERSION,
    migrations: {},
    accountAliases: {},
    recoveryAccounts: {},
    accounts: {},
  };
}

function activityAggregateKey(entry) {
  return `${String(entry.areaKey || '')}\u0000${String(entry.monsterKey || entry.monsterName || '')}`;
}

function normalizedItem(item = {}) {
  const itemId = String(item.ITEM_ID ?? item.itemId ?? item.id ?? '').slice(0, 40);
  const name = String(item.NAME ?? item.name ?? 'Unknown item').trim().slice(0, 200);
  return {
    itemId: /^\d{1,40}$/.test(itemId) ? itemId : null,
    name,
    nameKey: monsterTypeKey(name),
    tier: String(item.TIER ?? item.tier ?? '').slice(0, 40),
    quantity: Math.max(1, Math.trunc(Number(item.QUANTITY ?? item.quantity) || 1)),
  };
}

function normalizedMonsterType(area = {}, monster = {}, observedAt = new Date().toISOString()) {
  const name = String(monster?.name || monster?.canonicalName || '').trim().slice(0, 200);
  const monsterKey = monsterTypeKey(monster?.key || monster?.monsterKey || name);
  if (!area?.key || !name || !monsterKey) return null;
  return {
    areaKey: String(area.key).slice(0, 120),
    areaType: String(area.type || monster.areaType || '').slice(0, 24),
    areaName: String(area.label || monster.areaName || area.key).slice(0, 160),
    monsterKey,
    canonicalName: name,
    aliases: [...new Set([...(monster.aliases || []), name].map(value => String(value).trim()).filter(Boolean))].slice(0, 20),
    boss: monster.phase ? false : monster.boss === true,
    bossEvidence: monster.phase ? null : String(monster.bossEvidence || '').slice(0, 40) || null,
    phase: Number(monster.phase) > 0 ? Math.trunc(Number(monster.phase)) : null,
    maxObservedCount: Math.max(0, Math.trunc(Number(monster.maxObservedCount ?? monster.totalCount) || 0)),
    firstSeenAt: String(monster.firstSeenAt || observedAt),
    lastSeenAt: observedAt,
    observations: Math.max(0, Math.trunc(Number(monster.observations) || 0)),
  };
}

function safeFactProvenance(provenance = {}) {
  const rawSource = String(provenance?.source || 'verified monster observation');
  const source = rawSource
    .replace(/([?&](?:id|instance_id|dgmid|active_id)=)\d+/gi, '$1<runtime>')
    .slice(0, 240);
  return {
    source,
    observedAt: String(provenance?.observedAt || new Date().toISOString()).slice(0, 60),
    schemaVersion: Math.max(1, Math.trunc(Number(provenance?.schemaVersion) || 1)),
  };
}

function normalizedMonsterFact(record = {}, variantKey, scope) {
  const areaKey = String(record.areaKey || '').slice(0, 120);
  const monsterKey = monsterTypeKey(record.monsterKey || record.name);
  if (!areaKey || !monsterKey || !variantKey) throw new Error('Monster fact identity is invalid');
  const forbidden = ['id', 'monsterId', 'battleId', 'dgmid', 'instanceId', 'battleRef', 'observedMonsterId'];
  for (const field of forbidden) {
    if (Object.hasOwn(record, field) || Object.hasOwn(record.provenance || {}, field)) {
      throw new Error(`Temporary monster locator cannot be persisted: ${field}`);
    }
  }
  const assertNoSensitiveFields = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (/cookie|token|password|email|useruid|authorization/i.test(key)) {
        throw new Error(`Sensitive monster fact field cannot be persisted: ${key}`);
      }
      assertNoSensitiveFields(nested);
    }
  };
  assertNoSensitiveFields(record);
  return {
    variantKey,
    areaKey,
    monsterKey,
    name: String(record.name || monsterKey).slice(0, 200),
    scope: clone(scope),
    stats: record.stats && typeof record.stats === 'object' && !Array.isArray(record.stats) ? clone(record.stats) : null,
    possibleLoot: Array.isArray(record.possibleLoot)
      ? record.possibleLoot.map(item => clone(item)).slice(0, 500)
      : Array.isArray(record.stats?.possibleLoot) ? record.stats.possibleLoot.map(item => clone(item)).slice(0, 500) : [],
    provenance: safeFactProvenance(record.provenance),
    observedAt: String(record.provenance?.observedAt || new Date().toISOString()).slice(0, 60),
    conflict: record.conflict && typeof record.conflict === 'object' ? {
      observedStats: record.conflict.observedStats && typeof record.conflict.observedStats === 'object'
        ? clone(record.conflict.observedStats)
        : null,
      provenance: safeFactProvenance(record.conflict.provenance || {}),
    } : null,
  };
}

const STATISTICS_PERIOD_MS = Object.freeze({
  all: null,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});

function aggregateActivityRows(kind, entries = []) {
  const rows = new Map();
  for (const entry of entries) {
    const key = activityAggregateKey(entry);
    const row = rows.get(key) || {
      areaKey: entry.areaKey,
      areaType: entry.areaType,
      areaName: entry.areaName,
      monsterKey: entry.monsterKey,
      monsterName: entry.monsterName,
      boss: false,
      latestAt: null,
      attacks: 0,
      completedTargets: 0,
      totalDamage: 0,
      totalStamina: 0,
      claims: 0,
      lootCount: 0,
      totalXp: 0,
      totalGold: 0,
      itemsCount: 0,
    };
    row.areaType = entry.areaType || row.areaType;
    row.areaName = entry.areaName || row.areaName;
    row.monsterName = entry.monsterName || row.monsterName;
    row.boss = row.boss || entry.boss === true;
    row.latestAt = entry.observedAt || row.latestAt;
    if (kind === 'target') {
      row.attacks += 1;
      row.completedTargets += entry.completed === true ? 1 : 0;
      row.totalDamage += nonNegative(entry.damage);
      row.totalStamina += nonNegative(entry.staminaSpent);
    } else {
      row.claims += 1;
      row.lootCount += Math.max(1, Number(entry.stackSize) || 1);
      row.totalXp += nonNegative(entry.xp);
      row.totalGold += nonNegative(entry.gold);
      row.itemsCount += nonNegative(entry.itemsCount);
    }
    rows.set(key, row);
  }
  return [...rows.values()];
}

function statisticItemRows(entries = []) {
  const rows = new Map();
  for (const entry of entries) {
    for (const source of Array.isArray(entry.items) ? entry.items : []) {
      const item = normalizedItem(source);
      if (!item.nameKey) continue;
      const key = item.itemId ? `id:${item.itemId}` : `name:${item.nameKey}`;
      const row = rows.get(key) || {
        itemId: item.itemId,
        name: item.name,
        tier: item.tier,
        quantityObtained: 0,
      };
      row.name = item.name || row.name;
      row.tier = item.tier || row.tier;
      row.quantityObtained += item.quantity;
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

class AccountDatabase {
  constructor(filePath, options = {}) {
    this.filePath = filePath || getDataPath('account_database.json');
    this.now = options.now || (() => Date.now());
    this.writeDebounceMs = Math.max(0, Math.trunc(Number(options.writeDebounceMs) || 0));
    this.maxActivitiesPerKind = Math.max(1, Math.trunc(Number(options.maxActivitiesPerKind) || 1000));
    this.maxEvents = Math.max(1, Math.trunc(Number(options.maxEvents) || 5000));
    this.writeTimer = null;
    this.dirty = false;
    this.data = this._read();
  }

  bindStableAccount(stableAccountKey, displayName) {
    const stableKey = assertAccountKey(stableAccountKey);
    const normalizedName = String(displayName || '').trim();
    if (!normalizedName) throw new Error('Display name is required for account migration');
    const legacyKey = accountKey(normalizedName);
    const existingAlias = this.data.accountAliases[legacyKey];
    if (existingAlias && existingAlias !== stableKey) {
      throw new Error('Display-name alias is already bound to another authenticated account');
    }
    const stableExists = Boolean(this.data.accounts[stableKey]);
    const legacyExists = legacyKey !== stableKey && Boolean(this.data.accounts[legacyKey]);
    if (existingAlias === stableKey && stableExists && !legacyExists) {
      return { accountKey: stableKey, migrated: false, conflict: false };
    }
    let migrated = false;
    let conflict = false;
    if (!stableExists && legacyExists) {
      this.data.accounts[stableKey] = this.data.accounts[legacyKey];
      delete this.data.accounts[legacyKey];
      migrated = true;
    } else if (stableExists && legacyExists) {
      // Never guess a merge. The authenticated stable record wins and the
      // unattributed legacy record remains available for manual recovery,
      // but outside the active account map so Purge cannot resurrect it.
      this.data.recoveryAccounts[legacyKey] = this.data.accounts[legacyKey];
      delete this.data.accounts[legacyKey];
      conflict = true;
    } else if (!stableExists) {
      this.data.accounts[stableKey] = emptyAccount();
    }
    this.data.accountAliases[legacyKey] = stableKey;
    this.data.migrations[`stable_account_v2:${legacyKey}`] = {
      accountKey: stableKey,
      migratedAt: new Date(this.now()).toISOString(),
      conflict,
    };
    this._persist();
    this.flush();
    return { accountKey: stableKey, migrated, conflict };
  }

  resolveAccountKey(accountRef) {
    return this._resolveAccountKey(accountRef);
  }

  observeMonsterTypes(accountRef, area = {}, monsters = []) {
    if (!accountRef || !area?.key) return [];
    const account = this._account(accountRef);
    const observedAt = new Date(this.now()).toISOString();
    const observed = [];
    for (const monster of Array.isArray(monsters) ? monsters : []) {
      const normalized = normalizedMonsterType(area, monster, observedAt);
      if (!normalized) continue;
      const identity = buildMonsterTypeKey({ areaKey: area.key, monsterKey: normalized.monsterKey });
      const existing = account.monsterKnowledge.types[identity] || normalized;
      const aliases = new Set([...(existing.aliases || []), ...(normalized.aliases || []), existing.canonicalName].filter(Boolean));
      const phase = Number(normalized.phase) || Number(existing.phase) || null;
      // Stable account memory must not turn a currently observed ordinary mob
      // back into a boss.  The catalog supplies explicit server/auto-summon
      // evidence for the current page; remembered boss metadata is only used
      // for rows that are not present in the current observation.
      const boss = normalized.runtimePhase === true
        ? (phase ? false : Boolean(existing.boss))
        : (phase ? false : normalized.boss === true);
      const next = {
        ...existing,
        ...normalized,
        canonicalName: existing.canonicalName || normalized.canonicalName,
        aliases: [...aliases].slice(0, 20),
        phase,
        boss,
        bossEvidence: phase
          ? null
          : (normalized.runtimePhase === true
            ? (normalized.bossEvidence || existing.bossEvidence || null)
            : (normalized.bossEvidence || null)),
        maxObservedCount: Math.max(Number(existing.maxObservedCount) || 0, Number(normalized.maxObservedCount) || 0),
        firstSeenAt: existing.firstSeenAt || normalized.firstSeenAt,
        lastSeenAt: observedAt,
        observations: Math.min(Number.MAX_SAFE_INTEGER, (Number(existing.observations) || 0) + 1),
      };
      account.monsterKnowledge.types[identity] = next;
      observed.push(clone(next));
    }
    if (observed.length > 0) this._persist();
    return observed;
  }

  listMonsterTypes(accountRef, areaKey = null) {
    const account = this._account(accountRef, false);
    if (!account) return [];
    return clone(Object.values(account.monsterKnowledge.types)
      .filter(monster => !areaKey || monster.areaKey === areaKey)
      .sort((left, right) => left.areaName.localeCompare(right.areaName)
        || left.canonicalName.localeCompare(right.canonicalName)));
  }

  putMonsterFact(accountRef, record, context = {}) {
    const account = this._account(accountRef);
    const typeKey = buildMonsterTypeKey({ areaKey: record.areaKey, monsterKey: record.monsterKey || record.name });
    const scope = context.scope || { kind: 'account', accountKey: this._resolveAccountKey(accountRef) };
    const variantKey = buildMonsterFactVariantKey({ monsterTypeKey: typeKey, scope });
    const normalized = normalizedMonsterFact(record, variantKey, scope);
    account.monsterKnowledge.facts[variantKey] = normalized;
    this._persist();
    return clone(normalized);
  }

  getMonsterFact(accountRef, areaKey, monsterKeyValue, context = {}) {
    const account = this._account(accountRef, false);
    if (!account) return null;
    const typeKey = buildMonsterTypeKey({ areaKey, monsterKey: monsterKeyValue });
    const scopes = [];
    if (context.eventKey && Number.isFinite(Number(context.level))) {
      scopes.push({ kind: 'event', eventKey: context.eventKey, level: Math.max(0, Math.trunc(Number(context.level))) });
    }
    scopes.push({ kind: 'account', accountKey: this._resolveAccountKey(accountRef) });
    for (const scope of scopes) {
      const key = buildMonsterFactVariantKey({ monsterTypeKey: typeKey, scope });
      if (account.monsterKnowledge.facts[key]) return clone(account.monsterKnowledge.facts[key]);
    }
    return null;
  }

  getAccountConfig(accountName) {
    const account = this._account(accountName, false);
    return account?.config && typeof account.config === 'object' ? clone(account.config) : null;
  }

  setAccountConfig(accountName, config) {
    if (!accountName || !config || typeof config !== 'object' || Array.isArray(config)) return false;
    const account = this._account(accountName);
    account.config = clone(config);
    this._persist();
    return true;
  }

  clearAccountConfig(accountName) {
    const account = this._account(accountName, false);
    if (!account || account.config === null) return false;
    account.config = null;
    this._persist();
    this.flush();
    return true;
  }

  claimLegacyConfig(accountName, config) {
    const migrationKey = 'bot_config_account_scope_v1';
    if (!accountName || this.data.migrations[migrationKey]) return null;
    const account = this._account(accountName);
    account.config = clone(config || {});
    this.data.migrations[migrationKey] = {
      accountKey: accountKey(accountName),
      migratedAt: new Date(this.now()).toISOString(),
    };
    this._persist();
    this.flush();
    return clone(account.config);
  }

  observeAreaMonsters(accountName, area = {}, monsters = []) {
    return this.observeMonsterTypes(accountName, area, monsters);
  }

  observeAutoFarmTypes(accountName, types = []) {
    if (!accountName) return [];
    const account = this._account(accountName);
    const observedAt = new Date(this.now()).toISOString();
    const observed = [];
    for (const type of Array.isArray(types) ? types : []) {
      const typeId = String(type?.id ?? type?.monsterId ?? '').trim();
      const name = String(type?.name ?? type?.monsterName ?? '').trim().slice(0, 200);
      const nameKey = monsterTypeKey(name);
      if (!/^\d{1,30}$/.test(typeId) || !nameKey) continue;
      const existing = account.autoFarmTypes[typeId] || {
        typeId,
        name,
        nameKey,
        aliases: [],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        observations: 0,
      };
      const aliases = new Set([...(existing.aliases || []), existing.name, name].filter(Boolean));
      existing.name = name;
      existing.nameKey = nameKey;
      existing.aliases = [...aliases].slice(0, 20);
      existing.lastSeenAt = observedAt;
      existing.observations = Math.min(Number.MAX_SAFE_INTEGER, (Number(existing.observations) || 0) + 1);
      account.autoFarmTypes[typeId] = existing;
      observed.push(clone(existing));
    }
    if (observed.length > 0) this._persist();
    return observed;
  }

  getAutoFarmTypesForArea(accountName, areaKey) {
    if (!accountName || !areaKey) return [];
    const account = this._account(accountName, false);
    if (!account) return [];
    const areasByName = this._areasByName(account);
    return Object.values(account.autoFarmTypes)
      .filter(type => {
        const areas = areasByName.get(type.nameKey);
        return areas?.size === 1 && areas.has(areaKey);
      })
      .map(type => ({ id: type.typeId, name: type.name }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  resolveAutoFarmArea(accountName, typeId, name = '') {
    if (!accountName) return null;
    const account = this._account(accountName, false);
    if (!account) return null;
    const saved = account.autoFarmTypes[String(typeId || '')];
    const nameKey = saved?.nameKey || monsterTypeKey(name);
    if (!nameKey) return null;
    const areas = this._areasByName(account).get(nameKey);
    return areas?.size === 1 ? [...areas][0] : null;
  }

  listMonsters(accountName, areaKey = null) {
    return this.listMonsterTypes(accountName, areaKey);
  }

  recordActivity(accountName, kind, entry = {}, options = {}) {
    if (!accountName || !ACTIVITY_KINDS.has(kind)) return null;
    const account = this._account(accountName);
    const recorded = this._normalizeActivity(kind, entry);
    const limit = Math.max(1, Math.trunc(Number(options.maxEntries) || this.maxActivitiesPerKind));
    account.activities[kind].unshift(recorded);
    account.activities[kind] = account.activities[kind].slice(0, limit);
    this._applyAggregate(account, kind, recorded);
    if (kind === 'loot') this._observeItems(account, recorded.items, recorded.observedAt);
    this._persist();
    return clone(recorded);
  }

  listActivities(accountName, kind, options = {}) {
    if (!accountName || !ACTIVITY_KINDS.has(kind)) return [];
    const account = this._account(accountName, false);
    if (!account) return [];
    const limit = Math.max(1, Math.trunc(Number(options.limit) || 100));
    return clone(account.activities[kind]
      .filter(entry => !options.areaKey || entry.areaKey === options.areaKey)
      .slice(0, limit));
  }

  activitySummaries(accountName, kind, areaKey = null) {
    if (!accountName || !ACTIVITY_KINDS.has(kind)) return [];
    const account = this._account(accountName, false);
    if (!account) return [];
    return clone(Object.values(account.aggregates[kind])
      .filter(entry => !areaKey || entry.areaKey === areaKey)
      .sort((left, right) => String(right.latestAt || '').localeCompare(String(left.latestAt || ''))));
  }

  clearActivities(accountName, kinds, options = {}) {
    const selected = [...new Set((Array.isArray(kinds) ? kinds : [kinds]).filter(kind => ACTIVITY_KINDS.has(kind)))];
    if (selected.length === 0) throw new Error('Select attacking history, looting history, or both');
    const beforeMs = options.before == null || options.before === '' ? null : Date.parse(String(options.before));
    if (beforeMs !== null && !Number.isFinite(beforeMs)) throw new Error('History cutoff date is invalid');
    const account = this._account(accountName);
    const removed = { target: 0, loot: 0 };
    for (const kind of selected) {
      const previous = account.activities[kind];
      const retained = beforeMs === null ? [] : previous.filter(entry => {
        const observedMs = Date.parse(String(entry.observedAt || ''));
        return !Number.isFinite(observedMs) || observedMs >= beforeMs;
      });
      removed[kind] = previous.length - retained.length;
      account.activities[kind] = retained;
      account.aggregates[kind] = {};
      for (const entry of [...retained].reverse()) this._applyAggregate(account, kind, entry);
    }
    if (selected.includes('loot')) {
      account.items = {};
      for (const entry of account.activities.loot) this._observeItems(account, entry.items, entry.observedAt);
    }
    this._persist();
    this.flush();
    return {
      removed,
      remaining: { target: account.activities.target.length, loot: account.activities.loot.length },
    };
  }

  recordEvent(accountName, type, details = {}) {
    if (!accountName || !type) return null;
    const account = this._account(accountName);
    const event = {
      id: crypto.randomUUID(),
      type: String(type).slice(0, 80),
      observedAt: new Date(this.now()).toISOString(),
      details: this._sanitizeEventDetails(details),
    };
    account.events.unshift(event);
    account.events = account.events.slice(0, this.maxEvents);
    this._persist();
    return clone(event);
  }

  listEvents(accountName, options = {}) {
    const account = this._account(accountName, false);
    if (!account) return [];
    const limit = Math.max(1, Math.trunc(Number(options.limit) || 100));
    return clone(account.events
      .filter(event => !options.type || event.type === options.type)
      .slice(0, limit));
  }

  listItems(accountName) {
    const account = this._account(accountName, false);
    return account ? clone(Object.values(account.items).sort((a, b) => a.name.localeCompare(b.name))) : [];
  }

  getStatistics(accountName, options = {}) {
    const period = Object.prototype.hasOwnProperty.call(STATISTICS_PERIOD_MS, options.period)
      ? options.period
      : '7d';
    const nowMs = Number(this.now());
    const cutoffMs = STATISTICS_PERIOD_MS[period] === null ? null : nowMs - STATISTICS_PERIOD_MS[period];
    const account = this._account(accountName, false) || emptyAccount();
    const inPeriod = value => {
      if (cutoffMs === null) return true;
      const timestamp = Date.parse(String(value || ''));
      return Number.isFinite(timestamp) && timestamp >= cutoffMs && timestamp <= nowMs;
    };

    const targetEntries = account.activities.target.filter(entry => inPeriod(entry.observedAt));
    const lootEntries = account.activities.loot.filter(entry => inPeriod(entry.observedAt));
    const events = account.events.filter(event => inPeriod(event.observedAt));
    const targetRows = period === 'all'
      ? Object.values(account.aggregates.target || {})
      : aggregateActivityRows('target', targetEntries);
    const lootRows = period === 'all'
      ? Object.values(account.aggregates.loot || {})
      : aggregateActivityRows('loot', lootEntries);

    const summary = {
      attacks: 0,
      targetsReached: 0,
      damage: 0,
      stamina: 0,
      claims: 0,
      lootCount: 0,
      xp: 0,
      gold: 0,
      items: 0,
      potionsUsed: 0,
      potionsPurchased: 0,
      chaptersFarmed: 0,
      heals: 0,
      pvpMatchesJoined: 0,
      pvpWins: 0,
      pvpLosses: 0,
      pvpCompleted: 0,
      pvpDurationMs: 0,
    };
    for (const row of targetRows) {
      summary.attacks += nonNegative(row.attacks);
      summary.targetsReached += nonNegative(row.completedTargets);
      summary.damage += nonNegative(row.totalDamage);
      summary.stamina += nonNegative(row.totalStamina);
    }
    for (const row of lootRows) {
      summary.claims += nonNegative(row.claims);
      summary.lootCount += nonNegative(row.lootCount);
      summary.xp += nonNegative(row.totalXp);
      summary.gold += nonNegative(row.totalGold);
      summary.items += nonNegative(row.itemsCount);
    }

    const resourceMap = new Map();
    for (const event of events) {
      const type = String(event.type || 'other');
      const method = String(event.details?.method || '');
      const resource = String(event.details?.resource || (type === 'healing' ? 'health' : ''));
      const potionType = String(event.details?.potionType || (type === 'healing' && method === 'potion' ? 'health' : ''));
      const quantity = Math.max(1, Math.trunc(Number(event.details?.quantity) || 1));
      const key = `${type}\u0000${resource}\u0000${potionType}`;
      const row = resourceMap.get(key) || { type, resource, potionType, actions: 0, quantity: 0, latestAt: null };
      row.actions += 1;
      row.quantity += quantity;
      row.latestAt = event.observedAt || row.latestAt;
      resourceMap.set(key, row);
      if (type === 'potion_use') summary.potionsUsed += quantity;
      else if (type === 'potion_purchase') summary.potionsPurchased += quantity;
      else if (type === 'chapter_farm') summary.chaptersFarmed += quantity;
      else if (type === 'healing') {
        summary.heals += quantity;
        if (method === 'potion') summary.potionsUsed += quantity;
      }
      else if (type === 'cube_pvp_join') summary.pvpMatchesJoined += quantity;
      else if (type === 'cube_pvp_result') {
        summary.pvpCompleted += 1;
        summary.pvpDurationMs += nonNegative(event.details?.durationMs);
        if (String(event.details?.winnerSide || '').toLowerCase() === 'ally') summary.pvpWins += 1;
        else if (event.details?.winnerSide) summary.pvpLosses += 1;
      }
    }

    const areaMap = new Map();
    const areaRow = source => {
      const key = String(source.areaKey || 'unknown');
      if (!areaMap.has(key)) {
        areaMap.set(key, {
          areaKey: key,
          areaType: source.areaType || '',
          areaName: source.areaName || key,
          attacks: 0,
          targetsReached: 0,
          damage: 0,
          stamina: 0,
          claims: 0,
          lootCount: 0,
          xp: 0,
          gold: 0,
          items: 0,
        });
      }
      return areaMap.get(key);
    };
    for (const source of targetRows) {
      const row = areaRow(source);
      row.attacks += nonNegative(source.attacks);
      row.targetsReached += nonNegative(source.completedTargets);
      row.damage += nonNegative(source.totalDamage);
      row.stamina += nonNegative(source.totalStamina);
    }
    for (const source of lootRows) {
      const row = areaRow(source);
      row.claims += nonNegative(source.claims);
      row.lootCount += nonNegative(source.lootCount);
      row.xp += nonNegative(source.totalXp);
      row.gold += nonNegative(source.totalGold);
      row.items += nonNegative(source.itemsCount);
    }

    const trendDays = period === '24h' ? 1 : period === '7d' ? 7 : 30;
    const trendMap = new Map();
    for (let offset = trendDays - 1; offset >= 0; offset -= 1) {
      const date = new Date(nowMs - (offset * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
      trendMap.set(date, { date, attacks: 0, targetsReached: 0, damage: 0, stamina: 0, claims: 0, xp: 0, gold: 0, items: 0, potions: 0, chapters: 0 });
    }
    for (const entry of account.activities.target) {
      const bucket = trendMap.get(String(entry.observedAt || '').slice(0, 10));
      if (!bucket) continue;
      bucket.attacks += 1;
      bucket.targetsReached += entry.completed === true ? 1 : 0;
      bucket.damage += nonNegative(entry.damage);
      bucket.stamina += nonNegative(entry.staminaSpent);
    }
    for (const entry of account.activities.loot) {
      const bucket = trendMap.get(String(entry.observedAt || '').slice(0, 10));
      if (!bucket) continue;
      bucket.claims += 1;
      bucket.xp += nonNegative(entry.xp);
      bucket.gold += nonNegative(entry.gold);
      bucket.items += nonNegative(entry.itemsCount);
    }
    for (const event of account.events) {
      const bucket = trendMap.get(String(event.observedAt || '').slice(0, 10));
      if (!bucket) continue;
      const quantity = Math.max(1, Math.trunc(Number(event.details?.quantity) || 1));
      if (event.type === 'potion_use') bucket.potions += quantity;
      if (event.type === 'chapter_farm') bucket.chapters += quantity;
    }

    const items = period === 'all'
      ? Object.values(account.items || {})
      : statisticItemRows(lootEntries);
    return clone({
      generatedAt: new Date(nowMs).toISOString(),
      period,
      summary,
      trend: [...trendMap.values()],
      areas: [...areaMap.values()].sort((left, right) => (right.damage + right.xp) - (left.damage + left.xp)),
      combat: targetRows
        .map(row => ({ ...row }))
        .sort((left, right) => nonNegative(right.totalDamage) - nonNegative(left.totalDamage))
        .slice(0, 25),
      loot: lootRows
        .map(row => ({ ...row }))
        .sort((left, right) => nonNegative(right.totalXp) - nonNegative(left.totalXp))
        .slice(0, 25),
      resources: [...resourceMap.values()].sort((left, right) => String(right.latestAt || '').localeCompare(String(left.latestAt || ''))),
      pvp: events.filter(event => ['cube_pvp_join', 'cube_pvp_state', 'cube_pvp_result'].includes(event.type)),
      items: items
        .map(item => ({ ...item }))
        .sort((left, right) => nonNegative(right.quantityObtained) - nonNegative(left.quantityObtained) || String(left.name).localeCompare(String(right.name)))
        .slice(0, 50),
      coverage: {
        targetDetails: account.activities.target.length,
        lootDetails: account.activities.loot.length,
        eventDetails: account.events.length,
        targetAtRetentionLimit: account.activities.target.length >= this.maxActivitiesPerKind,
        lootAtRetentionLimit: account.activities.loot.length >= this.maxActivitiesPerKind,
        eventsAtRetentionLimit: account.events.length >= this.maxEvents,
        trendDays,
      },
    });
  }

  getLootSnapshot(accountName, areaKey) {
    if (!accountName || !areaKey) return null;
    const account = this._account(accountName, false);
    return account?.lootSnapshots?.[areaKey] ? clone(account.lootSnapshots[areaKey]) : null;
  }

  listLootSnapshots(accountName) {
    const account = this._account(accountName, false);
    if (!account) return [];
    return clone(Object.values(account.lootSnapshots || {})
      .sort((left, right) => Number(right.refreshedAt || 0) - Number(left.refreshedAt || 0)));
  }

  setLootSnapshot(accountName, areaKey, snapshot) {
    if (!accountName || !areaKey || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
    const account = this._account(accountName);
    account.lootSnapshots[areaKey] = clone(snapshot);
    this._persist();
    return true;
  }

  clearLootSnapshots(accountName) {
    const account = this._account(accountName, false);
    if (!account || Object.keys(account.lootSnapshots || {}).length === 0) return false;
    account.lootSnapshots = {};
    this._persist();
    return true;
  }

  importLegacyLootDiscovery(filePath) {
    const migrationKey = 'loot_discovery_account_database_v1';
    if (this.data.migrations[migrationKey]) return false;
    try {
      if (fs.existsSync(filePath)) {
        const legacy = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const [hashedAccount, source] of Object.entries(legacy?.accounts || {})) {
          const account = this._accountByKey(this.data.accountAliases[hashedAccount] || hashedAccount);
          for (const [areaKey, snapshot] of Object.entries(source?.areas || {})) {
            if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
            account.lootSnapshots[areaKey] = clone(snapshot);
          }
        }
      }
    } catch {
      return false;
    }
    this.data.migrations[migrationKey] = new Date(this.now()).toISOString();
    this._persist();
    this.flush();
    return true;
  }

  importLegacyActivityHistory(filePath) {
    const migrationKey = 'activity_history_v2';
    if (this.data.migrations[migrationKey]) return false;
    try {
      if (fs.existsSync(filePath)) {
        const legacy = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const [hashedAccount, source] of Object.entries(legacy?.accounts || {})) {
          const account = this._accountByKey(this.data.accountAliases[hashedAccount] || hashedAccount);
          for (const kind of ACTIVITY_KINDS) {
            const entries = Array.isArray(source?.[kind]) ? source[kind].slice(0, this.maxActivitiesPerKind) : [];
            account.activities[kind] = entries.map(entry => this._normalizeActivity(kind, entry, true));
            account.aggregates[kind] = {};
            for (const entry of [...account.activities[kind]].reverse()) this._applyAggregate(account, kind, entry);
            if (kind === 'loot') {
              for (const entry of account.activities[kind]) this._observeItems(account, entry.items, entry.observedAt);
            }
          }
        }
      }
    } catch {
      // Legacy history remains untouched and can be imported after it is repaired.
      return false;
    }
    this.data.migrations[migrationKey] = new Date(this.now()).toISOString();
    this._persist();
    this.flush();
    return true;
  }

  purgeAccount(accountName) {
    if (!accountName) return false;
    const key = this._resolveAccountKey(accountName);
    if (!this.data.accounts[key]) return false;
    delete this.data.accounts[key];
    for (const [alias, target] of Object.entries(this.data.accountAliases)) {
      if (target === key) delete this.data.accountAliases[alias];
    }
    this._persist();
    this.flush();
    return true;
  }

  exportAccount(accountName) {
    const account = this._account(accountName, false);
    return account ? clone(this._normalizeAccount(account)) : emptyAccount();
  }

  replaceAccount(accountName, payload) {
    if (!accountName || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid account database backup');
    this.data.accounts[this._resolveAccountKey(accountName)] = this._normalizeAccount(payload);
    this._persist();
    this.flush();
    return true;
  }

  flush() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (!this.dirty) return false;
    this.dirty = false;
    this._write();
    return true;
  }

  _areasByName(account) {
    const result = new Map();
    for (const monster of Object.values(account.monsterKnowledge.types)) {
      const keys = new Set([monster.monsterKey, ...(monster.aliases || []).map(monsterTypeKey)].filter(Boolean));
      for (const key of keys) {
        if (!result.has(key)) result.set(key, new Set());
        result.get(key).add(monster.areaKey);
      }
    }
    return result;
  }

  _normalizeActivity(kind, entry = {}, preserveIdentity = false) {
    return {
      id: preserveIdentity && entry.id ? String(entry.id) : crypto.randomUUID(),
      kind,
      observedAt: preserveIdentity && entry.observedAt ? String(entry.observedAt) : new Date(this.now()).toISOString(),
      areaKey: String(entry.areaKey || '').slice(0, 120),
      areaType: String(entry.areaType || '').slice(0, 24),
      areaName: String(entry.areaName || '').slice(0, 160),
      monsterKey: String(entry.monsterKey || '').slice(0, 160),
      monsterName: String(entry.monsterName || 'Unknown monster').slice(0, 200),
      monsterId: String(entry.monsterId || '').slice(0, 40),
      instanceId: entry.instanceId == null ? null : String(entry.instanceId).slice(0, 40),
      boss: entry.boss === true,
      damage: finiteOrNull(entry.damage),
      totalDamage: finiteOrNull(entry.totalDamage),
      staminaSpent: finiteOrNull(entry.staminaSpent),
      targetDamage: finiteOrNull(entry.targetDamage),
      completed: entry.completed === true,
      stackSize: Math.max(1, Math.trunc(Number(entry.stackSize) || 1)),
      xp: finiteOrNull(entry.xp),
      gold: finiteOrNull(entry.gold),
      itemsCount: Math.max(0, Math.trunc(Number(entry.itemsCount) || 0)),
      items: (Array.isArray(entry.items) ? entry.items : []).map(normalizedItem),
      actionName: String(entry.actionName || '').slice(0, 120),
      result: String(entry.result || '').slice(0, 500),
      pageUrl: String(entry.pageUrl || '').slice(0, 300),
    };
  }

  _applyAggregate(account, kind, entry) {
    const store = account.aggregates[kind];
    const key = activityAggregateKey(entry);
    const aggregate = store[key] || {
      areaKey: entry.areaKey,
      areaType: entry.areaType,
      areaName: entry.areaName,
      monsterKey: entry.monsterKey,
      monsterName: entry.monsterName,
      boss: false,
      latestAt: null,
      attacks: 0,
      completedTargets: 0,
      totalDamage: 0,
      totalStamina: 0,
      claims: 0,
      lootCount: 0,
      totalXp: 0,
      totalGold: 0,
      itemsCount: 0,
    };
    aggregate.areaType = entry.areaType || aggregate.areaType;
    aggregate.areaName = entry.areaName || aggregate.areaName;
    aggregate.monsterName = entry.monsterName || aggregate.monsterName;
    aggregate.boss = aggregate.boss || entry.boss === true;
    aggregate.latestAt = entry.observedAt;
    if (kind === 'target') {
      aggregate.attacks += 1;
      aggregate.completedTargets += entry.completed === true ? 1 : 0;
      aggregate.totalDamage += nonNegative(entry.damage);
      aggregate.totalStamina += nonNegative(entry.staminaSpent);
    } else {
      aggregate.claims += 1;
      aggregate.lootCount += Math.max(1, Number(entry.stackSize) || 1);
      aggregate.totalXp += nonNegative(entry.xp);
      aggregate.totalGold += nonNegative(entry.gold);
      aggregate.itemsCount += nonNegative(entry.itemsCount);
    }
    store[key] = aggregate;
  }

  _observeItems(account, items, observedAt) {
    for (const item of Array.isArray(items) ? items : []) {
      const normalized = normalizedItem(item);
      const key = normalized.itemId ? `id:${normalized.itemId}` : `name:${normalized.nameKey}`;
      if (!normalized.nameKey) continue;
      const existing = account.items[key] || {
        itemId: normalized.itemId,
        name: normalized.name,
        nameKey: normalized.nameKey,
        tier: normalized.tier,
        quantityObtained: 0,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      };
      existing.name = normalized.name || existing.name;
      existing.tier = normalized.tier || existing.tier;
      existing.quantityObtained += normalized.quantity;
      existing.lastSeenAt = observedAt;
      account.items[key] = existing;
    }
  }

  _sanitizeEventDetails(details = {}) {
    const allowed = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (/cookie|token|password|email|useruid|authorization/i.test(key)) continue;
      if (typeof value === 'boolean' || value === null) allowed[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) allowed[key] = value;
      else if (typeof value === 'string') allowed[key] = value.slice(0, 300);
    }
    return allowed;
  }

  _account(accountName, create = true) {
    if (!accountName) return null;
    return this._accountByKey(this._resolveAccountKey(accountName), create);
  }

  _resolveAccountKey(accountRef) {
    const raw = String(accountRef || '').trim();
    if (!raw) throw new Error('Account identity is required');
    if (isAccountKey(raw)) return raw;
    const legacyKey = accountKey(raw);
    return this.data.accountAliases[legacyKey] || legacyKey;
  }

  _accountByKey(key, create = true) {
    if (!this.data.accounts[key] && create) this.data.accounts[key] = emptyAccount();
    return this.data.accounts[key] || null;
  }

  _normalizeAccount(source) {
    const account = emptyAccount();
    if (!source || typeof source !== 'object') return account;
    account.config = source.config && typeof source.config === 'object' && !Array.isArray(source.config)
      ? source.config
      : null;
    const knowledge = source.monsterKnowledge && typeof source.monsterKnowledge === 'object'
      ? source.monsterKnowledge
      : {};
    const legacyTypes = source.monsters && typeof source.monsters === 'object' ? source.monsters : {};
    const rawTypes = knowledge.types && typeof knowledge.types === 'object' ? knowledge.types : legacyTypes;
    for (const monster of Object.values(rawTypes)) {
      try {
        const observedAt = String(monster.lastSeenAt || monster.firstSeenAt || new Date(this.now()).toISOString());
        const normalized = normalizedMonsterType({
          key: monster.areaKey,
          type: monster.areaType,
          label: monster.areaName,
        }, monster, observedAt);
        if (!normalized) continue;
        normalized.firstSeenAt = String(monster.firstSeenAt || normalized.firstSeenAt);
        normalized.observations = Math.max(0, Math.trunc(Number(monster.observations) || 0));
        const key = buildMonsterTypeKey({ areaKey: normalized.areaKey, monsterKey: normalized.monsterKey });
        account.monsterKnowledge.types[key] = normalized;
      } catch {
        // Invalid legacy knowledge is ignored instead of gaining authority.
      }
    }
    const rawFacts = knowledge.facts && typeof knowledge.facts === 'object' ? knowledge.facts : {};
    for (const fact of Object.values(rawFacts)) {
      try {
        const typeKey = buildMonsterTypeKey({ areaKey: fact.areaKey, monsterKey: fact.monsterKey || fact.name });
        const scope = fact.scope && typeof fact.scope === 'object' ? fact.scope : { kind: 'global' };
        const variantKey = buildMonsterFactVariantKey({ monsterTypeKey: typeKey, scope });
        account.monsterKnowledge.facts[variantKey] = normalizedMonsterFact(fact, variantKey, scope);
      } catch {
        // Corrupt, sensitive, or instance-bound facts are never restored.
      }
    }
    account.autoFarmTypes = source.autoFarmTypes && typeof source.autoFarmTypes === 'object' ? source.autoFarmTypes : {};
    account.activities.target = Array.isArray(source.activities?.target) ? source.activities.target : [];
    account.activities.loot = Array.isArray(source.activities?.loot) ? source.activities.loot : [];
    account.aggregates.target = source.aggregates?.target && typeof source.aggregates.target === 'object' ? source.aggregates.target : {};
    account.aggregates.loot = source.aggregates?.loot && typeof source.aggregates.loot === 'object' ? source.aggregates.loot : {};
    account.events = Array.isArray(source.events) ? source.events : [];
    account.items = source.items && typeof source.items === 'object' ? source.items : {};
    account.lootSnapshots = source.lootSnapshots && typeof source.lootSnapshots === 'object' ? source.lootSnapshots : {};
    return account;
  }

  _read() {
    try {
      if (!fs.existsSync(this.filePath)) return emptyDatabase();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (![1, ACCOUNT_DATABASE_SCHEMA_VERSION].includes(parsed?.schemaVersion)
          || !parsed.accounts || typeof parsed.accounts !== 'object') {
        return emptyDatabase();
      }
      const database = emptyDatabase();
      database.migrations = parsed.migrations && typeof parsed.migrations === 'object' ? parsed.migrations : {};
      database.accountAliases = parsed.accountAliases && typeof parsed.accountAliases === 'object'
        ? parsed.accountAliases
        : {};
      database.recoveryAccounts = parsed.recoveryAccounts && typeof parsed.recoveryAccounts === 'object'
        ? parsed.recoveryAccounts
        : {};
      for (const [key, account] of Object.entries(parsed.accounts)) database.accounts[key] = this._normalizeAccount(account);
      return database;
    } catch {
      return emptyDatabase();
    }
  }

  _persist() {
    this.dirty = true;
    if (this.writeDebounceMs <= 0) {
      this.flush();
      return;
    }
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => this.flush(), this.writeDebounceMs);
    this.writeTimer.unref?.();
  }

  _write() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

module.exports = {
  ACCOUNT_DATABASE_SCHEMA_VERSION,
  AccountDatabase,
  accountKey,
  monsterTypeKey,
};
