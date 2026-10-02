const fs = require('fs');
const path = require('path');
const { getMonsterArea, monsterTypeKey, supportsAutoFarm } = require('./monsterCatalog');
const { unavailableWaveError } = require('./areaAccessService');
const { getDataDir } = require('../main/dataPaths');

const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_BASE_PATH = path.join(__dirname, '..', 'catalogs', 'monsterStats.json');
const DEFAULT_CACHE_PATH = path.join(getDataDir(), 'monster_stats_cache.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyCatalog() {
  return { schemaVersion: CATALOG_SCHEMA_VERSION, monsters: {} };
}

function readCatalog(filePath) {
  try {
    if (!fs.existsSync(filePath)) return emptyCatalog();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.schemaVersion !== CATALOG_SCHEMA_VERSION || !parsed.monsters || typeof parsed.monsters !== 'object') {
      return emptyCatalog();
    }
    return parsed;
  } catch {
    return emptyCatalog();
  }
}

function statsFingerprint(stats) {
  return JSON.stringify(stats);
}

function hasFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

class MonsterCatalogService {
  constructor(gameAPI, options = {}) {
    this.gameAPI = gameAPI;
    this.basePath = options.basePath || DEFAULT_BASE_PATH;
    this.cachePath = options.cachePath || DEFAULT_CACHE_PATH;
    this.baseCatalog = readCatalog(this.basePath);
    // The old runtime cache has no trustworthy account owner. Keep it
    // readable only for isolated legacy/test construction; authenticated
    // production services use AccountDatabase exclusively.
    this.cacheCatalog = options.accountDatabase ? emptyCatalog() : readCatalog(this.cachePath);
    this.liveInstances = new Map();
    this.liveAreaMonsters = new Map();
    // Exact battle-page observations are the authority for monster PvP
    // phases. Wave cards do not always expose a phase marker (some Event
    // bosses still report data-boss="0"), so keep the verified phase on the
    // current account's concrete instance instead of relying on historical
    // catalog data or persisting the temporary battle ID globally.
    this.phaseDuelInstances = new Map();
    this.rewardInfoCache = new Map();
    this.accountDatabase = options.accountDatabase || null;
    this.accountName = options.accountName || null;
    this.accountKey = options.accountKey || null;
    this.accountRef = this.accountKey || this.accountName;
    this.levelProvider = typeof options.levelProvider === 'function' ? options.levelProvider : (() => null);
    this.areaAccessService = options.areaAccessService || null;
  }

  setGameAPI(gameAPI) {
    this.gameAPI = gameAPI;
    this.liveInstances.clear();
    this.liveAreaMonsters.clear();
    this.phaseDuelInstances.clear();
    this.rewardInfoCache.clear();
  }

  _phaseDuelInstanceKey(areaKey, monsterId) {
    return `${String(areaKey || '')}\u0000${String(monsterId || '')}`;
  }

  _withVerifiedPhase(areaKey, monster) {
    const monsterId = String(monster?.battleId || monster?.id || monster?.dgmid || '');
    const verified = monsterId
      ? this.phaseDuelInstances.get(this._phaseDuelInstanceKey(areaKey, monsterId))
      : null;
    if (!verified) return monster;
    return {
      ...monster,
      phase: verified.phase,
      boss: false,
      bossEvidence: null,
      runtimePhase: true,
    };
  }

  markPhaseDuel(areaKey, monsterId, phase = 3) {
    const id = String(monsterId || '');
    const phaseNumber = Math.max(1, Math.trunc(Number(phase) || 0));
    if (!areaKey || !/^\d{1,30}$/.test(id) || phaseNumber < 1) return false;
    this.phaseDuelInstances.set(this._phaseDuelInstanceKey(areaKey, id), {
      phase: phaseNumber,
      observedAt: Date.now(),
    });

    const live = this.liveAreaMonsters.get(areaKey) || [];
    let monsterKey = null;
    this.liveAreaMonsters.set(areaKey, live.map(monster => {
      const currentId = String(monster?.battleId || monster?.id || monster?.dgmid || '');
      if (currentId !== id) return monster;
      monsterKey = monster.monsterKey || monsterTypeKey(monster.name);
      return this._withVerifiedPhase(areaKey, monster);
    }));
    if (monsterKey) {
      const type = this.liveInstances.get(areaKey)?.get(monsterKey);
      if (type) Object.assign(type, { phase: phaseNumber, boss: false, bossEvidence: null });
    }
    return true;
  }

  observeAutoFarmTypes(types) {
    return this.accountDatabase?.observeAutoFarmTypes(this.accountRef, types) || [];
  }

  resolveAutoFarmArea(typeId, name) {
    return this.accountDatabase?.resolveAutoFarmArea(this.accountRef, typeId, name) || null;
  }

  _observedPlayerLevel() {
    const raw = this.levelProvider();
    if (raw === null || raw === undefined || raw === '') return null;
    const level = Math.trunc(Number(raw));
    return Number.isFinite(level) && level > 0 ? level : null;
  }

  _getAccountFact(areaKey, monsterKey) {
    if (!this.accountDatabase || !this.accountRef) return null;
    const area = getMonsterArea(areaKey);
    const playerLevel = area?.type === 'event' ? this._observedPlayerLevel() : null;
    return this.accountDatabase.getMonsterFact(
      this.accountRef,
      areaKey,
      monsterTypeKey(monsterKey),
      playerLevel ? { eventKey: areaKey, level: playerLevel } : {},
    );
  }

  getRecord(areaKey, monsterKey) {
    const key = monsterTypeKey(monsterKey);
    const accountType = this.accountDatabase && this.accountRef
      ? this.accountDatabase.listMonsterTypes(this.accountRef, areaKey)
        .find(type => monsterTypeKey(type.monsterKey || type.canonicalName) === key)
      : null;
    const accountFact = this._getAccountFact(areaKey, key);
    const legacyRecord = !this.accountDatabase ? this.cacheCatalog.monsters?.[areaKey]?.[key] : null;
    const baseline = this.baseCatalog.monsters?.[areaKey]?.[key] || null;
    const record = this.accountDatabase
      ? ((accountType || accountFact || baseline) ? {
          ...(baseline || {}),
          ...(accountType ? {
            areaKey,
            monsterKey: key,
            name: accountType.canonicalName,
            phase: accountType.phase,
            boss: accountType.boss,
            bossEvidence: accountType.bossEvidence,
            maxObservedCount: accountType.maxObservedCount,
          } : {}),
          ...(accountFact || {}),
        } : null)
      : (legacyRecord || baseline || null);
    return record ? clone(record) : null;
  }

  _getGateLikeSnapshot(area, lootable = false) {
    if (area.eventId) {
      return lootable
        ? this.gameAPI.getLootableEventWaveSnapshot(area.eventId, area.wave)
        : this.gameAPI.getEventWaveSnapshot(area.eventId, area.wave);
    }
    return lootable
      ? this.gameAPI.getLootableWaveSnapshot(area.gateId, area.wave)
      : this.gameAPI.getWaveSnapshot(area.gateId, area.wave);
  }

  async listArea(areaKey, options = {}) {
    const area = getMonsterArea(areaKey);
    if (area?.type === 'dungeon') return this._listDungeonArea(areaKey, {
      lootDiscovery: false,
      directoryInstances: options.directoryInstances,
    });
    return this._listGateAreaWithAccess(areaKey, { lootDiscovery: false, forceAccess: options.forceAccess === true });
  }

  async listLootableArea(areaKey, options = {}) {
    const area = getMonsterArea(areaKey);
    if (area?.type === 'dungeon') return this._listDungeonArea(areaKey, {
      lootDiscovery: true,
      directoryInstances: options.directoryInstances,
    });
    return this._listGateAreaWithAccess(areaKey, { lootDiscovery: true, forceAccess: options.forceAccess === true });
  }

  async _listGateAreaWithAccess(areaKey, { lootDiscovery, forceAccess = false }) {
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    const access = this.areaAccessService
      ? await this.areaAccessService.checkArea(area, { force: forceAccess })
      : { available: true };
    if (access.available === false) return this.unavailableArea(areaKey, access);
    try {
      const result = await this._listGateArea(areaKey, { lootDiscovery });
      this.areaAccessService?.markAvailable(area);
      return { ...result, availability: { available: true, verified: access.verified === true } };
    } catch (error) {
      if (!this.areaAccessService || !unavailableWaveError(error)) throw error;
      return this.unavailableArea(areaKey, this.areaAccessService.markUnavailable(area, error));
    }
  }

  unavailableArea(areaKey, access, message = null) {
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    const byType = new Map();
    this._mergeRememberedTypes(areaKey, byType);
    this.liveAreaMonsters.set(areaKey, []);
    this.liveInstances.set(areaKey, new Map([...byType].map(([key, monster]) => [key, { ...monster }])));
    return {
      area,
      sourceAvailable: false,
      availability: clone(access),
      message: message || access?.reason || `${area.label} is not currently available to this account.`,
      resources: {},
      autoFarmAvailableMonsters: [],
      autoFarmCatalog: { source: 'unavailable', detail: '', error: '' },
      monsters: [...byType.values()].map(({ monsterId, ...monster }) => monster),
      loot: { recognized: true, reportedUnclaimed: 0, visibleLootable: 0, visibleLootActions: 0 },
    };
  }

  getAreaAvailability(areaKey) {
    return this.areaAccessService?.getAreaState(areaKey) || null;
  }

  async _listGateArea(areaKey, { lootDiscovery }) {
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    if (!this.gameAPI) throw new Error('Game session not active');

    let snapshot;
    const supportsLootDiscovery = area.eventId
      ? typeof this.gameAPI.getLootableEventWaveSnapshot === 'function'
      : typeof this.gameAPI.getLootableWaveSnapshot === 'function';
    if (lootDiscovery && supportsLootDiscovery) {
      const [liveSnapshot, lootSnapshot] = await Promise.all([
        this._getGateLikeSnapshot(area, false),
        this._getGateLikeSnapshot(area, true),
      ]);
      snapshot = {
        resources: liveSnapshot.resources || lootSnapshot.resources,
        autoSummonBossNames: liveSnapshot.autoSummonBossNames || lootSnapshot.autoSummonBossNames || [],
        autoFarmAvailableMonsters: liveSnapshot.autoFarmAvailableMonsters || [],
        // Looting is a configuration catalog, not a dead-only result list.
        // Include every currently alive type plus types represented by an
        // explicit claimable card. Saved rows are merged by the renderer.
        monsters: [
          ...(liveSnapshot.monsters || []).filter(monster => monster.dead !== true),
          ...(lootSnapshot.loot?.monsters || []),
        ],
        loot: lootSnapshot.loot,
      };
    } else {
      snapshot = await this._getGateLikeSnapshot(area, false);
    }
    snapshot = {
      ...snapshot,
      monsters: (snapshot.monsters || []).map(monster => this._withVerifiedPhase(areaKey, monster)),
    };
    if (!lootDiscovery) {
      const currentIds = new Set(snapshot.monsters.map(monster => String(
        monster?.battleId || monster?.id || monster?.dgmid || '',
      )).filter(Boolean));
      const prefix = `${String(areaKey)}\u0000`;
      for (const key of this.phaseDuelInstances.keys()) {
        if (key.startsWith(prefix) && !currentIds.has(key.slice(prefix.length))) {
          this.phaseDuelInstances.delete(key);
        }
      }
    }
    // The checkbox list is global panel state. Observe its stable numeric IDs,
    // but relate them to this area only through the account database's unique
    // normalized-name match against independently discovered area monsters.
    const autoFarmMappingDeferred = !lootDiscovery && supportsAutoFarm(area);
    let globalAutoFarmTypes = clone(snapshot.autoFarmAvailableMonsters || []);
    let autoFarmReadError = null;
    if (autoFarmMappingDeferred && this.accountDatabase && globalAutoFarmTypes.length === 0
      && typeof this.gameAPI.fetchAutoFarmState === 'function') {
      try {
        const state = await this.gameAPI.fetchAutoFarmState(area);
        globalAutoFarmTypes = clone(state.availableMonsters || state.monsters || []);
      } catch (error) {
        autoFarmReadError = error.message;
      }
    }
    const lootableByType = new Map();
    for (const monster of snapshot.loot?.monsters || []) {
      const key = monsterTypeKey(monster.name);
      if (key) lootableByType.set(key, (lootableByType.get(key) || 0) + Math.max(1, Number(monster.stackSize) || 1));
    }
    const byType = new Map();
    const seenInstances = new Set();
    for (const [instanceIndex, monster] of snapshot.monsters.entries()) {
      const instanceId = String(monster.battleId || monster.id || monster.dgmid || '');
      const instanceIdentity = instanceId ? `id:${instanceId}` : `anonymous:${instanceIndex}`;
      if (seenInstances.has(instanceIdentity)) continue;
      seenInstances.add(instanceIdentity);
      const key = monsterTypeKey(monster.name);
      if (!key) continue;
      const existing = byType.get(key);
      if (existing) {
        existing.instances += 1;
        existing.aliveCount += monster.dead === true ? 0 : 1;
        existing.totalCount += 1;
        existing.boss = existing.boss || Boolean(monster.boss);
        if (monster.bossEvidence) existing.bossEvidence = monster.bossEvidence;
        if (monster.phase) existing.phase = Number(monster.phase);
        existing.runtimePhase = existing.runtimePhase === true || monster.runtimePhase === true;
        if (!existing.monsterId && (monster.battleId || monster.id)) {
          existing.monsterId = String(monster.battleId || monster.id);
        }
      } else {
        const record = this.getRecord(areaKey, key);
        byType.set(key, {
          key,
          name: monster.name,
          phase: Number(monster.phase) || null,
          runtimePhase: monster.runtimePhase === true,
          boss: Boolean(monster.boss),
          bossEvidence: monster.bossEvidence || (monster.boss ? 'server' : null),
          instances: 1,
          aliveCount: monster.dead === true ? 0 : 1,
          totalCount: 1,
          monsterId: monster.battleId || monster.id ? String(monster.battleId || monster.id) : null,
          statsAvailable: Boolean(record?.stats),
          statsConflict: Boolean(record?.conflict),
          lootableCount: lootableByType.get(key) || 0,
        });
      }
    }
    for (const monster of snapshot.loot?.monsters || []) {
      const key = monsterTypeKey(monster.name);
      if (!key || byType.has(key)) continue;
      const record = this.getRecord(areaKey, key);
      byType.set(key, {
        key,
        name: monster.name,
        phase: Number(monster.phase) || null,
        boss: Boolean(monster.boss),
        bossEvidence: monster.bossEvidence || (monster.boss ? 'server' : null),
        instances: 0,
        aliveCount: 0,
        totalCount: 1,
        monsterId: monster.battleId || monster.id ? String(monster.battleId || monster.id) : null,
        statsAvailable: Boolean(record?.stats),
        statsConflict: Boolean(record?.conflict),
        lootableCount: lootableByType.get(key) || 0,
      });
    }
    for (const bossName of snapshot.autoSummonBossNames || []) {
      const key = monsterTypeKey(bossName);
      if (!key) continue;
      const existing = byType.get(key);
      if (existing) {
        existing.boss = true;
        existing.bossEvidence = 'auto_summon';
        continue;
      }
      const record = this.getRecord(areaKey, key);
      byType.set(key, {
        key,
        name: bossName,
        boss: true,
        bossEvidence: 'auto_summon',
        instances: 0,
        aliveCount: 0,
        totalCount: 1,
        monsterId: null,
        statsAvailable: Boolean(record?.stats),
        statsConflict: Boolean(record?.conflict),
        lootableCount: lootableByType.get(key) || 0,
      });
    }
    // Dead-card discovery is historical inventory, not a live population.
    // Persisting those counts made 4 living monsters appear as 4/15 after a
    // loot scan. Only the ordinary live view may advance availability peaks.
    if (!lootDiscovery) {
      this._applyObservedMetadata(areaKey, byType);
      this._rememberTypes(areaKey, area, byType.values());
    } else {
      this._rememberTypes(areaKey, area, [...byType.values()].map(monster => ({
        ...monster,
        instances: 0,
        aliveCount: 0,
        totalCount: 0,
        maxObservedCount: 0,
      })));
    }
    // Only ordinary target discovery may replace live battle instances. Loot
    // discovery intentionally exposes dead cards whose IDs are not attackable.
    if (!lootDiscovery) {
      this.liveAreaMonsters.set(areaKey, (snapshot.monsters || []).map(monster => ({
        ...clone(monster),
        areaKey,
        monsterKey: monsterTypeKey(monster.name),
        battleRef: monster.battleRef || monster.battleId || monster.id || null,
      })));
      this.liveInstances.set(
        areaKey,
        new Map([...byType].map(([key, monster]) => [key, { ...monster }])),
      );
    }
    this._mergeRememberedTypes(areaKey, byType);
    if (this.accountDatabase && globalAutoFarmTypes.length > 0) this.observeAutoFarmTypes(globalAutoFarmTypes);
    const mappedAutoFarmTypes = autoFarmMappingDeferred
      ? (this.accountDatabase?.getAutoFarmTypesForArea(this.accountRef, areaKey) || [])
      : [];
    return {
      area,
      sourceAvailable: true,
      resources: snapshot.resources,
      autoFarmAvailableMonsters: clone(mappedAutoFarmTypes),
      autoFarmCatalog: {
        source: mappedAutoFarmTypes.length > 0 ? 'database' : (autoFarmMappingDeferred ? 'deferred' : 'unavailable'),
        detail: mappedAutoFarmTypes.length > 0
          ? 'Verified by a unique account-database name-to-area observation'
          : (autoFarmMappingDeferred ? 'Awaiting an unambiguous account database monster-to-area observation' : ''),
        error: autoFarmMappingDeferred
          ? (mappedAutoFarmTypes.length > 0 ? ''
            : `The server exposes static monster IDs without an unambiguous Gate/Event ownership match${autoFarmReadError ? ` (${autoFarmReadError})` : ''}.`)
          : '',
      },
      monsters: [...byType.values()].map(({ monsterId, ...monster }) => monster),
      loot: {
        recognized: snapshot.loot?.recognized === true,
        reportedUnclaimed: snapshot.loot?.reportedUnclaimed ?? null,
        visibleLootable: snapshot.loot?.visibleLootable || 0,
        visibleLootActions: snapshot.loot?.visibleLootActions || 0,
      },
    };
  }

  async _listDungeonArea(areaKey, { lootDiscovery, directoryInstances = null }) {
    const area = getMonsterArea(areaKey);
    if (!area || area.type !== 'dungeon') throw new Error('Unknown dungeon area');
    if (!this.gameAPI) throw new Error('Game session not active');
    const snapshot = areaKey === 'polyhedral_crucible'
      ? await this.gameAPI.getCubeSnapshot({ includeCleared: lootDiscovery, directoryInstances })
      : await this.gameAPI.getDungeonSnapshot(area.label, { includePrevious: lootDiscovery, directoryInstances });
    const allInstances = Array.isArray(snapshot.monsters) ? snapshot.monsters : [];
    const byType = new Map();
    for (const monster of allInstances) {
      const key = monsterTypeKey(monster.name);
      if (!key) continue;
      const alive = monster.dead !== true && Number(monster.hp) > 0;
      const attackable = alive && monster.attackable !== false;
      const inlineStats = Object.fromEntries(Object.entries({
        maxHp: monster.maxHp,
        attack: monster.attack,
        defense: monster.defense,
        expPerDamage: monster.expPerDamage,
      }).filter(([, value]) => Number.isFinite(Number(value))));
      const existing = byType.get(key);
      if (existing) {
        existing.instances += attackable ? 1 : 0;
        existing.aliveCount += alive ? 1 : 0;
        existing.totalCount += 1;
        existing.lootableCount += monster.lootable ? 1 : 0;
        existing.boss = existing.boss || Boolean(monster.boss);
        if (monster.boss) existing.bossEvidence = 'server';
        if (!existing.inlineStats && Object.keys(inlineStats).length > 0) existing.inlineStats = inlineStats;
        if (!existing.monsterId && monster.battleRef) {
          existing.monsterId = String(monster.dgmid || monster.id);
          existing.battleRef = clone(monster.battleRef);
        }
      } else {
        const record = this.getRecord(areaKey, key);
        byType.set(key, {
          key,
          name: monster.name,
          boss: Boolean(monster.boss),
          bossEvidence: monster.boss ? 'server' : null,
          instances: attackable ? 1 : 0,
          aliveCount: alive ? 1 : 0,
          totalCount: 1,
          monsterId: monster.battleRef ? String(monster.dgmid || monster.id) : null,
          battleRef: monster.battleRef ? clone(monster.battleRef) : null,
          inlineStats: Object.keys(inlineStats).length > 0 ? inlineStats : null,
          statsAvailable: Boolean(record?.stats) || Object.keys(inlineStats).length > 0,
          statsConflict: Boolean(record?.conflict),
          lootableCount: monster.lootable ? 1 : 0,
          instanceName: snapshot.dungeon?.name || area.label,
        });
      }
    }
    if (!lootDiscovery) {
      this._applyObservedMetadata(areaKey, byType);
      this.liveAreaMonsters.set(areaKey, allInstances.map(monster => ({ ...clone(monster), areaKey, monsterKey: monsterTypeKey(monster.name) })));
      this.liveInstances.set(areaKey, new Map([...byType].map(([key, monster]) => [key, { ...monster }])));
      this._rememberTypes(areaKey, area, byType.values(), snapshot.dungeon);
    } else {
      this._rememberTypes(areaKey, area, [...byType.values()].map(monster => ({
        ...monster,
        instances: 0,
        aliveCount: 0,
        totalCount: 0,
        maxObservedCount: 0,
      })), snapshot.dungeon);
    }
    this._mergeRememberedTypes(areaKey, byType);
    return {
      area,
      sourceAvailable: true,
      resources: snapshot.resources || {},
      instance: snapshot.dungeon || null,
      locations: snapshot.locations || [],
      monsters: [...byType.values()].map(({ monsterId, battleRef, inlineStats, ...monster }) => monster),
      loot: {
        recognized: true,
        reportedUnclaimed: null,
        visibleLootable: allInstances.filter(monster => monster.lootable).length,
        visibleLootActions: allInstances.filter(monster => monster.lootable).length,
      },
      message: snapshot.message || '',
    };
  }

  getLiveMonsters(areaKey) {
    return clone(this.liveAreaMonsters.get(areaKey) || []);
  }

  async discoverLootCandidates(areaKey, options = {}) {
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    if (!this.gameAPI) throw new Error('Game session not active');

    let rawCandidates = [];
    let discoveryErrors = [];
    const isGateLike = area.type === 'gate' || area.type === 'event';
    if (isGateLike) {
      const access = this.areaAccessService ? await this.areaAccessService.checkArea(area) : { available: true };
      if (access.available === false) {
        return { area, recognized: true, available: false, availability: access, candidates: [], errors: [] };
      }
      let snapshot;
      try {
        snapshot = await this._getGateLikeSnapshot(area, true);
        this.areaAccessService?.markAvailable(area);
      } catch (error) {
        if (!this.areaAccessService || !unavailableWaveError(error)) throw error;
        const availability = this.areaAccessService.markUnavailable(area, error);
        return { area, recognized: true, available: false, availability, candidates: [], errors: [] };
      }
      if (snapshot.loot?.recognized !== true) {
        throw new Error(`${area.type === 'event' ? 'Event' : 'Gate'} loot page loaded but its claimable-monster contract was not recognized`);
      }
      rawCandidates = (snapshot.loot?.monsters || []).map(monster => ({
        ...monster,
        areaKey,
        monsterKey: monsterTypeKey(monster.name),
        battleRef: monster.battleId || monster.id,
      }));
    } else {
      const snapshot = areaKey === 'polyhedral_crucible'
        ? await this.gameAPI.getCubeSnapshot({ includeCleared: true, directoryInstances: options.directoryInstances })
        : await this.gameAPI.getDungeonSnapshot(area.label, { includePrevious: true, directoryInstances: options.directoryInstances });
      discoveryErrors = Array.isArray(snapshot.errors) ? clone(snapshot.errors) : [];
      rawCandidates = (snapshot.monsters || [])
        .filter(monster => monster.lootable === true)
        .map(monster => ({
          ...monster,
          areaKey,
          monsterKey: monsterTypeKey(monster.name),
          battleRef: clone(monster.battleRef),
        }));
    }

    return {
      area,
      recognized: true,
      candidates: rawCandidates,
      errors: discoveryErrors,
    };
  }

  async getProgressionLootCandidates(areaKey, configuredLoot = null, options = {}) {
    return this.enrichProgressionLootCandidates(await this.discoverLootCandidates(areaKey, options), configuredLoot);
  }

  async enrichProgressionLootCandidates(discovery, configuredLoot = null) {
    const area = discovery?.area;
    if (!area) throw new Error('Loot discovery area is unavailable');
    const areaKey = area.key || discovery.areaKey;
    const rawCandidates = Array.isArray(discovery.candidates) ? discovery.candidates : [];
    const discoveryErrors = Array.isArray(discovery.errors) ? discovery.errors : [];
    const isGateLike = area.type === 'gate' || area.type === 'event';
    const byType = new Map();
    for (const candidate of rawCandidates) {
      if (!candidate.monsterKey) continue;
      const settings = configuredLoot?.[candidate.monsterKey];
      if (configuredLoot && (settings?.enabled !== true
        || (settings.unlimited !== true && Number(settings.maxLooting) <= Number(settings.lootedCount || 0)))) continue;
      const group = byType.get(candidate.monsterKey) || [];
      const remainingLimit = !configuredLoot || settings?.unlimited === true
        ? Infinity
        : Math.max(0, Math.trunc(Number(settings.maxLooting) || 0) - Math.trunc(Number(settings.lootedCount) || 0));
      const groupedCount = group.reduce((total, entry) => total + Math.max(1, Math.trunc(Number(entry.stackSize) || 1)), 0);
      const candidateCount = Math.max(1, Math.trunc(Number(candidate.stackSize) || 1));
      if (configuredLoot && groupedCount + candidateCount > remainingLimit) continue;
      group.push(candidate);
      byType.set(candidate.monsterKey, group);
    }

    const enriched = [];
    for (const [monsterKey, candidates] of byType) {
      const rewardCacheKey = `${areaKey}:${monsterKey}`;
      const storedStats = this.getRecord(areaKey, monsterKey)?.stats || {};
      let sharedRewardInfo = this.rewardInfoCache.get(rewardCacheKey) || null;
      if (!sharedRewardInfo
          && hasFiniteNumber(storedStats.expPerDamage)
          && hasFiniteNumber(storedStats.rewardsUpToLevel)) {
        sharedRewardInfo = {
          recognized: true,
          expPerDamage: Number(storedStats.expPerDamage),
          expCapPercent: hasFiniteNumber(storedStats.expCapPercent) ? Number(storedStats.expCapPercent) : null,
          expCapDamage: hasFiniteNumber(storedStats.expCapDamage) ? Number(storedStats.expCapDamage) : null,
          minimumLevel: hasFiniteNumber(storedStats.minimumLevel) ? Number(storedStats.minimumLevel) : null,
          rewardsUpToLevel: Number(storedStats.rewardsUpToLevel),
        };
        this.rewardInfoCache.set(rewardCacheKey, sharedRewardInfo);
      }
      let firstBattle = null;
      const needsCapDamage = isGateLike && candidates.some(candidate => candidate.rewardCapReached === true);
      const needsRewardRead = !sharedRewardInfo
        || !hasFiniteNumber(sharedRewardInfo.rewardsUpToLevel)
        || (needsCapDamage && !hasFiniteNumber(sharedRewardInfo.expCapDamage));
      if (needsRewardRead && candidates[0]?.battleRef) {
        try {
          firstBattle = await this.gameAPI.getBattleConfig(candidates[0].battleRef);
          if (firstBattle.rewardInfo?.recognized) {
            sharedRewardInfo = clone(firstBattle.rewardInfo);
            this.rewardInfoCache.set(rewardCacheKey, sharedRewardInfo);
            this._rememberRewardInfo(areaKey, monsterKey, candidates[0].name, sharedRewardInfo);
          }
        } catch {
          // Each candidate remains fail-closed below. A later refresh may retry.
        }
      }
      for (const candidate of candidates) {
        let contribution = Number.isFinite(Number(candidate.userDmg)) ? Number(candidate.userDmg) : null;
        let rewardInfo = sharedRewardInfo;
        let verificationError = null;
        if (area.type === 'dungeon') {
          try {
            const battle = candidate === candidates[0] && firstBattle
              ? firstBattle
              : await this.gameAPI.getBattleConfig(candidate.battleRef);
            contribution = Number.isFinite(Number(battle.userDamage)) ? Number(battle.userDamage) : null;
            if (battle.rewardInfo?.recognized) {
              rewardInfo = battle.rewardInfo;
              this.rewardInfoCache.set(rewardCacheKey, clone(rewardInfo));
              this._rememberRewardInfo(areaKey, monsterKey, candidate.name, rewardInfo);
            }
          } catch (error) {
            verificationError = `Dungeon contribution read unavailable: ${error.message}`;
          }
        }
        const expPerDamage = Number(
          rewardInfo?.expPerDamage
          ?? candidate.expPerDamage
          ?? this.getRecord(areaKey, monsterKey)?.stats?.expPerDamage,
        );
        const rewardsUpToLevel = rewardInfo?.rewardsUpToLevel
          ?? this.getRecord(areaKey, monsterKey)?.stats?.rewardsUpToLevel
          ?? null;
        const capVerified = hasFiniteNumber(rewardInfo?.expCapDamage)
          || (isGateLike && candidate.rewardCapReached !== true);
        const verified = contribution !== null
          && Number.isFinite(expPerDamage) && expPerDamage > 0
          && capVerified
          && hasFiniteNumber(rewardsUpToLevel);
        enriched.push({
          ...clone(candidate),
          id: String(candidate.dgmid || candidate.battleId || candidate.id || ''),
          userDamage: contribution,
          expPerDamage: Number.isFinite(expPerDamage) ? expPerDamage : null,
          expCapDamage: rewardInfo?.expCapDamage ?? null,
          rewardsUpToLevel,
          verified,
          verificationError: verified ? null : (verificationError || 'Reward metadata or player contribution is unavailable'),
        });
      }
    }
    return {
      area,
      recognized: true,
      candidates: enriched,
      verifiedCount: enriched.filter(candidate => candidate.verified).length,
      unknownCount: enriched.filter(candidate => !candidate.verified).length,
      errors: discoveryErrors,
    };
  }

  _rememberRewardInfo(areaKey, monsterKey, name, rewardInfo) {
    if (!rewardInfo?.recognized) return;
    const existing = (this.accountDatabase
      ? this._getAccountFact(areaKey, monsterKey)
      : this.getRecord(areaKey, monsterKey)) || {};
    const stats = { ...(existing.stats || {}) };
    let changed = false;
    for (const field of ['expPerDamage', 'expCapPercent', 'expCapDamage', 'minimumLevel', 'rewardsUpToLevel']) {
      const value = rewardInfo[field];
      if (value == null || !Number.isFinite(Number(value)) || stats[field] === Number(value)) continue;
      stats[field] = Number(value);
      changed = true;
    }
    if (!changed) return;
    this._saveRecord({
      ...existing,
      areaKey,
      monsterKey,
      name: existing.name || name || monsterKey,
      stats,
      provenance: existing.provenance || {
        source: 'verified battle reward metadata',
        observedAt: new Date().toISOString(),
        schemaVersion: CATALOG_SCHEMA_VERSION,
      },
    });
  }

  async getMonsterStats(areaKey, monsterKey, { refresh = false } = {}) {
    const area = getMonsterArea(areaKey);
    const key = monsterTypeKey(monsterKey);
    if (!area || !key) throw new Error('Unknown monster target');
    const saved = this.getRecord(areaKey, key);
    const savedVariant = this.accountDatabase ? this._getAccountFact(areaKey, key) : saved;
    const hasCompleteBattleStats = Boolean(
      saved?.stats
      && Object.hasOwn(saved.stats, 'petDefense')
      && saved.stats.expPerDamage != null
      && Number.isFinite(Number(saved.stats.expPerDamage)),
    );
    if (hasCompleteBattleStats && !refresh) return { record: saved, cached: true, conflict: Boolean(saved.conflict) };
    if (!this.gameAPI) {
      if (saved?.stats && !refresh) return { record: saved, cached: true, conflict: Boolean(saved.conflict) };
      throw new Error('Game session not active');
    }

    try {
      if (!this.liveInstances.get(areaKey)?.get(key)?.monsterId) await this.listArea(areaKey);
    } catch (error) {
      if (saved?.stats && !refresh) return { record: saved, cached: true, conflict: Boolean(saved.conflict) };
      throw error;
    }
    const instance = this.liveInstances.get(areaKey)?.get(key);
    if (!instance?.monsterId) {
      if (saved?.stats && !refresh) return { record: saved, cached: true, conflict: Boolean(saved.conflict) };
      throw new Error('No current monster instance is available for this type');
    }
    let parsed;
    if (area.type === 'dungeon') {
      const battle = await this.gameAPI.getBattleConfig(instance.battleRef);
      parsed = battle.monsterStats
        ? {
          ...battle.monsterStats,
          expPerDamage: battle.rewardInfo?.expPerDamage ?? battle.monsterStats.expPerDamage ?? null,
          possibleLoot: battle.possibleLoot || [],
        }
        : null;
    } else {
      parsed = await this.gameAPI.getMonsterStats(instance.monsterId);
    }
    if (!parsed) throw new Error('Battle page loaded but Monster Stats were missing');
    if (monsterTypeKey(parsed.name) !== key) throw new Error('Battle page monster did not match the requested type');
    const { name, ...stats } = parsed;

    const observed = {
      areaKey,
      monsterKey: key,
      name,
      stats: clone(stats),
      provenance: {
        source: area.type === 'dungeon'
          ? 'battle.php?dgmid=<runtime>&instance_id=<runtime>'
          : 'battle.php?id=<runtime>',
        observedAt: new Date().toISOString(),
        schemaVersion: CATALOG_SCHEMA_VERSION,
      },
    };
    // A source-controlled baseline is a read-only fallback, not the matching
    // account/Event-Level variant. First live capture must not conflict with
    // or silently promote that separate scope.
    const savedStats = savedVariant?.stats ? clone(savedVariant.stats) : null;
    let observedStats = clone(observed.stats);
    const savedWasPartial = Boolean(savedStats && !Object.hasOwn(savedStats, 'petDefense'));
    if (savedWasPartial) observedStats = { ...savedStats, ...observedStats };
    let rewardMetadataEnriched = false;
    for (const field of ['expPerDamage', 'expCapPercent', 'expCapDamage', 'minimumLevel', 'rewardsUpToLevel']) {
      if (savedStats && savedStats[field] == null && observedStats[field] != null) {
        savedStats[field] = observedStats[field];
        rewardMetadataEnriched = true;
      }
      if (savedStats?.[field] != null && observedStats[field] == null) {
        observedStats[field] = savedStats[field];
      }
    }
    observed.stats = observedStats;
    if (savedStats && !savedWasPartial && statsFingerprint(savedStats) !== statsFingerprint(observedStats)) {
      const conflicted = {
        ...(savedVariant || {}),
        areaKey,
        monsterKey: key,
        name: savedVariant?.name || saved?.name || name,
        conflict: {
          observedStats: observed.stats,
          provenance: observed.provenance,
        },
      };
      this._saveRecord(conflicted);
      return { record: this.getRecord(areaKey, key), cached: false, conflict: true };
    }
    if (rewardMetadataEnriched || savedWasPartial) observed.stats = observedStats;
    this._saveRecord(observed);
    return { record: this.getRecord(areaKey, key), cached: false, conflict: false };
  }

  async collectAreaStats(areaKey) {
    const discovery = await this.listArea(areaKey);
    if (!discovery.sourceAvailable) return { area: discovery.area, collected: 0, cached: 0, conflicts: 0, errors: [] };
    const summary = { area: discovery.area, collected: 0, cached: 0, conflicts: 0, conflictKeys: [], errors: [] };
    const types = [...(this.liveInstances.get(areaKey)?.keys() || [])];
    for (let index = 0; index < types.length; index += 1) {
      const monsterKey = types[index];
      try {
        const result = await this.getMonsterStats(areaKey, monsterKey, { refresh: true });
        if (result.cached) summary.cached += 1;
        else summary.collected += 1;
        if (result.conflict) {
          summary.conflicts += 1;
          summary.conflictKeys.push(monsterKey);
        }
      } catch (error) {
        summary.errors.push({ monsterKey, error: error.message });
      }
      if (index < types.length - 1) {
        const delay = 180 + Math.floor(Math.random() * 270);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return summary;
  }

  applyObservedMonsterStats(areaKey, monsterKey) {
    const area = getMonsterArea(areaKey);
    const key = monsterTypeKey(monsterKey);
    if (!area || !key) throw new Error('Unknown monster target');
    const saved = this.getRecord(areaKey, key);
    const savedVariant = this.accountDatabase ? this._getAccountFact(areaKey, key) : saved;
    if (!savedVariant?.conflict?.observedStats) throw new Error('No changed live Monster Stats are waiting to be applied');
    const accepted = {
      ...savedVariant,
      areaKey,
      monsterKey: key,
      name: savedVariant.name || saved?.name || key,
      stats: clone(savedVariant.conflict.observedStats),
      provenance: clone(savedVariant.conflict.provenance || savedVariant.provenance || {
        source: 'accepted live battle observation',
        observedAt: new Date().toISOString(),
        schemaVersion: CATALOG_SCHEMA_VERSION,
      }),
      conflict: null,
    };
    this._saveRecord(accepted);
    return this.getRecord(areaKey, key);
  }

  _saveRecord(record) {
    if (this.accountDatabase && this.accountRef) {
      return this.accountDatabase.putMonsterFact(this.accountRef, record, { scope: this._factScope(record.areaKey) });
    }
    this.cacheCatalog.monsters[record.areaKey] ||= {};
    const existing = this.getRecord(record.areaKey, record.monsterKey) || {};
    this.cacheCatalog.monsters[record.areaKey][record.monsterKey] = {
      ...existing,
      ...clone(record),
    };
    this._writeCacheCatalog();
  }

  _applyObservedMetadata(areaKey, byType) {
    for (const [key, monster] of byType) {
      const existing = this.getRecord(areaKey, key) || {};
      const observedTotal = Math.max(0, Number(monster.totalCount) || 0);
      const maxObservedCount = Math.max(observedTotal, Number(existing.maxObservedCount) || 0);
      // A live observation is authoritative for the current row.  In
      // particular, do not resurrect a remembered boss flag: a normal mob can
      // temporarily be the only surviving instance and the old singleton
      // heuristic incorrectly labelled it as a boss.  Bosses must be backed by
      // the server/auto-summon evidence (or the explicit dungeon location
      // context); remembered rows are still retained when absent from a page.
      const bossEvidence = monster.phase
        ? null
        : (monster.bossEvidence || (monster.boss === true ? 'server' : null));
      monster.maxObservedCount = maxObservedCount;
      monster.totalCount = Math.max(observedTotal, maxObservedCount);
      monster.bossEvidence = bossEvidence;
      monster.boss = Boolean(bossEvidence);
    }
  }

  _rememberTypes(areaKey, area, monsters, dungeon = null) {
    if (this.accountDatabase && this.accountRef) {
      const existingTypes = new Map(this.accountDatabase.listMonsterTypes(this.accountRef, areaKey)
        .map(type => [monsterTypeKey(type.monsterKey || type.canonicalName), type]));
      const stableTypes = [...monsters].map(monster => ({
        ...monster,
        phase: monster.runtimePhase === true ? null : monster.phase,
        boss: monster.runtimePhase === true
          ? Boolean(existingTypes.get(monsterTypeKey(monster.key || monster.name))?.boss)
          : monster.boss,
        bossEvidence: monster.runtimePhase === true
          ? (existingTypes.get(monsterTypeKey(monster.key || monster.name))?.bossEvidence || null)
          : monster.bossEvidence,
      }));
      this.accountDatabase.observeMonsterTypes(this.accountRef, area, stableTypes);
      for (const monster of stableTypes) {
        const key = monsterTypeKey(monster.key || monster.name);
        const inlineStats = monster.inlineStats && Object.keys(monster.inlineStats).length > 0
          ? clone(monster.inlineStats)
          : null;
        if (!key || !inlineStats || (area.type === 'event' && !this._observedPlayerLevel())
            || this._getAccountFact(areaKey, key)?.stats) continue;
        this._saveRecord({
          areaKey,
          monsterKey: key,
          name: monster.name,
          stats: inlineStats,
          provenance: {
            source: area.type === 'dungeon' ? 'guild_dungeon_enter.php?id=<runtime>' : 'active_wave.php',
            observedAt: new Date().toISOString(),
            schemaVersion: CATALOG_SCHEMA_VERSION,
          },
        });
      }
      return;
    }
    this.cacheCatalog.monsters[areaKey] ||= {};
    let changed = false;
    for (const monster of monsters) {
      const key = monsterTypeKey(monster.key || monster.name);
      if (!key) continue;
      const existing = this.getRecord(areaKey, key);
      const phase = Number(monster.phase) || Number(existing?.phase) || null;
      const boss = phase ? false : Boolean(monster.boss);
      const bossEvidence = monster.bossEvidence || (boss ? 'legacy' : null);
      const maxObservedCount = Math.max(Number(existing?.maxObservedCount) || 0, Number(monster.maxObservedCount ?? monster.totalCount) || 0);
      const inlineStats = monster.inlineStats && Object.keys(monster.inlineStats).length > 0
        ? clone(monster.inlineStats)
        : null;
      const hasNewStats = !existing?.stats && inlineStats;
      if (existing?.discovery && existing.name === monster.name && Boolean(existing.boss) === boss
          && Number(existing.phase || 0) === Number(phase || 0)
          && existing.bossEvidence === bossEvidence && Number(existing.maxObservedCount || 0) === maxObservedCount
          && !hasNewStats) continue;
      this.cacheCatalog.monsters[areaKey][key] = {
        ...(existing || {}),
        areaKey,
        monsterKey: key,
        name: monster.name,
        phase,
        boss,
        bossEvidence,
        maxObservedCount,
        ...(hasNewStats ? {
          stats: inlineStats,
          provenance: {
            source: `guild_dungeon_enter.php?id=${dungeon?.instanceId || 'dynamic'}`,
            observedAt: new Date().toISOString(),
            schemaVersion: CATALOG_SCHEMA_VERSION,
          },
        } : {}),
        discovery: existing?.discovery || {
          source: area.type === 'dungeon'
            ? `guild_dungeon_enter.php?id=${dungeon?.instanceId || 'dynamic'}`
            : `active_wave.php?${area.eventId ? 'event' : 'gate'}=${area.eventId || area.gateId}&wave=${area.wave}`,
          instanceName: area.type === 'dungeon' ? (dungeon?.name || area.label) : null,
          firstObservedAt: new Date().toISOString(),
          schemaVersion: CATALOG_SCHEMA_VERSION,
        },
      };
      changed = true;
    }
    if (changed) this._writeCacheCatalog();
  }

  _mergeRememberedTypes(areaKey, byType) {
    const known = this.accountDatabase && this.accountRef
      ? Object.fromEntries(this.accountDatabase.listMonsterTypes(this.accountRef, areaKey).map(type => {
          const key = monsterTypeKey(type.monsterKey || type.canonicalName);
          const fact = this.getRecord(areaKey, key) || {};
          return [key, {
            ...fact,
            areaKey,
            monsterKey: key,
            name: type.canonicalName,
            phase: type.phase,
            boss: type.boss,
            bossEvidence: type.bossEvidence,
            maxObservedCount: type.maxObservedCount,
          }];
        }))
      : {
          ...(this.baseCatalog.monsters?.[areaKey] || {}),
          ...(this.cacheCatalog.monsters?.[areaKey] || {}),
        };
    for (const [key, record] of Object.entries(known)) {
      const current = byType.get(key);
      if (current) {
        current.phase = Number(current.phase) || Number(record.phase) || null;
        if (current.phase) {
          current.boss = false;
          current.bossEvidence = null;
        }
        else {
          // The current page decides whether this live type is a boss.  Keep
          // remembered metadata only for rows that are not currently visible.
          current.boss = Boolean(current.boss);
          current.bossEvidence = current.bossEvidence || null;
        }
        current.totalCount = Math.max(Number(current.totalCount) || 0, Number(record.maxObservedCount) || 0);
        current.maxObservedCount = current.totalCount;
        current.statsAvailable = Boolean(record.stats);
        current.statsConflict = Boolean(record.conflict);
        continue;
      }
      byType.set(key, {
        key,
        name: record.name || key,
        phase: Number(record.phase) || null,
        boss: Number(record.phase) ? false : Boolean(record.boss),
        bossEvidence: Number(record.phase) ? null : (record.bossEvidence || null),
        instances: 0,
        aliveCount: 0,
        totalCount: Math.max(0, Number(record.maxObservedCount) || 0),
        maxObservedCount: Math.max(0, Number(record.maxObservedCount) || 0),
        monsterId: null,
        statsAvailable: Boolean(record.stats),
        statsConflict: Boolean(record.conflict),
        lootableCount: 0,
        remembered: true,
      });
    }
  }

  _writeCacheCatalog() {
    if (this.accountDatabase) return false;
    const directory = path.dirname(this.cachePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.cachePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.cacheCatalog, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.cachePath);
    return true;
  }

  _factScope(areaKey) {
    const area = getMonsterArea(areaKey);
    const level = this._observedPlayerLevel();
    if (area?.type === 'event') {
      if (!level) throw new Error('Player Level must be known before Event monster facts can be saved');
      return { kind: 'event', eventKey: areaKey, level };
    }
    return {
      kind: 'account',
      accountKey: this.accountKey || this.accountDatabase?.resolveAccountKey?.(this.accountRef),
    };
  }
}

module.exports = { MonsterCatalogService, CATALOG_SCHEMA_VERSION, statsFingerprint };
