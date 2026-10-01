const { monsterTypeKey, getMonsterArea, supportsAutoFarm } = require('./monsterCatalog');
const {
  ReadPriority,
  WorldDomain,
  assertAccountKey,
  assertAccountScope,
  createCollectorResult,
} = require('./worldState');

const AUTO_FARM_RESOURCE_KEY = 'current';
const AUTO_FARM_UI_MAX_AGE_MS = 2500;
const AUTO_FARM_MINIMUM_LEVEL = 400;
const AUTO_FARM_ATTACK_LOCK_MESSAGE = "You can't attack monsters while your auto farm is on.";

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Auto Farm read cancelled');
  error.name = 'AbortError';
  error.code = 'READ_ABORTED';
  throw error;
}

function normalizeAutoFarmObservation(state = {}, area = {}, monsterCatalogService = null) {
  if (state?.recognized === false) throw new Error('Verified Auto Farm panel was not found');
  const normalizeType = entry => ({
    id: String(entry?.id ?? entry?.monsterId ?? ''),
    name: String(entry?.name ?? entry?.monsterName ?? ''),
  });
  const availableMonsters = (Array.isArray(state.availableMonsters) ? state.availableMonsters : [])
    .map(normalizeType)
    .filter(entry => /^\d{1,30}$/.test(entry.id) && entry.name);
  const monsters = (Array.isArray(state.monsters) ? state.monsters : [])
    .map(normalizeType)
    .filter(entry => /^\d{1,30}$/.test(entry.id) && entry.name);
  const settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
  const counters = state.counters && typeof state.counters === 'object' ? state.counters : {};
  return {
    recognized: true,
    enabled: state.enabled === true,
    settings: {
      totalMonsters: Math.max(0, Math.trunc(Number(settings.totalMonsters) || 0)),
      hpPotionLimit: Math.max(0, Math.trunc(Number(settings.hpPotionLimit) || 0)),
      staminaPotionLimits: {
        small: Math.max(0, Math.trunc(Number(settings.staminaPotionLimits?.small) || 0)),
        large: Math.max(0, Math.trunc(Number(settings.staminaPotionLimits?.large) || 0)),
        full: Math.max(0, Math.trunc(Number(settings.staminaPotionLimits?.full) || 0)),
        adventure: Math.max(0, Math.trunc(Number(settings.staminaPotionLimits?.adventure) || 0)),
      },
      priorityItemId: String(settings.priorityItemId ?? '0'),
      autoLootToLevel: settings.autoLootToLevel === true,
      expLeftPercent: settings.expLeftPercent === null || settings.expLeftPercent === undefined
        ? 100
        : Math.max(0, Math.min(100, Math.trunc(Number(settings.expLeftPercent) || 0))),
    },
    counters: {
      monsters: Math.max(0, Math.trunc(Number(counters.monsters) || 0)),
      hpPotions: Math.max(0, Math.trunc(Number(counters.hpPotions) || 0)),
      staminaPotions: {
        small: Math.max(0, Math.trunc(Number(counters.staminaPotions?.small) || 0)),
        large: Math.max(0, Math.trunc(Number(counters.staminaPotions?.large) || 0)),
        full: Math.max(0, Math.trunc(Number(counters.staminaPotions?.full) || 0)),
        adventure: Math.max(0, Math.trunc(Number(counters.staminaPotions?.adventure) || 0)),
      },
    },
    availableMonsters,
    monsters,
    targets: (Array.isArray(state.targets) ? state.targets : []).map(target => ({
      targetId: String(target?.targetId || ''),
      monsterId: String(target?.monsterId || ''),
      monsterName: String(target?.monsterName || ''),
      enabled: target?.enabled === true,
      damageMode: Number(target?.damageMode) === 0 ? 0 : 1,
      minDamage: Math.max(0, Math.trunc(Number(target?.minDamage) || 0)),
      maxStack: Math.min(250, Math.max(1, Math.trunc(Number(target?.maxStack) || 1))),
      areaKey: monsterCatalogService?.resolveAutoFarmArea?.(target?.monsterId, target?.monsterName) || null,
    })).filter(target => /^\d{1,30}$/.test(target.targetId) && /^\d{1,30}$/.test(target.monsterId)),
    area: {
      key: String(area.key || ''),
      label: String(area.label || ''),
      type: String(area.type || ''),
    },
  };
}

function isAutoFarmAttackLockMessage(value) {
  return String(value || '').trim().toLowerCase() === AUTO_FARM_ATTACK_LOCK_MESSAGE.toLowerCase();
}

function autoFarmConflictError(message = 'Server Auto Farm is still running') {
  const error = new Error(message);
  error.code = 'AUTO_FARM_ACTIVE';
  return error;
}

class AutoFarmService {
  constructor(gameAPI, monsterCatalogService = null, options = {}) {
    this.gameAPI = gameAPI;
    this.monsterCatalogService = monsterCatalogService;
    this.now = options.now || (() => Date.now());
    this.readCoordinator = options.readCoordinator || null;
    this.mode = options.mode || 'shared';
    if (!['shared', 'legacy'].includes(this.mode)) throw new Error(`Unsupported Auto Farm mode: ${this.mode}`);
    if (this.mode === 'shared' && !this.readCoordinator) throw new TypeError('Shared Auto Farm requires ReadCoordinator');
    this.accountKey = this.mode === 'shared' ? assertAccountKey(options.accountKey) : null;
    this.configProvider = typeof options.configProvider === 'function' ? options.configProvider : null;
    this.levelProvider = typeof options.levelProvider === 'function' ? options.levelProvider : null;
    this.lastConfig = {};
    this.sourceRevision = 0;
  }

  getCollector() {
    return this;
  }

  _stateAreas(config = {}) {
    const candidates = [config.areaKey, ...Object.keys(config.maps || {}), 'grakthar_2', 'event_black_crown_ascends'];
    const areas = [];
    const seen = new Set();
    for (const areaKey of candidates) {
      const area = getMonsterArea(areaKey);
      if (!supportsAutoFarm(area) || seen.has(area.key)) continue;
      seen.add(area.key);
      areas.push(area);
    }
    if (areas.length === 0) throw new Error('Auto Farm requires one configured Gate or Event wave page');
    return areas;
  }

  async _readFromServer(config = {}, signal = null) {
    const attempts = [];
    let area = null;
    let state = null;
    for (const candidate of this._stateAreas(config)) {
      throwIfAborted(signal);
      try {
        state = await this.gameAPI.fetchAutoFarmState(candidate);
        area = candidate;
        break;
      } catch (error) {
        if (['AUTH_REQUIRED', 'CLOUDFLARE'].includes(error?.code)) throw error;
        attempts.push(`${candidate.label}: ${error.message || 'Auto Farm panel missing'}`);
      }
    }
    if (!state || !area) throw new Error(`No authenticated Auto Farm panel could be read (${attempts.join('; ')})`);
    throwIfAborted(signal);
    this.monsterCatalogService?.observeAutoFarmTypes?.([
      ...(state.availableMonsters || []), ...(state.monsters || []), ...(state.targets || []),
    ]);
    return normalizeAutoFarmObservation(state, area, this.monsterCatalogService);
  }

  async collect(request = {}) {
    assertAccountScope(this.accountKey, request.accountKey);
    if (request.resourceKey !== AUTO_FARM_RESOURCE_KEY) throw new Error('Unknown Auto Farm resource');
    const observedAt = Number(this.now());
    const sourceRevision = ++this.sourceRevision;
    const config = this.configProvider?.() || this.lastConfig || {};
    const observation = await this._readFromServer(config, request.signal);
    return createCollectorResult({
      accountKey: this.accountKey,
      domain: WorldDomain.AUTO_FARM,
      resourceKey: AUTO_FARM_RESOURCE_KEY,
      observation,
      observedAt,
      sourceRevision,
      source: `GET active_wave.php via ${observation.area.key}`,
    });
  }

  _projectState(observation, config = {}) {
    const projected = clone(observation);
    const targetPolicies = config.targetPolicies && typeof config.targetPolicies === 'object' ? config.targetPolicies : {};
    projected.targets = (projected.targets || []).map(target => {
      const desired = targetPolicies[String(target.monsterId)] || null;
      if (!desired) return target;
      return {
        ...target,
        monsterName: desired.monsterName || target.monsterName,
        areaKey: desired.areaKey || target.areaKey,
        enabled: desired.enabled === true,
        damageMode: Number(desired.damageMode) === 0 ? 0 : 1,
        minDamage: Math.max(0, Math.trunc(Number(desired.minDamage) || 0)),
        maxStack: Math.min(250, Math.max(1, Math.trunc(Number(desired.maxStack) || 1))),
      };
    });
    return projected;
  }

  async readState(config = {}, {
    force = false,
    priority = ReadPriority.VISIBLE_UI,
    maxAgeMs = AUTO_FARM_UI_MAX_AGE_MS,
    signal = null,
  } = {}) {
    this.lastConfig = clone(config || {});
    if (this.mode === 'legacy') return this._projectState(await this._readFromServer(config, signal), config);
    try {
      const snapshot = await this.readCoordinator.read({
        accountKey: this.accountKey,
        domain: WorldDomain.AUTO_FARM,
        resourceKey: AUTO_FARM_RESOURCE_KEY,
        priority,
        maxAgeMs: force ? 0 : maxAgeMs,
        force,
        signal,
      });
      const observation = clone(snapshot?.value);
      if (observation && typeof observation === 'object') delete observation.meta;
      return this._projectState(observation, config);
    } catch (error) {
      if (error?.code !== 'READ_ABORTED' && error?.name !== 'AbortError') this.invalidate('Auto Farm refresh failed');
      throw error;
    }
  }

  invalidate(reason = 'Auto Farm observation invalidated') {
    if (this.mode !== 'shared') return false;
    return this.readCoordinator.invalidate(this.accountKey, WorldDomain.AUTO_FARM, AUTO_FARM_RESOURCE_KEY, reason);
  }

  peekObservation() {
    if (this.mode !== 'shared') return null;
    return clone(this.readCoordinator.peek(this.accountKey, WorldDomain.AUTO_FARM, AUTO_FARM_RESOURCE_KEY)?.value || null);
  }

  _isAmbiguousMutationError(error) {
    return ['TIMEOUT', 'REQUEST_FAILED', 'SESSION_DESTROYED'].includes(error?.code);
  }

  async _mutateOnce(label, action, config, verify) {
    try {
      const result = await action();
      if (!result?.success) throw new Error(result?.message || `${label} failed`);
      this.invalidate(`${label} confirmed`);
      return result;
    } catch (error) {
      if (!this._isAmbiguousMutationError(error)) throw error;
      this.invalidate(`${label} outcome is ambiguous`);
      const refreshed = await this.readState(config, {
        force: true, priority: ReadPriority.MUTATION_REVALIDATION, maxAgeMs: 0,
      });
      if (verify?.(refreshed) === true) return { success: true, reconciled: true, message: `${label} was confirmed by reread` };
      throw error;
    }
  }

  async _pauseForMutation(state, config = {}) {
    if (state.enabled !== true) return false;
    await this._mutateOnce('Auto Farm pause', () => this.gameAPI.toggleAutoFarm(false), config, fresh => fresh.enabled !== true);
    return true;
  }

  async _restoreAfterMutation(wasEnabled, config = {}) {
    if (!wasEnabled) return;
    await this._mutateOnce('Auto Farm restore', () => this.gameAPI.toggleAutoFarm(true), config, fresh => fresh.enabled === true);
  }

  _policyForExisting(config, existing) {
    const stable = config.targetPolicies?.[String(existing.monsterId)]
      || config.serverTargets?.[String(existing.targetId)]
      || null;
    if (stable) return stable;
    for (const [areaKey, entries] of Object.entries(config.maps || {})) {
      for (const [monsterKey, entry] of Object.entries(entries || {})) {
        if (String(entry?.monsterId || '') !== String(existing.monsterId)) continue;
        return {
          monsterName: entry.name || existing.monsterName || monsterKey,
          areaKey,
          enabled: entry.enabled === true,
          damageMode: 1,
          minDamage: Math.max(0, Math.trunc(Number(entry.targetDamage) || 0)),
          maxStack: Math.min(250, Math.max(1, Math.trunc(Number(entry.maxStack) || 1))),
        };
      }
    }
    return null;
  }

  async saveExistingConfiguration(config = {}) {
    const state = await this.readState(config, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
    const wasEnabled = await this._pauseForMutation(state, config);
    let restored = false;
    try {
      await this._mutateOnce('Auto Farm settings save', () => this.gameAPI.saveAutoFarmSettings(config.settings || {}), config);
      let updated = 0;
      for (const existing of state.targets) {
        const desired = this._policyForExisting(config, existing);
        if (!desired) continue;
        const normalized = { ...existing, ...desired, targetId: existing.targetId, monsterId: existing.monsterId };
        const changed = existing.enabled !== (desired.enabled === true)
          || Number(existing.damageMode) !== (Number(desired.damageMode) === 0 ? 0 : 1)
          || Number(existing.minDamage) !== Math.max(0, Math.trunc(Number(desired.minDamage) || 0))
          || Number(existing.maxStack) !== Math.min(250, Math.max(1, Math.trunc(Number(desired.maxStack) || 1)));
        if (!changed) continue;
        await this._mutateOnce(`Auto Farm target ${existing.monsterId} update`,
          () => this.gameAPI.updateAutoFarmTarget(normalized), config);
        updated += 1;
      }
      await this._restoreAfterMutation(wasEnabled, config);
      restored = true;
      const refreshed = await this.readState(config, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
      return { success: true, updated, targets: refreshed.targets.length, state: refreshed };
    } catch (error) {
      if (wasEnabled && !restored) await this._restoreAfterMutation(true, config).catch(() => null);
      throw error;
    }
  }

  async addAreaTargets(config = {}, areaKey) {
    const area = getMonsterArea(areaKey);
    if (!supportsAutoFarm(area)) throw new Error('This area does not support server Auto Farm');
    const scopedConfig = { ...config, areaKey };
    const state = await this.readState(scopedConfig, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
    const discovery = this.monsterCatalogService ? await this.monsterCatalogService.listArea(areaKey) : null;
    const available = discovery?.autoFarmAvailableMonsters || [];
    if (available.length === 0) {
      const reason = discovery?.autoFarmCatalog?.error || 'No verified stable monster IDs are available for this area';
      throw new Error(`Auto Farm monster catalog is unavailable: ${reason}`);
    }
    const availableById = new Map(available.map(monster => [String(monster.id), monster]));
    const idByName = new Map(available.map(monster => [monsterTypeKey(monster.name), String(monster.id)]));
    const availableMonsterKeys = [...new Set(available.map(monster => monsterTypeKey(monster.name)).filter(Boolean))];
    const bossKeys = new Set((discovery?.monsters || []).filter(monster => monster.boss === true).map(monster => monster.key));
    const selected = [];
    const discarded = [];
    for (const [monsterKey, entry] of Object.entries(config.maps?.[areaKey] || {})) {
      if (entry?.enabled !== true) continue;
      if (bossKeys.has(monsterKey) || this.monsterCatalogService?.getRecord(areaKey, monsterKey)?.boss === true) continue;
      const configuredId = /^\d{1,30}$/.test(String(entry.monsterId || '')) ? String(entry.monsterId) : null;
      const configuredMonster = configuredId ? availableById.get(configuredId) : null;
      const expectedNameKey = monsterTypeKey(entry.name || monsterKey);
      const monsterId = configuredMonster && monsterTypeKey(configuredMonster.name) === expectedNameKey
        ? configuredId : idByName.get(expectedNameKey);
      if (!monsterId) {
        discarded.push({ monsterKey, name: entry.name || monsterKey, reason: 'not available in selected area' });
        continue;
      }
      selected.push({ monsterId, monsterName: entry.name, enabled: true, damageMode: 1,
        minDamage: Math.max(0, Math.trunc(Number(entry.targetDamage) || 0)),
        maxStack: Math.min(250, Math.max(1, Math.trunc(Number(entry.maxStack) || 1))) });
    }
    if (selected.length === 0) throw new Error('Select at least one Auto Farm target to add');
    const wasEnabled = await this._pauseForMutation(state, scopedConfig);
    let restored = false;
    try {
      for (const target of selected) {
        await this._mutateOnce(`Auto Farm target ${target.monsterId} add`,
          () => this.gameAPI.addAutoFarmTarget(target), scopedConfig,
          fresh => fresh.targets.some(entry => String(entry.monsterId) === String(target.monsterId)));
      }
      await this._restoreAfterMutation(wasEnabled, scopedConfig);
      restored = true;
      const refreshed = await this.readState(scopedConfig, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
      const persistedIds = new Set((refreshed.targets || []).map(target => String(target.monsterId)));
      const missing = selected.filter(target => !persistedIds.has(String(target.monsterId)));
      if (missing.length > 0) throw new Error(`Server acknowledged Auto Farm Add but did not retain: ${missing.map(target => target.monsterName).join(', ')}`);
      return { success: true, added: selected.length, state: refreshed, discarded, availableMonsterKeys };
    } catch (error) {
      if (wasEnabled && !restored) await this._restoreAfterMutation(true, scopedConfig).catch(() => null);
      throw error;
    }
  }

  async removeTarget(config = {}, targetId) {
    const state = await this.readState(config, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
    const target = state.targets.find(entry => String(entry.targetId) === String(targetId));
    if (!target) throw new Error('Auto Farm target no longer exists');
    const wasEnabled = await this._pauseForMutation(state, config);
    let restored = false;
    try {
      await this._mutateOnce(`Auto Farm target ${target.monsterId} remove`,
        () => this.gameAPI.removeAutoFarmTarget(target.targetId), config,
        fresh => !fresh.targets.some(entry => String(entry.targetId) === String(target.targetId)));
      await this._restoreAfterMutation(wasEnabled, config);
      restored = true;
      const refreshed = await this.readState(config, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
      return { success: true, removed: target, state: refreshed };
    } catch (error) {
      if (wasEnabled && !restored) await this._restoreAfterMutation(true, config).catch(() => null);
      throw error;
    }
  }

  _configuredTargets(config, state) {
    const idByName = new Map((state.monsters || []).map(monster => [monsterTypeKey(monster.name), String(monster.id)]));
    const desiredByMonsterId = new Map();
    const stablePolicies = config.targetPolicies || Object.fromEntries(
      Object.values(config.serverTargets || {}).filter(entry => entry?.monsterId).map(entry => [String(entry.monsterId), entry]),
    );
    for (const [monsterId, entry] of Object.entries(stablePolicies)) {
      if (!/^\d{1,30}$/.test(String(monsterId)) || !entry) continue;
      desiredByMonsterId.set(String(monsterId), { ...entry, monsterId: String(monsterId),
        enabled: entry.enabled === true, damageMode: Number(entry.damageMode) === 0 ? 0 : 1,
        minDamage: Math.max(0, Math.trunc(Number(entry.minDamage) || 0)),
        maxStack: Math.min(250, Math.max(1, Math.trunc(Number(entry.maxStack) || 1))) });
    }
    for (const [areaKey, entries] of Object.entries(config.maps || {})) {
      const area = getMonsterArea(areaKey);
      if (!supportsAutoFarm(area)) continue;
      for (const [key, entry] of Object.entries(entries || {})) {
        if (this.monsterCatalogService?.getRecord(areaKey, key)?.boss === true) continue;
        const explicitId = /^\d{1,30}$/.test(String(entry?.monsterId || '')) ? String(entry.monsterId) : null;
        const monsterId = explicitId || idByName.get(monsterTypeKey(entry?.name || key));
        if (!monsterId) continue;
        desiredByMonsterId.set(monsterId, { monsterKey: monsterTypeKey(key || entry.name), monsterName: entry.name,
          monsterId, areaKey, enabled: entry.enabled === true, damageMode: 1,
          minDamage: Math.max(0, Math.trunc(Number(entry.targetDamage) || 0)),
          maxStack: Math.min(250, Math.max(1, Math.trunc(Number(entry.maxStack) || 1))) });
      }
    }
    return [...desiredByMonsterId.values()];
  }

  async saveConfiguration(config = {}, options = {}) {
    const state = await this.readState(config, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
    const desired = this._configuredTargets(config, state);
    if (options.requireEnabledTarget === true && !desired.some(target => target.enabled === true)) throw new Error('Auto Farm has no enabled Targets');
    if (state.enabled === true) await this._pauseForMutation(state, config);
    await this._mutateOnce('Auto Farm settings save', () => this.gameAPI.saveAutoFarmSettings(config.settings || {}), config);

    const desiredById = new Map(desired.map(target => [String(target.monsterId), target]));
    const consumedIds = new Set();
    let updated = 0;
    let added = 0;
    let disabled = 0;
    for (const existing of state.targets) {
      const target = desiredById.get(String(existing.monsterId));
      if (target && !consumedIds.has(target.monsterId)) {
        consumedIds.add(target.monsterId);
        const changed = existing.enabled !== target.enabled || Number(existing.damageMode) !== target.damageMode
          || Number(existing.minDamage) !== target.minDamage || Number(existing.maxStack) !== target.maxStack;
        if (changed) {
          await this._mutateOnce(`Auto Farm target ${target.monsterId} update`,
            () => this.gameAPI.updateAutoFarmTarget({ ...target, targetId: existing.targetId }), config);
          updated++;
        }
      } else if (existing.enabled === true) {
        await this._mutateOnce(`Auto Farm target ${existing.monsterId} disable`,
          () => this.gameAPI.updateAutoFarmTarget({ ...existing, enabled: false }), config);
        disabled++;
      }
    }
    for (const target of desired) {
      if (consumedIds.has(target.monsterId) || target.enabled !== true) continue;
      await this._mutateOnce(`Auto Farm target ${target.monsterId} add`,
        () => this.gameAPI.addAutoFarmTarget(target), config,
        fresh => fresh.targets.some(entry => String(entry.monsterId) === target.monsterId));
      added++;
    }
    const shouldEnable = options.enable === true || (options.enable !== false && state.enabled === true);
    if (shouldEnable) await this._mutateOnce('Auto Farm start', () => this.gameAPI.toggleAutoFarm(true), config, fresh => fresh.enabled === true);
    const refreshed = await this.readState(config, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
    return { success: true, updated, added, disabled, targets: desired.filter(target => target.enabled).length, state: refreshed };
  }

  async syncAndStart(config = {}) {
    return this.saveConfiguration(config, { enable: true, requireEnabledTarget: true });
  }

  async pause(config = {}) {
    const effectiveConfig = Object.keys(config || {}).length > 0 ? config : (this.configProvider?.() || this.lastConfig || {});
    const state = await this.readState(effectiveConfig, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
    if (state.enabled !== true) return { success: true, skipped: true, message: 'Auto Farm is already paused', state };
    const result = await this._mutateOnce('Auto Farm pause', () => this.gameAPI.toggleAutoFarm(false), effectiveConfig, fresh => fresh.enabled !== true);
    const refreshed = await this.readState(effectiveConfig, { force: true, priority: ReadPriority.MUTATION_REVALIDATION });
    if (refreshed.enabled === true) throw autoFarmConflictError('Server Auto Farm could not be confirmed paused');
    return { ...result, state: refreshed };
  }

  async ensurePausedForPve(config = {}, { signal = null } = {}) {
    const playerLevel = Number(this.levelProvider?.());
    if (Number.isFinite(playerLevel) && playerLevel > 0 && playerLevel < AUTO_FARM_MINIMUM_LEVEL) {
      return {
        success: true,
        skipped: true,
        unavailable: true,
        reason: `Auto Farm unlocks at level ${AUTO_FARM_MINIMUM_LEVEL}`,
        state: { recognized: true, enabled: false, available: false },
      };
    }
    const state = await this.readState(config, { priority: ReadPriority.COMBAT, maxAgeMs: AUTO_FARM_UI_MAX_AGE_MS, signal });
    if (state.enabled !== true) return { success: true, skipped: true, state };
    try {
      return await this.pause(config);
    } catch (error) {
      if (error?.code === 'AUTO_FARM_ACTIVE') throw error;
      throw autoFarmConflictError(`Normal PvE is waiting because Auto Farm could not be paused: ${error.message}`);
    }
  }

  async reconcileAttackLock(config = {}) {
    this.invalidate('Server rejected a PvE attack because Auto Farm is running');
    try {
      return await this.pause(config);
    } catch (error) {
      if (error?.code === 'AUTO_FARM_ACTIVE') throw error;
      throw autoFarmConflictError(`Normal PvE is waiting because Auto Farm is still active: ${error.message}`);
    }
  }
}

module.exports = {
  AUTO_FARM_ATTACK_LOCK_MESSAGE,
  AUTO_FARM_MINIMUM_LEVEL,
  AUTO_FARM_RESOURCE_KEY,
  AUTO_FARM_UI_MAX_AGE_MS,
  AutoFarmService,
  isAutoFarmAttackLockMessage,
  normalizeAutoFarmObservation,
};
