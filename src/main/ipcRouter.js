/**
 * IPC Router
 * Registers all ipcMain handlers, grouped by domain.
 * Each handler is a thin proxy that delegates to the appropriate engine/manager.
 */

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { ipcMain, app, dialog } = require('electron');
const { Logger } = require('./logger');
const { mangaManager } = require('./mangaManager');
const { getDataDir } = require('./dataPaths');
const { getMonsterArea, listMonsterAreas, monsterTypeKey } = require('../engine/monsterCatalog');
const { stateStore } = require('../engine/stateStore');
const { estimateRewardXp } = require('../engine/lootRewardLedger');
const { resolveLootXpBoost } = require('../engine/progressionEngine');
const { ReadPriority } = require('../engine/worldState');
const { projectLootableArea } = require('../engine/lootDiscoveryService');

/**
 * Register all IPC handlers
 * @param {Object} deps - Dependencies
 * @param {import('./windowManager').WindowManager} deps.windowManager
 * @param {import('./sessionManager').SessionManager} deps.sessionManager
 * @param {import('./credentialManager').CredentialManager|null} deps.credentialManager
 * @param {Function} deps.getActiveAccount - Returns current active account name
 * @param {Function} deps.getActiveAccountKey - Returns the authenticated stable account key
 * @param {Function} deps.setActiveAccount - Sets active account name
 * @param {Function} deps.onLogin - Called when an account logs in, returns { success, account } or { success: false, error }
 * @param {Function} deps.onLogout - Called when user logs out
 * @param {Function} deps.getBotEngine - Returns current bot engine instance (may be null)
 * @param {Function} deps.getChapterFarmer - Returns current chapter farmer instance (may be null)
 * @param {Function} deps.getEnergyFarmEngine - Returns current energy farm engine instance (may be null)
 * @param {Function} deps.getConfigManager - Returns the canonical configuration manager
 * @param {Function} deps.getAutoFarmService - Returns the authenticated Auto Farm service
 * @param {Function} deps.getMonsterCatalogService - Returns the current Monster Catalog service
 * @param {Function} deps.getAreaDirectoryService - Returns the account-scoped Dungeon/Cube directory service
 * @param {Function} deps.getTargetDiscoveryService - Returns the account-scoped shared Target discovery service
 * @param {Function} deps.getLootDiscoveryService - Returns the shared loot-discovery cache
 * @param {Function} deps.getLoadoutService - Returns the current read-only loadout service
 * @param {Function} deps.getDamageObservationStore - Returns the persistent damage-observation store
 * @param {Function} deps.getXpModel - Returns the persistent per-account XP observation model
 * @param {Function} deps.getActivityHistoryStore - Returns the persistent target/loot activity history
 */
function registerIpcHandlers(deps) {
  const {
    windowManager,
    sessionManager,
    credentialManager,
    getActiveAccount,
    getActiveAccountKey,
    setActiveAccount,
    onLogin,
    onLogout,
    getBotEngine,
    getChapterFarmer,
    getEnergyFarmEngine,
    getConfigManager,
    getAutoFarmService,
    getMonsterCatalogService,
    getAreaDirectoryService,
    getTargetDiscoveryService,
    getLootDiscoveryService,
    getLoadoutService,
    getDamageObservationStore,
    getXpModel,
    getActivityHistoryStore,
    getAccountDatabase,
    getCubePvpService,
  } = deps;

  const validAccountName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
  const activeAccountRequest = requestedAccount => {
    const active = getActiveAccount();
    if (!validAccountName(active)) return { account: null, error: 'Game session not active' };
    if (requestedAccount !== undefined && requestedAccount !== null && requestedAccount !== active) {
      return { account: null, error: 'The active account changed before this request completed' };
    }
    return { account: active, error: null };
  };
  const autoFarmAccessError = () => {
    const account = getActiveAccount();
    const player = stateStore.getState();
    if (!account || player.accountName !== account || !Number(player.lastUpdated)) {
      return 'Auto Farm availability cannot be verified until account Level stats are loaded';
    }
    const level = Number(player.level);
    return Number.isFinite(level) && level >= 400
      ? null
      : `Auto Farm requires Level 400 (current Level: ${Number.isFinite(level) ? level : 'unknown'})`;
  };

  const observePageResources = (resources, source, observedAt = Date.now()) => {
    if (!resources || (!resources.hp && !resources.mp && !resources.stamina)) return;
    const reader = getBotEngine()?.gameReader;
    if (typeof reader?.observeResources === 'function') reader.observeResources(resources, source, { observedAt });
    else stateStore.update(resources);
  };

  // ─── Account Management ────────────────────────────────────────────

  ipcMain.handle('account:list', () => {
    return sessionManager ? sessionManager.listAccounts() : [];
  });

  ipcMain.handle('account:delete', async (event, accountName) => {
    if (!validAccountName(accountName)) return false;
    if (!sessionManager) return false;
    if (getActiveAccount() === accountName) {
      await onLogout();
    }
    const deleted = sessionManager.deleteAccount(accountName);
    if (deleted) {
      credentialManager?.delete(accountName);
      windowManager.destroyGameWindow(accountName);
    }
    return deleted;
  });

  ipcMain.handle('account:purge-active', async () => {
    const accountName = getActiveAccount();
    const stableAccountKey = getActiveAccountKey?.();
    if (!validAccountName(accountName) || !sessionManager) {
      return { success: false, error: 'No signed-in account is available to purge' };
    }
    if (!stableAccountKey) return { success: false, error: 'Authenticated account identity is unavailable' };
    const failures = [];
    const attempt = async (label, action) => {
      try {
        await action();
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    };

    await attempt('stop and logout', () => onLogout());
    await attempt('browser storage', () => windowManager.purgeAccountStorage(accountName));
    await attempt('damage observations', () => getDamageObservationStore?.()?.purgeAccount?.(accountName));
    await attempt('XP observations', () => getXpModel?.()?.purgeAccount?.(accountName));
    await attempt('chapter-farming data', () => mangaManager.purgeAccount(accountName));
    await attempt('saved credentials', () => credentialManager?.delete(accountName));
    await attempt('saved session', () => sessionManager.deleteAccount(accountName));
    await attempt('account logs', () => Logger.deleteAccountLogs(accountName));
    // Configuration, monster knowledge, Auto Farm ownership, histories,
    // statistics, events, and loot snapshots share one stable account record.
    // Delete it exactly once after runtime services have been torn down.
    await attempt('account database', () => getAccountDatabase().purgeAccount(stableAccountKey));
    setActiveAccount(null);
    stateStore.setAccount(null);

    if (failures.length > 0) {
      return { success: false, error: `Purge was incomplete: ${failures.join('; ')}`, accountName };
    }
    return { success: true, accountName };
  });

  ipcMain.handle('account:add-window', () => {
    windowManager.openAddAccountWindow();
    return { success: true };
  });

  ipcMain.handle('account:login', async (event, accountName) => {
    if (!validAccountName(accountName)) return { success: false, error: 'Invalid account name' };
    try {
      const result = await onLogin(accountName);
      return result;
    } catch (err) {
      Logger.logClient(accountName, `Login error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('bot:logout', async () => {
    await onLogout();
    return { success: true };
  });

  // ─── Browser View & App ────────────────────────────────────────────

  ipcMain.handle('game:open-browser', () => {
    const account = getActiveAccount();
    if (account) Logger.logUser(account, 'Opened game in browser viewer');
    return windowManager.showGameWindow();
  });

  ipcMain.handle('game:open-battle', async (event, pageUrl) => {
    const account = getActiveAccount();
    if (!account) return { success: false, error: 'Game session not active' };
    try {
      const result = await windowManager.openGameBattle(pageUrl);
      if (result.success) Logger.logUser(account, 'Opened a battle from activity history');
      return result;
    } catch (error) {
      Logger.logClient(account, `Could not open activity-history battle: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('history:list', (event, kind, request = 100) => {
    const account = getActiveAccount();
    const store = getActivityHistoryStore?.();
    if (!account || !store) return { success: false, error: 'Game session not active', entries: [] };
    if (!['target', 'loot'].includes(kind)) return { success: false, error: 'Invalid history type', entries: [] };
    const options = request && typeof request === 'object' && !Array.isArray(request)
      ? request
      : { limit: request };
    return { success: true, ...store.query(account, kind, options) };
  });

  ipcMain.handle('history:clear', (event, request = {}) => {
    const account = getActiveAccount();
    const store = getActivityHistoryStore?.();
    if (!account || !store) return { success: false, error: 'Game session not active' };
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return { success: false, error: 'Invalid history-clear request' };
    }
    const kinds = [...new Set((Array.isArray(request.kinds) ? request.kinds : [])
      .filter(kind => ['target', 'loot'].includes(kind)))];
    if (kinds.length === 0) return { success: false, error: 'Select attacking history, looting history, or both' };
    const before = request.before == null || request.before === '' ? null : String(request.before);
    if (before !== null && !Number.isFinite(Date.parse(before))) {
      return { success: false, error: 'History cutoff date is invalid' };
    }
    try {
      const result = store.clear(account, kinds, { before });
      Logger.logUser(account, `Cleared ${kinds.join(' and ')} history${before ? ` older than ${before}` : ''}`);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('statistics:get', (event, request = {}) => {
    const account = getActiveAccount();
    const store = getActivityHistoryStore?.();
    if (!account || !store) return { success: false, error: 'Game session not active' };
    const period = String(request?.period || '7d');
    if (!['24h', '7d', '30d', 'all'].includes(period)) {
      return { success: false, error: 'Invalid statistics period' };
    }
    const statistics = store.statistics?.(account, { period });
    return statistics
      ? { success: true, statistics }
      : { success: false, error: 'Statistics are unavailable' };
  });

  ipcMain.handle('app:quit', async () => {
    const account = getActiveAccount();
    if (account) Logger.logUser(account, 'Quit application');
    if (account) await onLogout();
    app.isQuitting = true;
    app.quit();
  });

  // ─── Bot Lifecycle ─────────────────────────────────────────────────

  ipcMain.handle('bot:start', () => {
    const account = getActiveAccount();
    Logger.logUser(account, 'Clicked Start Bot');
    const engine = getBotEngine();
    if (!engine || !account) return { success: false, error: 'Game session not active' };
    if (engine.isRunning || engine.loopPromise) return { success: false, error: 'Bot is already running' };
    // Starting is also an apply boundary. UI edits are persisted immediately,
    // but the running engine only adopts them here or through bot:apply-config.
    const config = getConfigManager().getConfig();
    if (config.general?.module === 'auto_farm') {
      const accessError = autoFarmAccessError();
      if (accessError) return { success: false, error: accessError };
    }
    engine.replaceConfig(config);
    const started = engine.start();
    if (started) getCubePvpService?.()?.start(config).catch(error => Logger.logClient(account, `Cube PvP start failed: ${error.message}`));
    return started ? { success: true } : { success: false, error: 'Bot is already running' };
  });

  ipcMain.handle('bot:pause', async () => {
    const account = getActiveAccount();
    Logger.logUser(account, 'Clicked Pause Bot');
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    try {
      const paused = await engine.pauseAndWait();
      if (paused) await getCubePvpService?.()?.stop();
      return paused ? { success: true } : { success: false, error: 'Bot is not running or already paused' };
    } catch (error) {
      return { success: false, error: `Bot paused locally, but server Auto Farm could not be paused: ${error.message}` };
    }
  });

  ipcMain.handle('bot:resume', () => {
    const account = getActiveAccount();
    Logger.logUser(account, 'Clicked Resume Bot');
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    const resumed = engine.resume();
    if (resumed) getCubePvpService?.()?.start(getConfigManager().getConfig()).catch(error => Logger.logClient(account, `Cube PvP resume failed: ${error.message}`));
    return resumed ? { success: true } : { success: false, error: 'Bot is not paused' };
  });

  ipcMain.handle('bot:stop', async () => {
    const account = getActiveAccount();
    Logger.logUser(account, 'Clicked Stop Bot');
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    try {
      const stopped = await engine.stopAndWait();
      if (stopped) await getCubePvpService?.()?.stop();
      return stopped ? { success: true } : { success: false, error: 'Bot is already stopped' };
    } catch (error) {
      return { success: false, error: `Bot stopped locally, but server Auto Farm could not be paused: ${error.message}` };
    }
  });

  // ─── Config & Telemetry ────────────────────────────────────────────

  ipcMain.handle('bot:update-config', (event, config) => {
    const account = getActiveAccount();
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { success: false, error: 'Invalid configuration payload' };
    }
    const normalized = (config.minDelay !== undefined || config.maxDelay !== undefined)
      ? { scheduler: { minDelay: config.minDelay, maxDelay: config.maxDelay } }
      : config;
    // Keep edits in the canonical persisted config until the user presses the
    // header Apply button. This prevents half-edited forms from changing a
    // live decision cycle underneath the engine.
    const before = getConfigManager().getConfig();
    const saved = getConfigManager().update(normalized);
    const changed = !isDeepStrictEqual(before, saved);
    if (changed) Logger.logUser(account, `Updated bot config: ${JSON.stringify(config)}`);
    return { success: true, changed, config: saved };
  });

  ipcMain.handle('bot:get-config', () => getConfigManager().getConfig());

  ipcMain.handle('bot:apply-config', async () => {
    const account = getActiveAccount();
    const engine = getBotEngine();
    if (!engine || !account) return { success: false, error: 'Game session not active' };
    const wasRunning = engine.isRunning === true;
    const wasPaused = engine.isPaused === true;
    let stoppedForApply = false;
    try {
      const config = getConfigManager().getConfig();
      if (config.general?.module === 'auto_farm') {
        const accessError = autoFarmAccessError();
        if (accessError) return { success: false, error: accessError };
      }
      if (wasRunning && !wasPaused) {
        await engine.stopAndWait();
        stoppedForApply = true;
        await getCubePvpService?.()?.stop();
      }
      engine.replaceConfig(config);
      const loadouts = await engine.applyConfiguredPveLoadouts();
      if (wasRunning && !wasPaused && !engine.start()) {
        throw new Error('The bot could not restart after applying its configuration');
      }
      if (wasRunning && !wasPaused) await getCubePvpService?.()?.start(config);
      Logger.logUser(account, `Applied pending configuration${wasRunning && !wasPaused ? ' and restarted the bot' : ''}`);
      return { success: true, restarted: wasRunning && !wasPaused, paused: wasPaused, loadouts };
    } catch (error) {
      if (stoppedForApply && !engine.isRunning) {
        try {
          engine.start();
          await getCubePvpService?.()?.start(getConfigManager().getConfig());
        } catch (restartError) {
          Logger.logClient(account, `[WARN] Bot restart after failed Apply also failed: ${restartError.message}`);
        }
      }
      return { success: false, error: `Could not apply configuration: ${error.message}` };
    }
  });

  ipcMain.handle('auto-farm:get-state', async (event, options = {}) => {
    const service = getAutoFarmService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    const accessError = autoFarmAccessError();
    if (accessError) return { success: false, error: accessError, unavailable: true };
    try {
      const config = getConfigManager().getConfig();
      return { success: true, state: await service.readState(config.autoFarm || {}, {
        force: options?.force === true,
        priority: ReadPriority.VISIBLE_UI,
      }) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('auto-farm:save', async () => {
    const service = getAutoFarmService?.();
    const engine = getBotEngine();
    if (!service || !engine) return { success: false, error: 'Game session not active' };
    const accessError = autoFarmAccessError();
    if (accessError) return { success: false, error: accessError, unavailable: true };
    try {
      const result = await service.saveExistingConfiguration(getConfigManager().getConfig().autoFarm || {});
      engine.autoFarmSynchronized = result.state?.enabled === true;
      engine.autoFarmServerEnabled = result.state?.enabled === true;
      Logger.logUser(getActiveAccount(), `Saved Auto Farm settings to the server (${result.targets} enabled targets)`);
      return result;
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Auto Farm save failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('auto-farm:add-targets', async (event, areaKey) => {
    const service = getAutoFarmService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    const accessError = autoFarmAccessError();
    if (accessError) return { success: false, error: accessError, unavailable: true };
    try {
      const config = getConfigManager().getConfig();
      const result = await service.addAreaTargets(config.autoFarm || {}, areaKey);
      if (Array.isArray(result.availableMonsterKeys)) {
        const allowed = new Set(result.availableMonsterKeys);
        const maps = JSON.parse(JSON.stringify(config.autoFarm?.maps || {}));
        maps[areaKey] = Object.fromEntries(Object.entries(maps[areaKey] || {}).filter(([monsterKey, entry]) => (
          allowed.has(monsterTypeKey(entry?.name || monsterKey))
        )));
        getConfigManager().replace({
          ...config,
          autoFarm: { ...(config.autoFarm || {}), maps },
        });
      }
      const discarded = result.discarded?.length ? `; removed ${result.discarded.length} stale cross-area row(s)` : '';
      Logger.logUser(getActiveAccount(), `Added ${result.added} Auto Farm target(s) from ${areaKey}${discarded}`);
      return result;
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Auto Farm target add failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('auto-farm:remove-target', async (event, targetId) => {
    const service = getAutoFarmService?.();
    if (!service || !/^\d{1,30}$/.test(String(targetId || ''))) return { success: false, error: 'Invalid Auto Farm target' };
    const accessError = autoFarmAccessError();
    if (accessError) return { success: false, error: accessError, unavailable: true };
    try {
      const config = getConfigManager().getConfig();
      const result = await service.removeTarget(config.autoFarm || {}, targetId);
      const nextPolicies = { ...(config.autoFarm?.targetPolicies || {}) };
      delete nextPolicies[String(result.removed?.monsterId || '')];
      const nextMaps = JSON.parse(JSON.stringify(config.autoFarm?.maps || {}));
      const removedKey = monsterTypeKey(result.removed?.monsterName);
      const removedArea = result.removed?.areaKey;
      if (removedArea && nextMaps[removedArea]?.[removedKey]) nextMaps[removedArea][removedKey].enabled = false;
      getConfigManager().replace({
        ...config,
        autoFarm: { ...(config.autoFarm || {}), maps: nextMaps, targetPolicies: nextPolicies },
      });
      Logger.logUser(getActiveAccount(), `Removed Auto Farm target ${targetId}`);
      return result;
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Auto Farm target remove failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('bot:export-config', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Save Veybot configuration',
      defaultPath: 'veybot-config.json',
      filters: [{ name: 'Veybot configuration', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
      const payload = {
        format: 'veybot-config',
        version: 1,
        exportedAt: new Date().toISOString(),
        config: getConfigManager().getConfig(),
      };
      fs.writeFileSync(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      Logger.logUser(getActiveAccount(), `Saved configuration preset: ${path.basename(result.filePath)}`);
      return { success: true, fileName: path.basename(result.filePath) };
    } catch (error) {
      return { success: false, error: `Could not save configuration: ${error.message}` };
    }
  });

  ipcMain.handle('bot:import-config', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Load Veybot configuration',
      properties: ['openFile'],
      filters: [{ name: 'Veybot configuration', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length !== 1) return { success: false, canceled: true };
    const filePath = result.filePaths[0];
    try {
      if (fs.statSync(filePath).size > 5 * 1024 * 1024) {
        return { success: false, error: 'Configuration file is larger than 5 MB' };
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { success: false, error: 'Configuration file must contain a JSON object' };
      }
      const wrapped = parsed.format !== undefined;
      if (wrapped && parsed.format !== 'veybot-config') {
        return { success: false, error: 'This JSON file is not a Veybot configuration' };
      }
      if (wrapped && parsed.version !== 1) {
        return { success: false, error: `Unsupported configuration version: ${parsed.version ?? 'missing'}` };
      }
      if (wrapped && (!parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config))) {
        return { success: false, error: 'Veybot configuration payload is missing' };
      }
      const imported = wrapped ? parsed.config : parsed;
      if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
        return { success: false, error: 'Configuration payload is missing' };
      }
      const config = getConfigManager().replace(imported);
      Logger.logUser(getActiveAccount(), `Loaded configuration preset: ${path.basename(filePath)}`);
      return { success: true, fileName: path.basename(filePath), config };
    } catch (error) {
      return { success: false, error: `Could not load configuration: ${error.message}` };
    }
  });

  const buildAccountBackup = (account, ownerHash = getActiveAccountKey?.()) => ({
    format: 'veybot-account-backup',
    version: 2,
    ownerHash,
    account: { displayName: account },
    exportedAt: new Date().toISOString(),
    config: getConfigManager().getConfig(),
    accountDatabase: getAccountDatabase().exportAccount(ownerHash),
    manga: mangaManager.exportAccount(account),
    damageObservations: getDamageObservationStore().exportAccount(account),
    xpObservations: getXpModel().exportAccount(account),
  });

  const atomicJsonWrite = (targetPath, payload) => {
    const temporary = `${targetPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, targetPath);
  };

  ipcMain.handle('account:export-data', async () => {
    const account = getActiveAccount();
    const ownerHash = getActiveAccountKey?.();
    if (!account || !ownerHash) return { success: false, error: 'Game session not active' };
    const result = await dialog.showSaveDialog({
      title: 'Export Veybot account data',
      defaultPath: `veybot-${account.replace(/[^a-z0-9_-]+/gi, '_')}-backup.json`,
      filters: [{ name: 'Veybot account backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
      atomicJsonWrite(result.filePath, buildAccountBackup(account, ownerHash));
      return { success: true, fileName: path.basename(result.filePath) };
    } catch (error) {
      return { success: false, error: `Could not export account data: ${error.message}` };
    }
  });

  ipcMain.handle('account:restore-data', async () => {
    const account = getActiveAccount();
    const ownerHash = getActiveAccountKey?.();
    if (!account || !ownerHash) return { success: false, error: 'Game session not active' };
    const selection = await dialog.showOpenDialog({
      title: 'Restore Veybot account data', properties: ['openFile'],
      filters: [{ name: 'Veybot account backup', extensions: ['json'] }],
    });
    if (selection.canceled || selection.filePaths.length !== 1) return { success: false, canceled: true };
    const sourcePath = selection.filePaths[0];
    try {
      if (fs.statSync(sourcePath).size > 25 * 1024 * 1024) throw new Error('Backup is larger than 25 MB');
      const backup = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      if (backup?.format !== 'veybot-account-backup' || ![1, 2].includes(backup.version)) throw new Error('Unsupported or invalid Veybot account backup');
      if (backup.version === 2 && backup.ownerHash !== ownerHash) {
        throw new Error('This backup belongs to another authenticated game account');
      }
      if (backup.version === 1 && backup.account !== account) {
        throw new Error(`This legacy backup belongs to ${backup.account || 'another account'}, not ${account}`);
      }
      for (const field of ['config', 'accountDatabase', 'manga', 'damageObservations', 'xpObservations']) {
        if (!backup[field] || typeof backup[field] !== 'object' || Array.isArray(backup[field])) throw new Error(`Backup field ${field} is missing or invalid`);
      }
      const confirmation = await dialog.showMessageBox({
        type: 'warning', buttons: ['Cancel', 'Restore'], defaultId: 0, cancelId: 0,
        title: 'Replace account data?',
        message: `Restore ${path.basename(sourcePath)} for ${account}?`,
        detail: 'The bot will stop. Current account data is saved to a local pre-restore snapshot before replacement.',
      });
      if (confirmation.response !== 1) return { success: false, canceled: true };
      await getBotEngine()?.stopAndWait?.();
      await getCubePvpService?.()?.stop?.();
      const backupDirectory = path.join(getDataDir(), 'backups');
      fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      const snapshotPath = path.join(backupDirectory, `pre-restore-${Date.now()}.json`);
      atomicJsonWrite(snapshotPath, buildAccountBackup(account, ownerHash));
      getAccountDatabase().replaceAccount(ownerHash, backup.accountDatabase);
      const config = getConfigManager().replace(backup.config);
      mangaManager.replaceAccount(account, backup.manga);
      getDamageObservationStore().replaceAccount(account, backup.damageObservations);
      getXpModel().replaceAccount(account, backup.xpObservations);
      return { success: true, fileName: path.basename(sourcePath), snapshotFile: path.basename(snapshotPath), config };
    } catch (error) {
      return { success: false, error: `Could not restore account data: ${error.message}` };
    }
  });

  ipcMain.handle('bot:get-telemetry', () => {
    const engine = getBotEngine();
    return engine ? engine.getTelemetry() : null;
  });

  ipcMain.handle('cube-pvp:get-status', () => ({ success: true, status: getCubePvpService?.()?.getStatus() || { state: 'unavailable' } }));
  ipcMain.handle('cube-pvp:get-overview', async (event, options = {}) => {
    const account = getActiveAccount();
    const service = getCubePvpService?.();
    if (!account || !service) return { success: false, error: 'Game session not active' };
    try {
      return { success: true, overview: await service.getOverview(undefined, {
        force: options?.force === true,
        priority: ReadPriority.VISIBLE_UI,
      }) };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle('cube-pvp:get-history', () => {
    const account = getActiveAccount();
    if (!account) return { success: false, error: 'Game session not active' };
    const events = getAccountDatabase().listEvents(account, { limit: 100 })
      .filter(event => ['cube_pvp_join', 'cube_pvp_state', 'cube_pvp_result'].includes(event.type));
    return { success: true, events };
  });
  ipcMain.handle('cube-pvp:open-match', async () => {
    const service = getCubePvpService?.();
    return await service?.openMatch() ? { success: true } : { success: false, error: 'No active Cube PvP match is being watched' };
  });

  ipcMain.handle('objectives:get-adventure-quests', async () => {
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    try {
      return { success: true, state: await engine.refreshObjectiveModule('adventure_quests', { force: true }) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('objectives:get-battle-pass', async () => {
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    try {
      return { success: true, state: await engine.refreshObjectiveModule('battle_pass', { force: true }) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('progression:update-settings', (event, progression) => {
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    if (!progression || typeof progression !== 'object' || Array.isArray(progression)) {
      return { success: false, error: 'Invalid Progression settings' };
    }
    const previous = getConfigManager().getConfig();
    const saved = getConfigManager().update({ progression });
    engine.updateConfig({ progression: saved.progression }, { persist: false });
    return { success: true, config: saved, changed: !isDeepStrictEqual(previous.progression, saved.progression) };
  });

  ipcMain.handle('progression:create-profile', (event, request = {}) => {
    try {
      const config = getConfigManager().createProgressionProfile(request.name);
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('progression:rename-profile', (event, request = {}) => {
    try {
      const config = getConfigManager().renameProgressionProfile(request.profileId, request.name);
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('progression:delete-profile', (event, profileId) => {
    try {
      const config = getConfigManager().deleteProgressionProfile(profileId);
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('progression:select-profile', (event, profileId) => {
    try {
      const config = getConfigManager().selectProgressionProfile(profileId);
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('combat:update-strategy', (event, combat) => {
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    if (!combat || typeof combat !== 'object' || Array.isArray(combat)) {
      return { success: false, error: 'Invalid Combat settings' };
    }
    const previous = getConfigManager().getConfig();
    const saved = getConfigManager().update({ combat });
    // Apply this complete, validated strategy as one runtime update. This keeps
    // Fixed/Adaptive mode and their two different hit limits from getting out
    // of sync while the bot is already running.
    engine.updateConfig({ combat: saved.combat }, { persist: false });
    return { success: true, config: saved, changed: !isDeepStrictEqual(previous.combat, saved.combat) };
  });

  ipcMain.handle('progression:refresh-loot', async () => {
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    try {
      const progression = await engine.refreshProgressionLoot();
      return { success: true, progression };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Progression loot scan failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('progression:list-available-loot', async () => {
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active', entries: [] };
    try {
      return { success: true, ...(await engine.refreshAvailableProgressionLoot()) };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Available loot scan failed: ${error.message}`);
      return { success: false, error: error.message, entries: [] };
    }
  });

  const enrichedLootSnapshot = async (areaKey, force = false) => {
    const service = getLootDiscoveryService?.();
    if (!service) throw new Error('Game session not active');
    const result = await service.progressionCandidates(areaKey, null, {
      force,
      maxAgeMs: force ? 0 : 60000,
      directoryPriority: ReadPriority.VISIBLE_UI,
      directoryMaxAgeMs: force ? 0 : 2500,
      forceDirectory: force,
    });
    const player = stateStore.getState();
    const boost = resolveLootXpBoost(player);
    return {
      areaKey: result.area?.key || areaKey,
      areaName: result.area?.label || areaKey,
      areaType: result.area?.type || '',
      hash: result.hash || null,
      refreshedAt: result.refreshedAt || Date.now(),
      candidates: (result.candidates || []).map(candidate => ({
        ...candidate,
        estimatedXp: estimateRewardXp(candidate, player.level, boost.multiplier),
      })),
      errors: result.errors || [],
    };
  };

  ipcMain.handle('loot-discovery:list', async (event, areaKey = null) => {
    const service = getLootDiscoveryService?.();
    if (!service) return { success: false, error: 'Game session not active', snapshots: [] };
    try {
      if (!areaKey) return { success: true, snapshots: service.list() };
      return { success: true, snapshots: [await enrichedLootSnapshot(areaKey, false)] };
    } catch (error) {
      return { success: false, error: error.message, snapshots: [] };
    }
  });

  ipcMain.handle('loot-discovery:refresh', async (event, areaKey) => {
    const service = getLootDiscoveryService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    try {
      const snapshot = await enrichedLootSnapshot(areaKey, true);
      windowManager?.sendToMain('loot-discovery:update', snapshot);
      return { success: true, snapshot };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Lootable scan failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('loot-discovery:claim', async (event, areaKey, candidateKey) => {
    const engine = getBotEngine();
    if (!engine || typeof areaKey !== 'string' || typeof candidateKey !== 'string'
      || areaKey.length > 100 || candidateKey.length > 220) {
      return { success: false, error: 'Invalid manual loot request' };
    }
    try {
      const result = await engine.claimDiscoveredLoot(areaKey, candidateKey);
      if (!result?.success) return { success: false, error: result?.message || 'Loot could not be claimed' };
      windowManager?.sendToMain('loot-discovery:update', {
        areaKey,
        ...(result.snapshot || {}),
      });
      Logger.logUser(getActiveAccount(), `Manually claimed discovered loot from ${areaKey}`);
      return { success: true, result };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Manual loot claim failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  // ─── Monster Configuration Discovery ──────────────────────────────

  ipcMain.handle('monsters:get-catalog', (event, includeHidden = false) => listMonsterAreas({ includeHidden: includeHidden === true }));

  ipcMain.handle('monsters:list-area', async (event, areaKey, force = false) => {
    const service = getTargetDiscoveryService?.() || getMonsterCatalogService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    try {
      const observedAt = Date.now();
      const result = await service.listArea(areaKey, { force: force === true });
      observePageResources(result.resources, 'verified Target discovery page resources', observedAt);
      Logger.logClient(getActiveAccount(), `Monster discovery found ${result.monsters.length} types for ${result.area.label}`);
      return { success: true, ...result };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Monster discovery failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('monsters:list-lootable-area', async (event, areaKey) => {
    const targetService = getTargetDiscoveryService?.();
    const lootService = getLootDiscoveryService?.();
    if (!targetService || !lootService) return { success: false, error: 'Game session not active' };
    try {
      const observedAt = Date.now();
      const [catalog, snapshot] = await Promise.all([
        targetService.listArea(areaKey, { maxAgeMs: 2500 }),
        lootService.scan(areaKey, {
          maxAgeMs: 60000,
          directoryPriority: ReadPriority.VISIBLE_UI,
          directoryMaxAgeMs: 2500,
        }),
      ]);
      const result = projectLootableArea(catalog, snapshot);
      observePageResources(result.resources, 'verified shared Looting projection resources', observedAt);
      Logger.logClient(
        getActiveAccount(),
        `Loot discovery found ${result.loot?.visibleLootable || 0} claimable kills across ${result.loot?.visibleLootActions || 0} actions for ${result.area.label}`,
      );
      return { success: true, ...result };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Loot discovery failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('monsters:get-stats', async (event, areaKey, monsterKey, refresh = false) => {
    const service = getMonsterCatalogService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    try {
      const result = await service.getMonsterStats(areaKey, monsterKey, { refresh: refresh === true });
      Logger.logClient(getActiveAccount(), `Loaded Monster Stats for ${areaKey}/${monsterKey}${result.cached ? ' from catalog' : ''}`);
      return { success: true, ...result };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Monster Stats failed for ${areaKey}/${monsterKey}: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('monsters:apply-observed-stats', async (event, areaKey, monsterKey) => {
    const service = getMonsterCatalogService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    try {
      const record = service.applyObservedMonsterStats(areaKey, monsterKey);
      Logger.logClient(getActiveAccount(), `Applied changed live Monster Stats for ${areaKey}/${monsterKey}`);
      return { success: true, record, conflict: false };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Changed Monster Stats could not be applied for ${areaKey}/${monsterKey}: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('monsters:collect-area-stats', async (event, areaKey) => {
    const service = getMonsterCatalogService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    try {
      const summary = await service.collectAreaStats(areaKey);
      Logger.logClient(getActiveAccount(), `Collected Monster Stats for ${summary.area.label}: ${summary.collected} read, ${summary.conflicts} conflicts, ${summary.errors.length} errors`);
      return { success: true, ...summary };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Monster Stats collection failed for ${areaKey}: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  // ─── Active Gear / Pet Loadout ────────────────────────────────────

  ipcMain.handle('loadouts:get-active', async (event, options = {}) => {
    const service = getLoadoutService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      return { success: false, error: 'Invalid loadout request' };
    }
    try {
      const snapshot = await service.getActiveLoadout({
        gearContext: options.gearContext,
        petContext: options.petContext,
        force: options.force === true,
        priority: ReadPriority.VISIBLE_UI,
      });
      Logger.logClient(
        getActiveAccount(),
        `Resolved active loadout ${snapshot.hash.value.slice(0, 12)}: ${snapshot.gear.equipped.length} Gear, ${snapshot.pets.equipped.length} Pets`,
      );
      return { success: true, snapshot };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Active loadout read failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('loadouts:get-saved-set', async (event, options = {}) => {
    const service = getLoadoutService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      return { success: false, error: 'Invalid saved-set request' };
    }
    try {
      const savedSet = await service.getSavedSet({
        kind: options.kind,
        setNumber: options.setNumber,
        context: options.context || 'attack',
        priority: ReadPriority.VISIBLE_UI,
      });
      return {
        success: true,
        savedSet: {
          ...savedSet,
          items: savedSet.items.map(item => ({
            name: item.name,
            attack: item.attack,
            defense: item.defense,
            ability: String(item.rawEffect || '').slice(0, 1000),
          })),
        },
      };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Saved Quick Set read failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('combat:get-strategy-status', async (event, force = false) => {
    const service = getLoadoutService?.();
    const observations = getDamageObservationStore?.();
    const account = getActiveAccount();
    if (!service || !observations || !account) return { success: false, error: 'Game session not active' };
    try {
      const snapshot = await service.getActiveLoadout({
        force: force === true,
        priority: ReadPriority.VISIBLE_UI,
      });
      return {
        success: true,
        loadout: {
          hash: snapshot.hash.value,
          observedAt: snapshot.observedAt,
          totals: snapshot.totals,
          gear: snapshot.gear.equipped.map(item => ({
            name: item.name,
            attack: item.attack,
            defense: item.defense,
            ability: String(item.rawEffect || '').slice(0, 1000),
          })),
          pets: snapshot.pets.equipped.map(item => ({
            name: item.name,
            attack: item.attack,
            defense: item.defense,
            ability: String(item.rawEffect || '').slice(0, 1000),
          })),
        },
        observations: observations.getSummary({ accountName: account, loadoutHash: snapshot.hash.value }),
      };
    } catch (error) {
      Logger.logClient(account, `Attack Strategy status read failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('combat:get-class-skills', async () => {
    const engine = getBotEngine();
    const account = getActiveAccount();
    if (!engine?.gameAPI || !account) return { success: false, error: 'Game session not active' };
    try {
      const parsed = await engine.gameAPI.getClassSkillTree();
      return {
        success: true,
        skillTree: {
          className: parsed.className,
          classPassive: parsed.classPassive,
          unlockedSkills: parsed.unlockedSkills,
        },
      };
    } catch (error) {
      Logger.logClient(account, `Class skill read failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  // ─── Stats ─────────────────────────────────────────────────────────

  ipcMain.handle('bot:refresh-stats', async () => {
    const engine = getBotEngine();
    if (!engine || !engine.gameReader) {
      return { success: false, error: 'Game session not active' };
    }
    const account = getActiveAccount();
    try {
      Logger.logApi(account, 'GET', 'https://demonicscans.org/stats.php', null, 'Manual stats refresh requested');
      await engine.refreshStats();
      const mangaList = mangaManager.getAccountMangaList(account);
      const targetSlug = (mangaList && mangaList.length > 0) ? mangaList[0].slug : 'The-Investor-Who-Sees-The-Future';
      await engine.gameReader.fetchFarmedEnergy(targetSlug, 1);

      const currentState = stateStore.getState();
      Logger.logApi(account, 'GET', 'https://demonicscans.org/stats.php', 200, 'Stats refreshed successfully');

      return { success: true, player: currentState, stats: currentState };
    } catch (err) {
      Logger.logApi(account, 'GET', 'https://demonicscans.org/stats.php', 500, `Error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('bot:get-farmed-energy', async (event, accountName) => {
    const engine = getBotEngine();
    if (!engine || !engine.gameReader) {
      return { success: false, error: 'Game session not active' };
    }
    const ownership = activeAccountRequest(accountName);
    if (ownership.error) return { success: false, error: ownership.error };
    const acc = ownership.account;
    try {
      const mangaList = mangaManager.getAccountMangaList(acc);
      const targetSlug = (mangaList && mangaList.length > 0) ? mangaList[0].slug : 'The-Investor-Who-Sees-The-Future';
      Logger.logApi(acc, 'GET', `https://demonicscans.org/title/${targetSlug}/chapter/1/1`, null, 'Fetching farmed energy from chapter');
      const energy = await engine.gameReader.fetchFarmedEnergy(targetSlug, 1);
      Logger.logApi(acc, 'GET', `https://demonicscans.org/title/${targetSlug}/chapter/1/1`, 200, `Farmed energy result: ${energy !== null ? energy : 'not found'}`);
      return { success: true, energy };
    } catch (err) {
      Logger.logApi(acc, 'GET', 'https://demonicscans.org/chapter', 500, `Energy fetch error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ─── Logging ───────────────────────────────────────────────────────

  ipcMain.handle('logs:get-user', () => {
    return Logger.getUserLogs(getActiveAccount());
  });

  ipcMain.handle('logs:get-client', () => {
    return Logger.getClientLogs(getActiveAccount());
  });

  ipcMain.handle('logs:get-auto', () => {
    return Logger.getClientLogs(getActiveAccount());
  });

  // ─── Manga Management ─────────────────────────────────────────────

  ipcMain.handle('manga:list', (event, accountName) => {
    const ownership = activeAccountRequest(accountName);
    return ownership.error ? [] : mangaManager.getAccountMangaList(ownership.account);
  });

  ipcMain.handle('manga:add', async (event, input, accountName) => {
    const ownership = activeAccountRequest(accountName);
    if (ownership.error) return { success: false, error: ownership.error };
    Logger.logUser(ownership.account, `Adding manga target: ${input}`);
    return await mangaManager.verifyAndAdd(input, ownership.account);
  });

  ipcMain.handle('manga:delete', (event, slug, accountName) => {
    const ownership = activeAccountRequest(accountName);
    if (ownership.error) return { success: false, error: ownership.error };
    Logger.logUser(ownership.account, `Deleted manga target: ${slug}`);
    return mangaManager.deleteManga(slug, ownership.account);
  });

  ipcMain.handle('manga:farm-settings:save', (event, settings, accountName) => {
    const ownership = activeAccountRequest(accountName);
    if (ownership.error) return { success: false, error: ownership.error };
    mangaManager.saveAccountFarmSettings(ownership.account, settings);
    return { success: true };
  });

  ipcMain.handle('manga:farm-settings:get', (event, accountName) => {
    const ownership = activeAccountRequest(accountName);
    return ownership.error ? {} : mangaManager.getAccountFarmSettings(ownership.account);
  });

  ipcMain.handle('manga:reload', async (event, accountName) => {
    const ownership = activeAccountRequest(accountName);
    if (ownership.error) return { success: false, error: ownership.error };
    Logger.logUser(ownership.account, 'Reloading all manga chapters');
    return await mangaManager.refreshAllManga(ownership.account);
  });

  ipcMain.handle('manga:refresh-single', async (event, slug, accountName) => {
    const ownership = activeAccountRequest(accountName);
    if (ownership.error) return { success: false, error: ownership.error };
    Logger.logUser(ownership.account, `Reloading manga chapters for "${slug}"`);
    return await mangaManager.refreshSingleManga(slug, ownership.account);
  });

  ipcMain.handle('manga:logs', () => {
    return mangaManager.getLogs();
  });

  // ─── Energy Farm Actions ───────────────────────────────────────────

  ipcMain.handle('energy:start', async (event, { targetManga, chapterCount = 1 } = {}) => {
    const energyFarmEngine = getEnergyFarmEngine();
    if (!energyFarmEngine) {
      return { success: false, message: 'Game session not active' };
    }
    const account = getActiveAccount();
    Logger.logUser(account, `Triggered Energy Farm for: ${targetManga}`);
    if (typeof targetManga !== 'string' || targetManga.length > 300) {
      return { success: false, message: 'Invalid manga target' };
    }
    const requestedCount = Number(chapterCount);
    if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 1000) {
      return { success: false, message: 'Chapter count must be between 1 and 1000' };
    }
    if (getConfigManager().getConfig().safety.dryRun) {
      return { success: false, dryRun: true, message: 'Dry run is enabled. Disable it in Home → Bot before sending chapter reactions.' };
    }
    const manga = mangaManager.getAccountMangaList(account).find(item => item.slug === targetManga);
    if (!manga) return { success: false, message: 'Manga target is not configured for this account' };
    const firstChapter = (manga.farmedCount || 0) + 1;
    if (manga.chapters && firstChapter > manga.chapters) {
      return { success: false, message: 'All known chapters for this manga were already farmed' };
    }
    const reaction = getConfigManager().getConfig().energyFarming.reactionType;
    const available = manga.chapters ? Math.max(0, manga.chapters - firstChapter + 1) : requestedCount;
    const count = Math.min(requestedCount, available);
    const results = [];
    for (let offset = 0; offset < count; offset++) {
      const chapter = firstChapter + offset;
      windowManager.sendToMain('energy:progress', {
        type: 'start', targetManga, chapter, current: offset + 1, total: count,
      });
      const result = await energyFarmEngine.farmChapter(account, targetManga, chapter, reaction);
      results.push({ chapter, ...result });
      windowManager.sendToMain('energy:progress', {
        type: result?.success ? 'success' : 'error',
        targetManga,
        chapter,
        current: offset + 1,
        total: count,
        message: result?.message || '',
      });
      if (!result?.success) break;
      mangaManager.incrementFarmedCount(account, targetManga);
      getActivityHistoryStore?.()?.recordEvent?.(account, 'chapter_farm', {
        manga: targetManga,
        chapter,
        staminaGained: Number(result.energy) || 2,
        reaction: result.reactionCode,
      });
    }
    const completed = results.filter(result => result.success).length;
    const last = results.at(-1);
    const response = {
      success: completed === count && count > 0,
      requested: requestedCount,
      attempted: results.length,
      completed,
      results,
      message: completed === count
        ? `Farmed ${completed} chapter${completed === 1 ? '' : 's'} successfully.`
        : (last?.message || 'Farming stopped before all requested chapters completed.'),
    };
    if (completed > 0) {
      const lastChapter = firstChapter + completed - 1;
      const engine = getBotEngine();
      const energy = await engine?.gameReader?.fetchFarmedEnergy(targetManga, lastChapter);
      if (energy !== null && energy !== undefined) response.energy = energy;
    }
    return response;
  });

  ipcMain.handle('energy:farm-single-chapter', async (event, { slug, chapterNum, reactionType } = {}) => {
    const chapterFarmer = getChapterFarmer();
    if (!chapterFarmer) {
      return { success: false, message: 'Game session not active' };
    }
    if (getConfigManager().getConfig().safety.dryRun) {
      return { success: false, dryRun: true, message: 'Dry run is enabled. Chapter reaction was blocked.' };
    }
    if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]+$/.test(slug) || !Number.isInteger(Number(chapterNum))) {
      return { success: false, message: 'Invalid chapter request' };
    }
    const account = getActiveAccount();
    Logger.logUser(account, `Triggered reaction farm for ${slug} Ch.${chapterNum}`);
    const result = await chapterFarmer.farmSingleChapter(account, slug, chapterNum, reactionType);
    if (result.success) {
      getActivityHistoryStore?.()?.recordEvent?.(account, 'chapter_farm', {
        manga: slug,
        chapter: Number(chapterNum),
        staminaGained: 2,
        reaction: result.reactionCode,
      });
    }
    return result;
  });
}

module.exports = { registerIpcHandlers };
