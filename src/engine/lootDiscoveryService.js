const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getMonsterArea } = require('./monsterCatalog');
const { getDataPath } = require('../dataDirectory');
const {
  ReadPriority,
  WorldDomain,
  assertAccountKey,
  assertAccountScope,
  createCollectorResult,
} = require('./worldState');

const LOOT_DISCOVERY_SCHEMA_VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function accountKey(accountName) {
  return crypto.createHash('sha256').update(String(accountName || '')).digest('hex');
}

function stableCandidate(candidate = {}) {
  return {
    areaKey: String(candidate.areaKey || ''),
    monsterKey: String(candidate.monsterKey || ''),
    name: String(candidate.name || candidate.monsterName || ''),
    id: String(candidate.id || candidate.dgmid || candidate.battleId || ''),
    instanceId: candidate.instanceId == null ? null : String(candidate.instanceId),
    stackSize: Math.max(1, Math.trunc(Number(candidate.stackSize) || 1)),
    userDamage: Number.isFinite(Number(candidate.userDamage ?? candidate.userDmg)) ? Number(candidate.userDamage ?? candidate.userDmg) : null,
    expPerDamage: Number.isFinite(Number(candidate.expPerDamage)) ? Number(candidate.expPerDamage) : null,
    rewardsUpToLevel: Number.isFinite(Number(candidate.rewardsUpToLevel)) ? Number(candidate.rewardsUpToLevel) : null,
    verified: candidate.verified === true,
    rewardCapReached: candidate.rewardCapReached === true,
    eligible: candidate.eligible !== false,
    battleRef: candidate.battleRef || null,
  };
}

function semanticHash(candidates = []) {
  const serialized = candidates.map(candidate => JSON.stringify(stableCandidate(candidate))).sort();
  return crypto.createHash('sha256').update(`[${serialized.join(',')}]`).digest('hex');
}

function unavailableSnapshot(area, previous, refreshedAt, availability) {
  const hash = semanticHash([]);
  return {
    recognized: true,
    available: false,
    availability: clone(availability),
    areaKey: area.key,
    areaName: area.label || area.key,
    areaType: area.type || '',
    hash,
    changed: !previous || previous.hash !== hash || previous.available !== false,
    refreshedAt,
    candidates: [],
    enrichedByConfig: {},
    errors: [],
    summary: { actions: 0, kills: 0 },
  };
}

function projectLootableArea(catalog, snapshot) {
  if (!catalog?.area) throw new Error('Target area catalog is unavailable');
  const candidates = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
  const counts = new Map();
  const candidateTypes = new Map();
  for (const candidate of candidates) {
    const key = String(candidate.monsterKey || '');
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + Math.max(1, Math.trunc(Number(candidate.stackSize) || 1)));
    if (!candidateTypes.has(key)) candidateTypes.set(key, candidate);
  }
  const monsters = (catalog.monsters || []).map(monster => ({
    ...clone(monster),
    lootableCount: counts.get(String(monster.key || '')) || 0,
  }));
  const known = new Set(monsters.map(monster => String(monster.key || '')));
  for (const [key, candidate] of candidateTypes) {
    if (known.has(key)) continue;
    monsters.push({
      key,
      name: candidate.name || candidate.monsterName || key,
      boss: candidate.boss === true,
      bossEvidence: candidate.bossEvidence || null,
      instances: 0,
      aliveCount: 0,
      totalCount: 0,
      maxObservedCount: 0,
      statsAvailable: false,
      statsConflict: false,
      lootableCount: counts.get(key) || 0,
      remembered: true,
    });
  }
  return {
    ...clone(catalog),
    monsters,
    loot: {
      recognized: snapshot?.recognized === true,
      reportedUnclaimed: snapshot?.reportedUnclaimed ?? null,
      visibleLootable: candidates.reduce((total, candidate) => total + Math.max(1, Math.trunc(Number(candidate.stackSize) || 1)), 0),
      visibleLootActions: candidates.length,
    },
    message: catalog.message || '',
  };
}

class LootDiscoveryService {
  constructor(monsterCatalogService, accountName, filePath, options = {}) {
    this.monsterCatalogService = monsterCatalogService;
    this.accountName = accountName;
    this.filePath = filePath || getDataPath('loot_discovery.json');
    this.now = options.now || (() => Date.now());
    this.accountDatabase = options.accountDatabase || null;
    this.areaDirectoryService = options.areaDirectoryService || null;
    this.readCoordinator = options.readCoordinator || null;
    this.worldStateAccountKey = options.accountKey ? assertAccountKey(options.accountKey) : null;
    this.accountRef = this.worldStateAccountKey || this.accountName;
    this.mode = options.mode || 'shared';
    if (!['shared', 'legacy'].includes(this.mode)) throw new Error(`Unsupported Loot discovery mode: ${this.mode}`);
    if (this.mode === 'shared' && (!this.readCoordinator || !this.worldStateAccountKey
      || !this.areaDirectoryService || !this.accountDatabase)) {
      throw new TypeError('Shared Loot discovery requires ReadCoordinator, accountKey, AreaDirectoryService, and AccountDatabase');
    }
    this.sourceRevision = 0;
    this.inFlight = new Map();
    this.scanChain = Promise.resolve();
    this.data = this.accountDatabase ? null : this._read();
    this.accountDatabase?.importLegacyLootDiscovery?.(this.filePath);
  }

  list(areaKey = null) {
    if (areaKey) {
      if (this.mode === 'shared') {
        const observed = this.readCoordinator.peek(this.worldStateAccountKey, WorldDomain.LOOT_CANDIDATES, areaKey);
        if (observed?.value) return this._view(observed.value);
      }
      return this._view(this._saved(areaKey));
    }
    const snapshots = this.accountDatabase
      ? this.accountDatabase.listLootSnapshots(this.accountRef)
      : Object.values(this._account().areas);
    return snapshots
      .sort((a, b) => Number(b.refreshedAt || 0) - Number(a.refreshedAt || 0))
      .map(snapshot => this._view(snapshot));
  }

  async scan(areaKey, {
    force = false,
    maxAgeMs = 0,
    directoryPriority = ReadPriority.BACKGROUND,
    directoryMaxAgeMs = undefined,
    forceDirectory = false,
    signal = null,
  } = {}) {
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    let resolvedDirectory = null;
    if (area.type === 'dungeon' && this.areaDirectoryService) {
      try {
        resolvedDirectory = await this.areaDirectoryService.readDirectory({
          priority: directoryPriority,
          maxAgeMs: directoryMaxAgeMs,
          force: forceDirectory === true,
          signal,
        });
      } catch (error) {
        if (this.mode === 'shared' && error?.code !== 'READ_ABORTED' && error?.name !== 'AbortError') {
          this.invalidate(areaKey, 'loot directory refresh failed');
        }
        throw error;
      }
    }
    if (this.mode === 'shared') {
      try {
        const observed = await this.readCoordinator.read({
          accountKey: this.worldStateAccountKey,
          domain: WorldDomain.LOOT_CANDIDATES,
          resourceKey: areaKey,
          priority: directoryPriority,
          maxAgeMs,
          force,
          signal,
        });
        return this._view(observed?.value);
      } catch (error) {
        if (error?.code !== 'READ_ABORTED' && error?.name !== 'AbortError') {
          this.invalidate(areaKey, 'loot discovery refresh failed');
        }
        throw error;
      }
    }
    const saved = this._saved(areaKey);
    if (!force && saved && this.now() - Number(saved.refreshedAt || 0) < Math.max(0, maxAgeMs)) return this._view(saved);
    if (this.inFlight.has(areaKey)) return this._view(await this.inFlight.get(areaKey));
    const perform = async () => {
      let directoryInstances = null;
      if (area?.type === 'dungeon' && this.areaDirectoryService) {
        if (resolvedDirectory?.guildMember === false) {
          const snapshot = unavailableSnapshot(area, this._saved(areaKey), this.now(), {
            state: 'unavailable',
            available: false,
            verified: true,
            reason: resolvedDirectory.reason || 'not_in_guild',
            source: 'guild_dungeon.php',
          });
          this._save(areaKey, snapshot);
          return snapshot;
        }
        directoryInstances = resolvedDirectory?.instances
          || this.areaDirectoryService.peekDirectory?.()?.instances
          || [];
      }
      const result = await this.monsterCatalogService.discoverLootCandidates(areaKey, { directoryInstances });
      const candidates = Array.isArray(result.candidates) ? result.candidates.map(candidate => clone(candidate)) : [];
      const hash = semanticHash(candidates);
      const previous = this._saved(areaKey);
      const snapshot = {
        recognized: result.recognized === true,
        available: result.available !== false,
        availability: clone(result.availability || null),
        areaKey,
        areaName: result.area?.label || areaKey,
        areaType: result.area?.type || '',
        hash,
        changed: !previous || previous.hash !== hash,
        refreshedAt: this.now(),
        candidates: previous?.hash === hash ? previous.candidates : candidates,
        enrichedByConfig: previous?.hash === hash ? (previous.enrichedByConfig || {}) : {},
        errors: clone(result.errors || []),
      };
      this._save(areaKey, snapshot);
      return snapshot;
    };
    const scan = this._enqueue(perform);
    this.inFlight.set(areaKey, scan);
    try {
      return this._view(await scan);
    } finally {
      if (this.inFlight.get(areaKey) === scan) this.inFlight.delete(areaKey);
    }
  }

  async collect(request = {}) {
    if (this.mode !== 'shared') throw new Error('Legacy Loot discovery is not a shared collector');
    assertAccountScope(this.worldStateAccountKey, request.accountKey);
    const areaKey = request.resourceKey;
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    let directoryInstances = null;
    if (area.type === 'dungeon' && this.areaDirectoryService) {
      const directory = this.areaDirectoryService.peekDirectory();
      if (!directory) throw new Error('Dungeon directory must be resolved before Loot collection');
      if (directory.guildMember === false) {
        const snapshot = unavailableSnapshot(area, request.previous || this._saved(areaKey), this.now(), {
          state: 'unavailable',
          available: false,
          verified: true,
          reason: directory.reason || 'not_in_guild',
          source: 'guild_dungeon.php',
        });
        this._save(areaKey, snapshot);
        return createCollectorResult({
          accountKey: this.worldStateAccountKey,
          domain: WorldDomain.LOOT_CANDIDATES,
          resourceKey: areaKey,
          observation: this._view(snapshot),
          observedAt: Number(snapshot.refreshedAt),
          sourceRevision: ++this.sourceRevision,
          source: 'loot_discovery:no_guild',
        });
      }
      directoryInstances = directory.instances || [];
    }
    if (request.signal?.aborted) {
      const error = new Error('Loot discovery cancelled');
      error.name = 'AbortError';
      error.code = 'READ_ABORTED';
      throw error;
    }
    const result = await this.monsterCatalogService.discoverLootCandidates(areaKey, { directoryInstances });
    if (request.signal?.aborted) {
      const error = new Error('Loot discovery cancelled');
      error.name = 'AbortError';
      error.code = 'READ_ABORTED';
      throw error;
    }
    const candidates = Array.isArray(result.candidates) ? result.candidates.map(candidate => clone(candidate)) : [];
    const hash = semanticHash(candidates);
    const previous = request.previous || this._saved(areaKey);
    const saved = this._saved(areaKey);
    const snapshot = {
      recognized: result.recognized === true,
      available: result.available !== false,
      availability: clone(result.availability || null),
      areaKey,
      areaName: result.area?.label || areaKey,
      areaType: result.area?.type || '',
      hash,
      changed: !previous || previous.hash !== hash,
      refreshedAt: this.now(),
      candidates: previous?.hash === hash ? clone(previous.candidates || candidates) : candidates,
      enrichedByConfig: saved?.hash === hash ? clone(saved.enrichedByConfig || {}) : {},
      errors: clone(result.errors || []),
      summary: {
        actions: candidates.length,
        kills: candidates.reduce((total, candidate) => total + Math.max(1, Math.trunc(Number(candidate.stackSize) || 1)), 0),
      },
    };
    this._save(areaKey, snapshot);
    return createCollectorResult({
      accountKey: this.worldStateAccountKey,
      domain: WorldDomain.LOOT_CANDIDATES,
      resourceKey: areaKey,
      observation: this._view(snapshot),
      observedAt: Number(snapshot.refreshedAt),
      sourceRevision: ++this.sourceRevision,
      source: `loot_discovery:${area.type}`,
    });
  }

  invalidate(areaKey, reason = 'loot candidates invalidated') {
    if (this.mode !== 'shared') return false;
    return this.readCoordinator.invalidate(
      this.worldStateAccountKey,
      WorldDomain.LOOT_CANDIDATES,
      areaKey,
      reason,
    );
  }

  async whenIdle(maxWaitMs = 15000) {
    let timer = null;
    await Promise.race([
      this.scanChain.catch(() => null),
      new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, Number(maxWaitMs) || 0)); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  purgeAccount(accountName = this.accountRef) {
    if (!accountName) return false;
    if (this.accountDatabase) return this.accountDatabase.clearLootSnapshots(accountName);
    const key = accountKey(accountName);
    if (!this.data.accounts[key]) return false;
    delete this.data.accounts[key];
    this._write();
    return true;
  }

  async progressionCandidates(areaKey, configuredLoot = null, options = {}) {
    const snapshot = await this.scan(areaKey, options);
    const candidates = this._filterConfigured(snapshot.candidates || [], configuredLoot);
    const signature = semanticHash(candidates);
    const saved = this._saved(areaKey);
    const cached = saved?.enrichedByConfig?.[signature];
    if (cached) return clone(cached);
    const enriched = await this._enqueue(() => this.monsterCatalogService.enrichProgressionLootCandidates({
      area: { key: snapshot.areaKey, label: snapshot.areaName, type: snapshot.areaType },
      candidates,
      errors: snapshot.errors || [],
    }, null));
    const result = { ...enriched, hash: snapshot.hash, refreshedAt: snapshot.refreshedAt };
    saved.enrichedByConfig ||= {};
    saved.enrichedByConfig[signature] = clone(result);
    const keys = Object.keys(saved.enrichedByConfig);
    for (const key of keys.slice(0, Math.max(0, keys.length - 3))) delete saved.enrichedByConfig[key];
    this._save(areaKey, saved);
    return clone(result);
  }

  _filterConfigured(candidates, configuredLoot) {
    if (!configuredLoot) return clone(candidates);
    const used = new Map();
    return candidates.filter(candidate => {
      const settings = configuredLoot[candidate.monsterKey];
      if (settings?.enabled !== true) return false;
      if (settings.unlimited === true) return true;
      const available = Math.max(0, Math.trunc(Number(settings.maxLooting) || 0) - Math.trunc(Number(settings.lootedCount) || 0));
      const next = (used.get(candidate.monsterKey) || 0) + Math.max(1, Math.trunc(Number(candidate.stackSize) || 1));
      if (next > available) return false;
      used.set(candidate.monsterKey, next);
      return true;
    }).map(candidate => clone(candidate));
  }

  _enqueue(work) {
    const operation = this.scanChain.catch(() => null).then(work);
    this.scanChain = operation.catch(() => null);
    return operation;
  }

  _view(snapshot) {
    if (!snapshot) return null;
    const { enrichedByConfig: _privateCache, ...view } = snapshot;
    return clone(view);
  }

  _account() {
    const key = accountKey(this.accountName);
    this.data.accounts[key] ||= { areas: {} };
    return this.data.accounts[key];
  }

  _saved(areaKey) {
    return this.accountDatabase
      ? this.accountDatabase.getLootSnapshot(this.accountRef, areaKey)
      : this._account().areas[areaKey];
  }

  _save(areaKey, snapshot) {
    if (this.accountDatabase) {
      this.accountDatabase.setLootSnapshot(this.accountRef, areaKey, snapshot);
      return;
    }
    this._account().areas[areaKey] = snapshot;
    this._write();
  }

  _read() {
    try {
      if (!fs.existsSync(this.filePath)) return { schemaVersion: LOOT_DISCOVERY_SCHEMA_VERSION, accounts: {} };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed?.schemaVersion === LOOT_DISCOVERY_SCHEMA_VERSION && parsed.accounts && typeof parsed.accounts === 'object') return parsed;
    } catch {
      // A corrupt optional cache is safely rebuilt from authenticated pages.
    }
    return { schemaVersion: LOOT_DISCOVERY_SCHEMA_VERSION, accounts: {} };
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
  LOOT_DISCOVERY_SCHEMA_VERSION,
  LootDiscoveryService,
  projectLootableArea,
  semanticHash,
};
