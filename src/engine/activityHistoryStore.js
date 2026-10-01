const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../main/dataPaths');

const ACTIVITY_HISTORY_SCHEMA_VERSION = 2;
const DEFAULT_PATH = path.join(getDataDir(), 'activity_history.json');
const HISTORY_KINDS = new Set(['target', 'loot']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyStore() {
  return { schemaVersion: ACTIVITY_HISTORY_SCHEMA_VERSION, accounts: {} };
}

function emptyAccount() {
  return { target: [], loot: [], targetAggregates: {}, lootAggregates: {} };
}

function accountKey(accountName) {
  return crypto.createHash('sha256').update(String(accountName || '')).digest('hex');
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

function aggregateKey(entry) {
  return `${String(entry.areaKey || '')}\u0000${String(entry.monsterKey || entry.monsterName || '')}`;
}

class ActivityHistoryStore {
  constructor(filePath = DEFAULT_PATH, options = {}) {
    this.filePath = filePath;
    this.database = options.database || null;
    this.now = options.now || (() => Date.now());
    this.maxEntriesPerKind = Math.max(1, Math.trunc(Number(options.maxEntriesPerKind) || 1000));
    this.writeDebounceMs = Math.max(0, Math.trunc(Number(options.writeDebounceMs) || 0));
    this.writeTimer = null;
    this.dirty = false;
    this.data = this._read();
  }

  record(accountName, kind, entry = {}) {
    if (!accountName || !HISTORY_KINDS.has(kind)) return null;
    if (this.database) {
      return this.database.recordActivity(accountName, kind, entry, { maxEntries: this.maxEntriesPerKind });
    }
    const key = accountKey(accountName);
    const account = this._normalizeAccount(this.data.accounts[key]);
    const recorded = {
      id: crypto.randomUUID(),
      kind,
      observedAt: new Date(this.now()).toISOString(),
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
      items: Array.isArray(entry.items) ? clone(entry.items) : [],
      actionName: String(entry.actionName || '').slice(0, 120),
      result: String(entry.result || '').slice(0, 500),
      pageUrl: String(entry.pageUrl || '').slice(0, 300),
    };
    account[kind].unshift(recorded);
    account[kind] = account[kind].slice(0, this.maxEntriesPerKind);
    this._applyAggregate(account, kind, recorded);
    this.data.accounts[key] = account;
    this._persist();
    return clone(recorded);
  }

  list(accountName, kind, limit = 100, areaKey = null) {
    if (!accountName || !HISTORY_KINDS.has(kind)) return [];
    if (this.database) return this.database.listActivities(accountName, kind, { limit, areaKey });
    const count = Math.min(this.maxEntriesPerKind, Math.max(1, Math.trunc(Number(limit) || 100)));
    const entries = this._normalizeAccount(this.data.accounts[accountKey(accountName)])[kind];
    return clone(entries.filter(entry => !areaKey || entry.areaKey === areaKey).slice(0, count));
  }

  summaries(accountName, kind, areaKey = null) {
    if (!accountName || !HISTORY_KINDS.has(kind)) return [];
    if (this.database) return this.database.activitySummaries(accountName, kind, areaKey);
    const account = this._normalizeAccount(this.data.accounts[accountKey(accountName)]);
    const aggregates = kind === 'target' ? account.targetAggregates : account.lootAggregates;
    return clone(Object.values(aggregates)
      .filter(entry => !areaKey || entry.areaKey === areaKey)
      .sort((left, right) => String(right.latestAt || '').localeCompare(String(left.latestAt || ''))));
  }

  query(accountName, kind, options = {}) {
    const areaKey = typeof options.areaKey === 'string' && options.areaKey ? options.areaKey : null;
    return {
      entries: this.list(accountName, kind, options.limit || 500, areaKey),
      summaries: this.summaries(accountName, kind, areaKey),
    };
  }

  clear(accountName, kinds, options = {}) {
    if (!accountName) return { removed: { target: 0, loot: 0 }, remaining: { target: 0, loot: 0 } };
    if (this.database) return this.database.clearActivities(accountName, kinds, options);
    const selectedKinds = [...new Set((Array.isArray(kinds) ? kinds : [kinds])
      .filter(kind => HISTORY_KINDS.has(kind)))];
    if (selectedKinds.length === 0) throw new Error('Select attacking history, looting history, or both');
    const beforeMs = options.before == null || options.before === ''
      ? null
      : Date.parse(String(options.before));
    if (beforeMs !== null && !Number.isFinite(beforeMs)) throw new Error('History cutoff date is invalid');

    const key = accountKey(accountName);
    const account = this._normalizeAccount(this.data.accounts[key]);
    const removed = { target: 0, loot: 0 };
    for (const kind of selectedKinds) {
      const previous = account[kind];
      const retained = beforeMs === null
        ? []
        : previous.filter(entry => {
          const observedMs = Date.parse(String(entry.observedAt || ''));
          return !Number.isFinite(observedMs) || observedMs >= beforeMs;
        });
      removed[kind] = previous.length - retained.length;
      account[kind] = retained;
      const aggregateName = kind === 'target' ? 'targetAggregates' : 'lootAggregates';
      account[aggregateName] = {};
      for (const entry of [...retained].reverse()) this._applyAggregate(account, kind, entry);
    }
    this.data.accounts[key] = account;
    this._persist();
    this.flush();
    return {
      removed,
      remaining: { target: account.target.length, loot: account.loot.length },
    };
  }

  purgeAccount(accountName) {
    if (!accountName) return false;
    if (this.database) return this.database.purgeAccount(accountName);
    const key = accountKey(accountName);
    if (!this.data.accounts[key]) return false;
    delete this.data.accounts[key];
    this._persist();
    this.flush();
    return true;
  }

  flush() {
    if (this.database) return this.database.flush();
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (!this.dirty) return false;
    this.dirty = false;
    this._write();
    return true;
  }

  _normalizeAccount(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      target: Array.isArray(source.target) ? source.target : [],
      loot: Array.isArray(source.loot) ? source.loot : [],
      targetAggregates: source.targetAggregates && typeof source.targetAggregates === 'object' ? source.targetAggregates : {},
      lootAggregates: source.lootAggregates && typeof source.lootAggregates === 'object' ? source.lootAggregates : {},
    };
  }

  _applyAggregate(account, kind, entry) {
    const store = kind === 'target' ? account.targetAggregates : account.lootAggregates;
    const key = aggregateKey(entry);
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

  _read() {
    if (this.database) return emptyStore();
    try {
      if (!fs.existsSync(this.filePath)) return emptyStore();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed?.accounts || typeof parsed.accounts !== 'object') return emptyStore();
      if (parsed.schemaVersion === ACTIVITY_HISTORY_SCHEMA_VERSION) {
        const next = emptyStore();
        for (const [key, account] of Object.entries(parsed.accounts)) next.accounts[key] = this._normalizeAccount(account);
        return next;
      }
      if (parsed.schemaVersion === 1) {
        const migrated = emptyStore();
        for (const [key, oldAccount] of Object.entries(parsed.accounts)) {
          const account = emptyAccount();
          for (const kind of HISTORY_KINDS) {
            account[kind] = Array.isArray(oldAccount?.[kind]) ? oldAccount[kind].slice(0, this.maxEntriesPerKind) : [];
            for (const entry of [...account[kind]].reverse()) this._applyAggregate(account, kind, entry);
          }
          migrated.accounts[key] = account;
        }
        return migrated;
      }
      return emptyStore();
    } catch {
      return emptyStore();
    }
  }

  _persist() {
    if (this.database) return;
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
    if (this.database) return;
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  recordEvent(accountName, type, details = {}) {
    return this.database?.recordEvent(accountName, type, details) || null;
  }

  listEvents(accountName, options = {}) {
    return this.database?.listEvents(accountName, options) || [];
  }

  listItems(accountName) {
    return this.database?.listItems(accountName) || [];
  }

  statistics(accountName, options = {}) {
    return this.database?.getStatistics(accountName, options) || null;
  }
}

module.exports = {
  ACTIVITY_HISTORY_SCHEMA_VERSION,
  ActivityHistoryStore,
  accountKey,
};
