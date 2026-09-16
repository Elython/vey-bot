const fs = require('fs');
const path = require('path');
const { getMonsterArea, monsterTypeKey } = require('./monsterCatalog');
const { getDataDir } = require('../main/paths');

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
    this.cacheCatalog = readCatalog(this.cachePath);
    this.liveInstances = new Map();
    this.liveAreaMonsters = new Map();
    this.rewardInfoCache = new Map();
  }

  setGameAPI(gameAPI) {
    this.gameAPI = gameAPI;
    this.liveInstances.clear();
    this.liveAreaMonsters.clear();
    this.rewardInfoCache.clear();
  }

  getRecord(areaKey, monsterKey) {
    const key = monsterTypeKey(monsterKey);
    const record = this.cacheCatalog.monsters?.[areaKey]?.[key]
      || this.baseCatalog.monsters?.[areaKey]?.[key]
      || null;
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

  async listArea(areaKey) {
    const area = getMonsterArea(areaKey);
    if (area?.type === 'dungeon') return this._listDungeonArea(areaKey, { lootDiscovery: false });
    return this._listGateArea(areaKey, { lootDiscovery: false });
  }

  async listLootableArea(areaKey) {
    const area = getMonsterArea(areaKey);
    if (area?.type === 'dungeon') return this._listDungeonArea(areaKey, { lootDiscovery: true });
    return this._listGateArea(areaKey, { lootDiscovery: true });
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
    const lootableByType = new Map();
    for (const monster of snapshot.loot?.monsters || []) {
      const key = monsterTypeKey(monster.name);
      if (key) lootableByType.set(key, (lootableByType.get(key) || 0) + Math.max(1, Number(monster.stackSize) || 1));
    }
    const byType = new Map();
    for (const monster of snapshot.monsters) {
      const key = monsterTypeKey(monster.name);
      if (!key) continue;
      const existing = byType.get(key);
      if (existing) {
        existing.instances += 1;
        existing.aliveCount += monster.dead === true ? 0 : 1;
        existing.totalCount += 1;
        existing.boss = existing.boss || Boolean(monster.boss);
        if (!existing.monsterId && (monster.battleId || monster.id)) {
          existing.monsterId = String(monster.battleId || monster.id);
        }
      } else {
        const record = this.getRecord(areaKey, key);
        byType.set(key, {
          key,
          name: monster.name,
          boss: Boolean(monster.boss),
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
        boss: Boolean(monster.boss),
        instances: 0,
        aliveCount: 0,
        totalCount: 1,
        monsterId: monster.battleId || monster.id ? String(monster.battleId || monster.id) : null,
        statsAvailable: Boolean(record?.stats),
        statsConflict: Boolean(record?.conflict),
        lootableCount: lootableByType.get(key) || 0,
      });
    }
    this._rememberTypes(areaKey, area, byType.values());
    // Only ordinary target discovery may replace live battle instances. Loot
    // discovery intentionally exposes dead cards whose IDs are not attackable.
    if (!lootDiscovery) {
      this.liveInstances.set(
        areaKey,
        new Map([...byType].map(([key, monster]) => [key, { ...monster }])),
      );
    }
    this._mergeRememberedTypes(areaKey, byType);
    return {
      area,
      sourceAvailable: true,
      resources: snapshot.resources,
      monsters: [...byType.values()].map(({ monsterId, ...monster }) => monster),
      loot: {
        recognized: snapshot.loot?.recognized === true,
        reportedUnclaimed: snapshot.loot?.reportedUnclaimed ?? null,
        visibleLootable: snapshot.loot?.visibleLootable || 0,
        visibleLootActions: snapshot.loot?.visibleLootActions || 0,
      },
    };
  }

  async _listDungeonArea(areaKey, { lootDiscovery }) {
    const area = getMonsterArea(areaKey);
    if (!area || area.type !== 'dungeon') throw new Error('Unknown dungeon area');
    if (!this.gameAPI) throw new Error('Game session not active');
    const snapshot = await this.gameAPI.getDungeonSnapshot(area.label, { includePrevious: lootDiscovery });
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
    this.liveAreaMonsters.set(areaKey, allInstances.map(monster => ({ ...clone(monster), areaKey, monsterKey: monsterTypeKey(monster.name) })));
    this.liveInstances.set(areaKey, new Map([...byType].map(([key, monster]) => [key, { ...monster }])));
    this._rememberTypes(areaKey, area, byType.values(), snapshot.dungeon);
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

  async getProgressionLootCandidates(areaKey, configuredLoot = null) {
    const area = getMonsterArea(areaKey);
    if (!area) throw new Error('Unknown monster area');
    if (!this.gameAPI) throw new Error('Game session not active');

    let rawCandidates = [];
    let discoveryErrors = [];
    const isGateLike = area.type === 'gate' || area.type === 'event';
    if (isGateLike) {
      const snapshot = await this._getGateLikeSnapshot(area, true);
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
      const snapshot = await this.gameAPI.getDungeonSnapshot(area.label, { includePrevious: true });
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
    const existing = this.getRecord(areaKey, monsterKey) || {};
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
          ? `battle.php?dgmid=${instance.monsterId}&instance_id=${instance.battleRef.instanceId}`
          : `battle.php?id=${instance.monsterId}`,
        observedMonsterId: String(instance.monsterId),
        observedAt: new Date().toISOString(),
        schemaVersion: CATALOG_SCHEMA_VERSION,
      },
    };
    const savedStats = saved?.stats ? clone(saved.stats) : null;
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
        ...saved,
        conflict: {
          observedStats: observed.stats,
          provenance: observed.provenance,
        },
      };
      this._saveRecord(conflicted);
      return { record: clone(conflicted), cached: false, conflict: true };
    }
    if (rewardMetadataEnriched || savedWasPartial) observed.stats = observedStats;
    this._saveRecord(observed);
    return { record: clone(observed), cached: false, conflict: false };
  }

  async collectAreaStats(areaKey) {
    const discovery = await this.listArea(areaKey);
    if (!discovery.sourceAvailable) return { area: discovery.area, collected: 0, cached: 0, conflicts: 0, errors: [] };
    const summary = { area: discovery.area, collected: 0, cached: 0, conflicts: 0, errors: [] };
    const types = [...(this.liveInstances.get(areaKey)?.keys() || [])];
    for (let index = 0; index < types.length; index += 1) {
      const monsterKey = types[index];
      try {
        const result = await this.getMonsterStats(areaKey, monsterKey, { refresh: true });
        if (result.cached) summary.cached += 1;
        else summary.collected += 1;
        if (result.conflict) summary.conflicts += 1;
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

  _saveRecord(record) {
    this.cacheCatalog.monsters[record.areaKey] ||= {};
    const existing = this.getRecord(record.areaKey, record.monsterKey) || {};
    this.cacheCatalog.monsters[record.areaKey][record.monsterKey] = {
      ...existing,
      ...clone(record),
    };
    this._writeCacheCatalog();
  }

  _rememberTypes(areaKey, area, monsters, dungeon = null) {
    this.cacheCatalog.monsters[areaKey] ||= {};
    let changed = false;
    for (const monster of monsters) {
      const key = monsterTypeKey(monster.key || monster.name);
      if (!key) continue;
      const existing = this.getRecord(areaKey, key);
      const boss = Boolean(existing?.boss || monster.boss);
      const inlineStats = monster.inlineStats && Object.keys(monster.inlineStats).length > 0
        ? clone(monster.inlineStats)
        : null;
      const hasNewStats = !existing?.stats && inlineStats;
      if (existing?.discovery && existing.name === monster.name && Boolean(existing.boss) === boss && !hasNewStats) continue;
      this.cacheCatalog.monsters[areaKey][key] = {
        ...(existing || {}),
        areaKey,
        monsterKey: key,
        name: monster.name,
        boss,
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
    const known = {
      ...(this.baseCatalog.monsters?.[areaKey] || {}),
      ...(this.cacheCatalog.monsters?.[areaKey] || {}),
    };
    for (const [key, record] of Object.entries(known)) {
      const current = byType.get(key);
      if (current) {
        current.boss = current.boss || Boolean(record.boss);
        current.statsAvailable = Boolean(record.stats);
        current.statsConflict = Boolean(record.conflict);
        continue;
      }
      byType.set(key, {
        key,
        name: record.name || key,
        boss: Boolean(record.boss),
        instances: 0,
        aliveCount: 0,
        totalCount: 0,
        monsterId: null,
        statsAvailable: Boolean(record.stats),
        statsConflict: Boolean(record.conflict),
        lootableCount: 0,
        remembered: true,
      });
    }
  }

  _writeCacheCatalog() {
    const directory = path.dirname(this.cachePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.cachePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.cacheCatalog, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.cachePath);
  }
}

module.exports = { MonsterCatalogService, CATALOG_SCHEMA_VERSION, statsFingerprint };
