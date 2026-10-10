const {
  SINGLETON_DOMAINS,
  WorldDomain,
  applyWorldPatch,
  createEmptyWorldSnapshot,
  createWorldPatch,
} = require('./contracts');
const { FreshnessState } = require('./freshnessPolicy');
const { assertAccountKey, assertAccountScope } = require('./identity');

const MAP_DOMAIN_PATHS = Object.freeze({
  [WorldDomain.AREA_DEFINITIONS]: ['areas', 'definitions'],
  [WorldDomain.AREA_INSTANCES]: ['areas', 'instances'],
  [WorldDomain.MONSTER_TYPES]: ['areas', 'monsterTypes'],
  [WorldDomain.MONSTER_INSTANCES]: ['areas', 'monsterInstances'],
  [WorldDomain.LOOT_CANDIDATES]: ['lootCandidates'],
  [WorldDomain.ADVENTURE_QUESTS]: ['objectives', 'adventureQuests'],
  [WorldDomain.CUBE]: ['cube'],
  [WorldDomain.LOADOUT]: ['loadout'],
  [WorldDomain.SOLO_PVP]: ['soloPvp'],
});

const SINGLETON_DOMAIN_PATHS = Object.freeze({
  [WorldDomain.STATS]: ['stats'],
  [WorldDomain.BATTLE_PASS]: ['objectives', 'battlePass'],
  [WorldDomain.AUTO_FARM]: ['autoFarm'],
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function worldStateError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function atPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function resourceValue(snapshot, domain, resourceKey) {
  const singletonPath = SINGLETON_DOMAIN_PATHS[domain];
  if (singletonPath) return resourceKey === 'current' ? atPath(snapshot, singletonPath) : null;
  const mapPath = MAP_DOMAIN_PATHS[domain];
  if (!mapPath) return null;
  return atPath(snapshot, mapPath)?.[resourceKey] || null;
}

function resourceContainer(snapshot, domain) {
  const path = MAP_DOMAIN_PATHS[domain];
  return path ? atPath(snapshot, path) : null;
}

function filterMatches(filter, event) {
  if (!filter) return true;
  if (typeof filter === 'function') return filter(event.changes, event) !== false;
  const domains = Array.isArray(filter.domains) ? new Set(filter.domains) : null;
  const resourceKeys = Array.isArray(filter.resourceKeys) ? new Set(filter.resourceKeys) : null;
  return event.changes.some(change => (
    (!domains || domains.has(change.domain))
    && (!resourceKeys || resourceKeys.has(change.resourceKey))
  ));
}

class WorldStateService {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.accounts = new Map();
    this.subscriptions = new Map();
    this.nextSubscriptionId = 1;
    this.disposed = false;
    this.diagnostics = {
      patchesApplied: 0,
      batchesApplied: 0,
      stalePatchesDropped: 0,
      invalidations: 0,
      resourcesPruned: 0,
      subscriberErrors: 0,
      accountsDropped: 0,
    };
  }

  _assertActive() {
    if (this.disposed) throw worldStateError('WORLD_STATE_DISPOSED', 'World State service is disposed');
  }

  _requireAccount(accountKey) {
    this._assertActive();
    const key = assertAccountKey(accountKey);
    const snapshot = this.accounts.get(key);
    if (!snapshot) throw worldStateError('WORLD_STATE_ACCOUNT_MISMATCH', 'World State account is not registered');
    return snapshot;
  }

  ensureAccount(accountKey, { displayName = '' } = {}) {
    this._assertActive();
    const key = assertAccountKey(accountKey);
    if (!this.accounts.has(key)) {
      this.accounts.set(key, createEmptyWorldSnapshot(key, displayName));
    } else if (displayName && this.accounts.get(key).account.displayName !== String(displayName)) {
      const next = clone(this.accounts.get(key));
      next.account.displayName = String(displayName);
      this.accounts.set(key, next);
    }
    return this.getSnapshot(key);
  }

  hasAccount(accountKey) {
    this._assertActive();
    return this.accounts.has(assertAccountKey(accountKey));
  }

  getSnapshot(accountKey) {
    this._assertActive();
    const snapshot = this.accounts.get(assertAccountKey(accountKey));
    return snapshot ? clone(snapshot) : null;
  }

  peek(accountKey, domain, resourceKey = 'current') {
    this._assertActive();
    const snapshot = this.accounts.get(assertAccountKey(accountKey));
    if (!snapshot) return null;
    const value = resourceValue(snapshot, domain, resourceKey);
    if (!value) return null;
    return {
      value: clone(value),
      meta: clone(value.meta || snapshot.observationIndex[`${domain}\u0000${resourceKey}`] || null),
      revision: snapshot.revision,
    };
  }

  applyPatch(patch) {
    return this.applyBatch(patch?.accountKey, [patch]);
  }

  applyBatch(accountKey, patches = []) {
    const current = this._requireAccount(accountKey);
    const key = current.account.accountKey;
    if (!Array.isArray(patches)) throw new TypeError('World State batch must be an array');
    if (patches.length === 0) return { applied: false, changes: [], snapshot: clone(current) };

    let next = current;
    const changes = [];
    let staleDropped = 0;
    for (const rawPatch of patches) {
      const patch = createWorldPatch(rawPatch);
      assertAccountScope(key, patch.accountKey);
      const result = applyWorldPatch(next, patch);
      if (!result.applied) {
        if (result.reason === 'stale_observation') staleDropped += 1;
        continue;
      }
      next = result.snapshot;
      changes.push({ domain: patch.domain, resourceKey: patch.resourceKey, operation: patch.operation });
    }

    this.diagnostics.stalePatchesDropped += staleDropped;
    if (changes.length === 0) return { applied: false, changes: [], snapshot: clone(current) };
    this.accounts.set(key, next);
    this.diagnostics.patchesApplied += changes.length;
    this.diagnostics.batchesApplied += 1;
    this._notify(key, changes, next);
    return { applied: true, changes: clone(changes), snapshot: clone(next) };
  }

  invalidate(accountKey, domain, resourceKey = 'current', reason = 'invalidated') {
    const current = this._requireAccount(accountKey);
    const value = resourceValue(current, domain, resourceKey);
    if (!value) return false;
    const next = clone(current);
    const target = resourceValue(next, domain, resourceKey);
    const invalidatedAt = Number(this.now());
    target.meta ||= {};
    if (target.meta.freshness === FreshnessState.STALE && target.meta.invalidationReason === String(reason)) return false;
    target.meta.freshness = FreshnessState.STALE;
    target.meta.staleAt = invalidatedAt;
    target.meta.invalidationReason = String(reason || 'invalidated');
    const indexKey = `${domain}\u0000${resourceKey}`;
    next.observationIndex[indexKey] = { ...(next.observationIndex[indexKey] || target.meta), ...target.meta };
    next.revision += 1;
    this.accounts.set(current.account.accountKey, next);
    this.diagnostics.invalidations += 1;
    this._notify(current.account.accountKey, [{ domain, resourceKey, operation: 'invalidate' }], next);
    return true;
  }

  subscribe(accountKey, listener, filter = null) {
    this._requireAccount(accountKey);
    if (typeof listener !== 'function') throw new TypeError('World State subscriber must be a function');
    const key = assertAccountKey(accountKey);
    const id = this.nextSubscriptionId++;
    if (!this.subscriptions.has(key)) this.subscriptions.set(key, new Map());
    this.subscriptions.get(key).set(id, { listener, filter });
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      const accountSubscriptions = this.subscriptions.get(key);
      const removed = accountSubscriptions?.delete(id) || false;
      if (accountSubscriptions?.size === 0) this.subscriptions.delete(key);
      return removed;
    };
  }

  _notify(accountKey, changes, snapshot) {
    const subscribers = [...(this.subscriptions.get(accountKey)?.values() || [])];
    if (subscribers.length === 0) return;
    const baseEvent = { accountKey, revision: snapshot.revision, changes: clone(changes), snapshot: clone(snapshot) };
    for (const { listener, filter } of subscribers) {
      try {
        const event = clone(baseEvent);
        if (!filterMatches(filter, event)) continue;
        listener(event);
      } catch {
        this.diagnostics.subscriberErrors += 1;
      }
    }
  }

  prune(accountKey, predicate) {
    const current = this._requireAccount(accountKey);
    if (typeof predicate !== 'function') throw new TypeError('World State prune predicate must be a function');
    const patches = [];
    for (const [domain, path] of Object.entries(MAP_DOMAIN_PATHS)) {
      const container = atPath(current, path) || {};
      for (const [resourceKey, value] of Object.entries(container)) {
        if (!predicate(clone(value), { domain, resourceKey })) continue;
        const previousMeta = current.observationIndex[`${domain}\u0000${resourceKey}`] || value.meta || {};
        const observedAt = Math.max(Number(this.now()) || 0, Number(previousMeta.observedAt) || 0);
        patches.push(createWorldPatch({
          accountKey: current.account.accountKey,
          domain,
          resourceKey,
          operation: 'remove',
          observedAt,
          sourceRevision: (Number(previousMeta.sourceRevision) || 0) + 1,
          source: 'world_state:prune',
        }));
      }
    }
    if (patches.length === 0) return 0;
    const result = this.applyBatch(current.account.accountKey, patches);
    this.diagnostics.resourcesPruned += result.changes.length;
    return result.changes.length;
  }

  dropAccount(accountKey) {
    this._assertActive();
    const key = assertAccountKey(accountKey);
    const existed = this.accounts.delete(key);
    this.subscriptions.delete(key);
    if (existed) this.diagnostics.accountsDropped += 1;
    return existed;
  }

  getDiagnostics() {
    return {
      ...clone(this.diagnostics),
      accounts: this.accounts.size,
      subscriptions: [...this.subscriptions.values()].reduce((total, entries) => total + entries.size, 0),
      disposed: this.disposed,
    };
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    this.accounts.clear();
    this.subscriptions.clear();
    return true;
  }
}

module.exports = {
  WorldStateService,
  worldStateError,
};
