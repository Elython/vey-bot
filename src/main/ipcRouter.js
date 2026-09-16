/**
 * IPC Router
 * Registers all ipcMain handlers, grouped by domain.
 * Each handler is a thin proxy that delegates to the appropriate engine/manager.
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, app, dialog } = require('electron');
const { Logger } = require('./logger');
const { mangaManager } = require('./mangaManager');
const { listMonsterAreas } = require('../engine/monsterCatalog');
const { stateStore } = require('../engine/stateStore');

/**
 * Register all IPC handlers
 * @param {Object} deps - Dependencies
 * @param {import('./windowManager').WindowManager} deps.windowManager
 * @param {import('./sessionManager').SessionManager} deps.sessionManager
 * @param {import('./credentialManager').CredentialManager|null} deps.credentialManager
 * @param {Function} deps.getActiveAccount - Returns current active account name
 * @param {Function} deps.setActiveAccount - Sets active account name
 * @param {Function} deps.onLogin - Called when an account logs in, returns { success, account } or { success: false, error }
 * @param {Function} deps.onLogout - Called when user logs out
 * @param {Function} deps.getBotEngine - Returns current bot engine instance (may be null)
 * @param {Function} deps.getChapterFarmer - Returns current chapter farmer instance (may be null)
 * @param {Function} deps.getEnergyFarmEngine - Returns current energy farm engine instance (may be null)
 * @param {Function} deps.getConfigManager - Returns the canonical configuration manager
 * @param {Function} deps.getMonsterCatalogService - Returns the current Monster Catalog service
 * @param {Function} deps.getLoadoutService - Returns the current read-only loadout service
 * @param {Function} deps.getDamageObservationStore - Returns the persistent damage-observation store
 */
function registerIpcHandlers(deps) {
  const {
    windowManager,
    sessionManager,
    credentialManager,
    getActiveAccount,
    setActiveAccount,
    onLogin,
    onLogout,
    getBotEngine,
    getChapterFarmer,
    getEnergyFarmEngine,
    getConfigManager,
    getMonsterCatalogService,
    getLoadoutService,
    getDamageObservationStore,
  } = deps;

  const validAccountName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;

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
    const started = engine.start();
    return started ? { success: true } : { success: false, error: 'Bot is already running' };
  });

  ipcMain.handle('bot:pause', () => {
    const account = getActiveAccount();
    Logger.logUser(account, 'Clicked Pause Bot');
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    return engine.pause() ? { success: true } : { success: false, error: 'Bot is not running or already paused' };
  });

  ipcMain.handle('bot:resume', () => {
    const account = getActiveAccount();
    Logger.logUser(account, 'Clicked Resume Bot');
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    return engine.resume() ? { success: true } : { success: false, error: 'Bot is not paused' };
  });

  ipcMain.handle('bot:stop', () => {
    const account = getActiveAccount();
    Logger.logUser(account, 'Clicked Stop Bot');
    const engine = getBotEngine();
    if (!engine) return { success: false, error: 'Game session not active' };
    return engine.stop() ? { success: true } : { success: false, error: 'Bot is already stopped' };
  });

  // ─── Config & Telemetry ────────────────────────────────────────────

  ipcMain.handle('bot:update-config', (event, config) => {
    const account = getActiveAccount();
    Logger.logUser(account, `Updated bot config: ${JSON.stringify(config)}`);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { success: false, error: 'Invalid configuration payload' };
    }
    const engine = getBotEngine();
    const normalized = (config.minDelay !== undefined || config.maxDelay !== undefined)
      ? { scheduler: { minDelay: config.minDelay, maxDelay: config.maxDelay } }
      : config;
    const saved = engine ? engine.updateConfig(normalized) : getConfigManager().update(normalized);
    return { success: true, config: saved };
  });

  ipcMain.handle('bot:get-config', () => {
    const engine = getBotEngine();
    return engine ? engine.config : getConfigManager().getConfig();
  });

  ipcMain.handle('bot:export-config', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Save Veybot configuration',
      defaultPath: 'veybot-config.json',
      filters: [{ name: 'Veybot configuration', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
      const engine = getBotEngine();
      const payload = {
        format: 'veybot-config',
        version: 1,
        exportedAt: new Date().toISOString(),
        config: engine ? engine.config : getConfigManager().getConfig(),
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
      const engine = getBotEngine();
      const config = engine
        ? engine.replaceConfig(imported)
        : getConfigManager().replace(imported);
      Logger.logUser(getActiveAccount(), `Loaded configuration preset: ${path.basename(filePath)}`);
      return { success: true, fileName: path.basename(filePath), config };
    } catch (error) {
      return { success: false, error: `Could not load configuration: ${error.message}` };
    }
  });

  ipcMain.handle('bot:get-telemetry', () => {
    const engine = getBotEngine();
    return engine ? engine.getTelemetry() : null;
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

  // ─── Monster Configuration Discovery ──────────────────────────────

  ipcMain.handle('monsters:get-catalog', () => listMonsterAreas());

  ipcMain.handle('monsters:list-area', async (event, areaKey) => {
    const service = getMonsterCatalogService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    try {
      const result = await service.listArea(areaKey);
      if (result.resources?.hp || result.resources?.mp) stateStore.update(result.resources);
      Logger.logClient(getActiveAccount(), `Monster discovery found ${result.monsters.length} types for ${result.area.label}`);
      return { success: true, ...result };
    } catch (error) {
      Logger.logClient(getActiveAccount(), `Monster discovery failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('monsters:list-lootable-area', async (event, areaKey) => {
    const service = getMonsterCatalogService?.();
    if (!service) return { success: false, error: 'Game session not active' };
    try {
      const result = await service.listLootableArea(areaKey);
      if (result.resources?.hp || result.resources?.mp) stateStore.update(result.resources);
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
      const snapshot = await service.getActiveLoadout({ force: force === true });
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
    try {
      const acc = accountName || getActiveAccount();
      const mangaList = mangaManager.getAccountMangaList(acc);
      const targetSlug = (mangaList && mangaList.length > 0) ? mangaList[0].slug : 'The-Investor-Who-Sees-The-Future';
      Logger.logApi(acc, 'GET', `https://demonicscans.org/title/${targetSlug}/chapter/1/1`, null, 'Fetching farmed energy from chapter');
      const energy = await engine.gameReader.fetchFarmedEnergy(targetSlug, 1);
      Logger.logApi(acc, 'GET', `https://demonicscans.org/title/${targetSlug}/chapter/1/1`, 200, `Farmed energy result: ${energy !== null ? energy : 'not found'}`);
      return { success: true, energy };
    } catch (err) {
      const acc = getActiveAccount();
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
    return mangaManager.getAccountMangaList(accountName || getActiveAccount());
  });

  ipcMain.handle('manga:add', async (event, input, accountName) => {
    Logger.logUser(getActiveAccount(), `Adding manga target: ${input}`);
    return await mangaManager.verifyAndAdd(input, accountName || getActiveAccount());
  });

  ipcMain.handle('manga:delete', (event, slug, accountName) => {
    Logger.logUser(getActiveAccount(), `Deleted manga target: ${slug}`);
    return mangaManager.deleteManga(slug, accountName || getActiveAccount());
  });

  ipcMain.handle('manga:farm-settings:save', (event, settings, accountName) => {
    return mangaManager.saveAccountFarmSettings(accountName || getActiveAccount(), settings);
  });

  ipcMain.handle('manga:farm-settings:get', (event, accountName) => {
    return mangaManager.getAccountFarmSettings(accountName || getActiveAccount());
  });

  ipcMain.handle('manga:reload', async (event, accountName) => {
    Logger.logUser(getActiveAccount(), 'Reloading all manga chapters');
    return await mangaManager.refreshAllManga(accountName || getActiveAccount());
  });

  ipcMain.handle('manga:refresh-single', async (event, slug, accountName) => {
    Logger.logUser(getActiveAccount(), `Reloading manga chapters for "${slug}"`);
    return await mangaManager.refreshSingleManga(slug, accountName || getActiveAccount());
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
    return await chapterFarmer.farmSingleChapter(account, slug, chapterNum, reactionType);
  });
}

module.exports = { registerIpcHandlers };
