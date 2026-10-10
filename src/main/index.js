/**
 * Main Process Entry Point (Bootstrap)
 * Thin orchestrator — creates services, wires dependencies, boots the app.
 * All window management lives in windowManager.js, IPC in ipcRouter.js.
 */

const { app, BrowserWindow, safeStorage } = require('electron');
const path = require('path');
const { BotEngine } = require('../engine/botEngine');
const { EnergyFarmEngine } = require('../engine/energyFarm');
const { ChapterFarmer } = require('../engine/chapterFarmer');
const { ConfigManager } = require('../engine/configManager');
const { HttpClient } = require('../engine/httpClient');
const { GameAPI } = require('../engine/gameAPI');
const { GameReader } = require('../engine/gameReader');
const { GameController } = require('../engine/gameController');
const { BattleManager } = require('../engine/battleManager');
const { StrategyEngine } = require('../engine/strategyEngine');
const { ModuleRegistry } = require('../engine/moduleRegistry');
const { ResourcePolicyEngine } = require('../engine/resourcePolicyEngine');
const { MonsterCatalogService } = require('../engine/monsterCatalogService');
const { LoadoutService } = require('../engine/loadoutService');
const { AttackPlanner } = require('../engine/attackPlanner');
const { DamageObservationStore } = require('../engine/damageObservationStore');
const { XpModel } = require('../engine/xpModel');
const { ProgressionEngine } = require('../engine/progressionEngine');
const { ActivityHistoryStore } = require('../engine/activityHistoryStore');
const { AccountDatabase } = require('../engine/accountDatabase');
const { AutoFarmService } = require('../engine/autoFarmService');
const { LootDiscoveryService } = require('../engine/lootDiscoveryService');
const { CubePvPService } = require('../engine/cubePvpService');
const { PowerCrystalService } = require('../engine/powerCrystalService');
const { ObjectiveModuleService } = require('../engine/objectiveModuleService');
const { AreaDirectoryService } = require('../engine/areaDirectoryService');
const { TargetDiscoveryService } = require('../engine/targetDiscoveryService');
const { StatsService } = require('../engine/statsService');
const { AreaAccessService } = require('../engine/areaAccessService');
const { deriveDiscoveryDemand } = require('../engine/discoveryDemand');
const {
  CollectorRegistry,
  ReadCoordinator,
  ReadPriority,
  WorldDomain,
  WorldStateService,
  accountKeyFromUserId,
} = require('../engine/worldState');
const { TimingEngine } = require('../scheduler/timingEngine');
const { SessionManager } = require('./sessionManager');
const { CredentialManager } = require('./credentialManager');
const { WindowManager } = require('./windowManager');
const { registerIpcHandlers } = require('./ipcRouter');
const { Logger } = require('./logger');
const { mangaManager } = require('./mangaManager');
const { stateStore } = require('../engine/stateStore');
const { createCoalescedRunner } = require('./coalescedRunner');
const {
  getDataDirectory,
  getDataPath,
  initializeAppDataDirectory,
} = require('../dataDirectory');

let windowManager = null;
let sessionManager = null;
let credentialManager = null;
let botEngine = null;
let energyFarmEngine = null;
let chapterFarmer = null;
let configManager = null;
let autoFarmService = null;
let monsterCatalogService = null;
let areaDirectoryService = null;
let targetDiscoveryService = null;
let lootDiscoveryService = null;
let statsService = null;
let areaAccessService = null;
let loadoutService = null;
let damageObservationStore = null;
let xpModel = null;
let activityHistoryStore = null;
let accountDatabase = null;
let cubePvpService = null;
let powerCrystalService = null;
let collectorRegistry = null;
let worldStateService = null;
let readCoordinator = null;
let worldStateAccountKey = null;
let activeAccount = null;
let hourlyCheckTimer = null;
let hourlyJitterTimer = null;
let pollingGeneration = 0;
let loginPromise = null;
let loginAccount = null;
let gameWindowEventCleanup = null;
let lootScanTimer = null;
let lootScanGeneration = 0;
let lootScanCursor = 0;
const lootScanFailures = new Map();

// ─── StateStore → Renderer bridge ────────────────────────────────────

stateStore.on('change', (state) => {
  if (state.accountName && state.accountName === activeAccount) {
    windowManager?.sendToMain('bot:stats', state);
  }
});

// ─── Account Login / Logout Logic ────────────────────────────────────

async function handleLogin(accountName) {
  if (botEngine && activeAccount === accountName) {
    return { success: true, account: accountName, stats: stateStore.getState() };
  }
  if (loginPromise) {
    if (loginAccount === accountName) return loginPromise;
    return { success: false, error: `Another account (${loginAccount}) is still logging in` };
  }

  loginAccount = accountName;
  const currentLogin = performLogin(accountName);
  loginPromise = currentLogin;
  try {
    return await currentLogin;
  } finally {
    if (loginPromise === currentLogin) {
      loginPromise = null;
      loginAccount = null;
    }
  }
}

async function performLogin(accountName) {
  const savedAccount = sessionManager.listAccounts().some(account => account.name === accountName);
  if (!savedAccount) return { success: false, error: 'Saved account was not found' };
  if (botEngine) await handleLogout();
  activeAccount = accountName;
  Logger.logUser(accountName, `Logged into account: ${accountName}`);

  try {
    await windowManager.setupGameWindow(accountName);
  } catch (error) {
    activeAccount = null;
    windowManager.finalizeAddAccountLogin(accountName, false);
    throw error;
  }
  const wc = windowManager.getGameWebContents();
  if (!wc || /signin\.php|\/login/i.test(wc.getURL())) {
    activeAccount = null;
    configManager.setActiveAccount(null);
    return { success: false, error: 'Saved session is expired. Please add the account again.' };
  }

  // Authentication uses the default scheduler only. Do not activate any
  // AccountDatabase record until the stable numeric user ID is verified.
  configManager.setActiveAccount(null);
  let config = configManager.getConfig();
  const timingEngine = new TimingEngine(config.scheduler);
  const httpClient = new HttpClient(wc, accountName, timingEngine);
  mangaManager.setHttpClient(httpClient);
  const gameAPI = new GameAPI(httpClient, accountName);
  const gameUserId = await gameAPI.getAuthenticatedUserId();
  worldStateAccountKey = accountKeyFromUserId(gameUserId);
  const accountBinding = accountDatabase.bindStableAccount(worldStateAccountKey, accountName);
  if (accountBinding.conflict) {
    Logger.logClient(accountName, 'A legacy display-name account record was preserved for manual recovery because stable account data already existed.');
  }
  configManager.setActiveAccount({ accountKey: worldStateAccountKey, displayName: accountName });
  // Read historical Chapter preferences once, after stable account binding.
  configManager.migrateChapterSettings(mangaManager.getAccountFarmSettings(accountName));
  config = configManager.getConfig();
  timingEngine.updateConfig(config.scheduler);
  areaAccessService = new AreaAccessService(gameAPI);
  monsterCatalogService = new MonsterCatalogService(gameAPI, {
    accountDatabase,
    accountName,
    accountKey: worldStateAccountKey,
    levelProvider: () => stateStore.getState().level,
    areaAccessService,
  });
  worldStateService = new WorldStateService();
  worldStateService.ensureAccount(worldStateAccountKey, { displayName: accountName });
  collectorRegistry = new CollectorRegistry();
  readCoordinator = new ReadCoordinator({
    worldStateService,
    collectorRegistry,
    maxConcurrency: 3,
  });
  const objectiveModuleService = new ObjectiveModuleService(gameAPI, {
    mode: 'shared',
    readCoordinator,
    accountKey: worldStateAccountKey,
  });
  collectorRegistry.register(WorldDomain.BATTLE_PASS, objectiveModuleService.getCollector('battle_pass'));
  collectorRegistry.register(WorldDomain.ADVENTURE_QUESTS, objectiveModuleService.getCollector('adventure_quests'));
  areaDirectoryService = new AreaDirectoryService({
    gameAPI,
    mode: 'shared',
    readCoordinator,
    accountKey: worldStateAccountKey,
  });
  collectorRegistry.register(WorldDomain.AREA_INSTANCES, areaDirectoryService);
  targetDiscoveryService = new TargetDiscoveryService({
    monsterCatalogService,
    areaDirectoryService,
    mode: 'shared',
    readCoordinator,
    accountKey: worldStateAccountKey,
  });
  collectorRegistry.register(WorldDomain.MONSTER_INSTANCES, targetDiscoveryService);
  statsService = new StatsService({
    gameAPI,
    mode: 'shared',
    readCoordinator,
    worldStateService,
    accountKey: worldStateAccountKey,
    accountName,
    stateStore,
    areaAccessService,
  });
  collectorRegistry.register(WorldDomain.STATS, statsService);
  autoFarmService = new AutoFarmService(gameAPI, monsterCatalogService, {
    mode: 'shared',
    readCoordinator,
    accountKey: worldStateAccountKey,
    configProvider: () => configManager.getConfig().autoFarm || {},
    levelProvider: () => stateStore.getState().level,
  });
  collectorRegistry.register(WorldDomain.AUTO_FARM, autoFarmService.getCollector());
  lootDiscoveryService = new LootDiscoveryService(monsterCatalogService, accountName, undefined, {
    mode: 'shared',
    accountDatabase,
    areaDirectoryService,
    readCoordinator,
    accountKey: worldStateAccountKey,
  });
  collectorRegistry.register(WorldDomain.LOOT_CANDIDATES, lootDiscoveryService);
  loadoutService = new LoadoutService(gameAPI, accountName, {
    mode: 'shared',
    readCoordinator,
    accountKey: worldStateAccountKey,
  });
  collectorRegistry.register(WorldDomain.LOADOUT, loadoutService.getCollector());
  const gameController = new GameController(gameAPI, timingEngine);
  powerCrystalService = new PowerCrystalService({ gameAPI, configManager, loadoutService, gameController });
  const battleManager = new BattleManager(gameAPI, gameController, accountName);
  const moduleRegistry = new ModuleRegistry();
  const attackPlanner = new AttackPlanner(config);
  const strategyEngine = new StrategyEngine(config, accountName, moduleRegistry, attackPlanner);
  const resourcePolicyEngine = new ResourcePolicyEngine(config);
  const progressionEngine = new ProgressionEngine(config, xpModel);
  const gameReader = new GameReader(wc, gameAPI, httpClient, accountName, statsService, areaAccessService);
  chapterFarmer = new ChapterFarmer(httpClient, timingEngine);
  energyFarmEngine = new EnergyFarmEngine(chapterFarmer);
  botEngine = new BotEngine({
    allowSoloPvp: false,
    accountName,
    accountKey: worldStateAccountKey,
    configManager,
    config,
    timingEngine,
    httpClient,
    gameAPI,
    gameController,
    gameReader,
    battleManager,
    strategyEngine,
    moduleRegistry,
    resourcePolicyEngine,
    loadoutService,
    powerCrystalService,
    monsterCatalogService,
    targetDiscoveryService,
    lootDiscoveryService,
    damageObservationStore,
    xpModel,
    progressionEngine,
    activityHistoryStore,
    autoFarmService,
    objectiveModuleService,
    windowManager,
    chapterFarmer,
    getMangaTargets: account => mangaManager.getAccountMangaList(account),
    onChapterCycleReset: (account, cycleId) => mangaManager.resetFarmCycle(account, cycleId),
    onChapterFarmed: (account, slug, details = {}) => {
      mangaManager.incrementFarmedCount(account, slug, details.chapter);
      if (details.automatic === true) {
        windowManager?.sendToMain('energy:progress', {
          automatic: true,
          status: details.duplicate ? 'duplicate' : 'success',
          slug,
          chapter: details.chapter,
          staminaGained: details.staminaGained || 0,
          message: details.message || '',
        });
      }
    },
  });
  cubePvpService = new CubePvPService({
    gameAPI,
    windowManager,
    configManager,
    accountDatabase,
    areaDirectoryService,
    readCoordinator,
    worldStateService,
    accountKey: worldStateAccountKey,
    mode: 'shared',
    accountName,
  });
  collectorRegistry.register(WorldDomain.CUBE, cubePvpService.getCollector());
  botEngine.customRunCubeStatus = () => cubePvpService?.getStatus();
  botEngine.on('custom-run-step', config => {
    cubePvpService?.start(config).catch(error => Logger.logClient(accountName,'Custom Run Cube update failed: '+error.message));
  });
  cubePvpService.on('status', status => {
    windowManager?.sendToMain('cube-pvp:status', status);
    Logger.logClient(accountName, `[Cube PvP] ${status.state}${status.waitReason ? `: ${status.waitReason}` : ''}${status.error ? `: ${status.error}` : ''}`);
  });
  stateStore.setAccount(accountName);

  // Start hourly stats polling
  setupHourlyChecks();
  setupLootDiscoveryChecks();

  // Wire engine events → renderer + logger
  wireEngineEvents();

  // Wire game page navigation events
  wireGameWindowEvents();
  await botEngine.gameReader.injectDOMObserver();

  // Dashboard authentication is sufficient to start the engine. Stats are
  // fetched in the background session without navigating the browser away.
  let initialStats = stateStore.getState();
  let warning = null;
  try {
    initialStats = await botEngine.refreshStats();
  } catch (error) {
    warning = `Initial Stats refresh was deferred: ${error.message}`;
    Logger.logClient(accountName, warning);
  }
  const mangaList = mangaManager.getAccountMangaList(accountName);
  const targetSlug = mangaList?.[0]?.slug || 'The-Investor-Who-Sees-The-Future';
  try {
    await botEngine.gameReader.fetchFarmedEnergy(targetSlug, 1);
  } catch (error) {
    Logger.logClient(accountName, `Initial farmed-energy read deferred: ${error.message}`);
  }

  windowManager.finalizeAddAccountLogin(accountName, true);
  return { success: true, account: accountName, stats: stateStore.getState() || initialStats, warning };
}

async function handleLogout() {
  if (activeAccount) {
    Logger.logUser(activeAccount, 'Logged out from account');
  }
  if (hourlyCheckTimer) {
    clearTimeout(hourlyCheckTimer);
    hourlyCheckTimer = null;
  }
  pollingGeneration += 1;
  if (hourlyJitterTimer) {
    clearTimeout(hourlyJitterTimer);
    hourlyJitterTimer = null;
  }
  lootScanGeneration += 1;
  lootScanFailures.clear();
  if (lootScanTimer) {
    clearTimeout(lootScanTimer);
    lootScanTimer = null;
  }
  if (botEngine) {
    try {
      await botEngine.stopAndWait();
    } catch (error) {
      Logger.logClient(activeAccount, `Auto Farm pause during logout failed: ${error.message}`);
    }
  }
  await cubePvpService?.stop?.();
  await powerCrystalService?.dispose?.();
  await lootDiscoveryService?.whenIdle?.();
  statsService?.dispose?.();
  if (readCoordinator && worldStateAccountKey) {
    try {
      readCoordinator.cancelAccount(worldStateAccountKey);
    } catch (error) {
      Logger.logClient(activeAccount, `Target discovery cancellation failed: ${error.message}`);
    }
  }
  readCoordinator?.dispose?.();
  if (worldStateService && worldStateAccountKey) {
    try {
      worldStateService.dropAccount(worldStateAccountKey);
    } catch (error) {
      Logger.logClient(activeAccount, `World State account cleanup failed: ${error.message}`);
    }
  }
  worldStateService?.dispose?.();
  collectorRegistry?.clear?.();
  const gameContents = windowManager.getGameWebContents();
  if (activeAccount && gameContents && !gameContents.isDestroyed()) {
    try {
      await sessionManager.saveAccountSession(gameContents.session, activeAccount);
    } catch (error) {
      Logger.logClient(activeAccount, `Could not persist refreshed session during logout: ${error.message}`);
    }
  }
  gameWindowEventCleanup?.();
  gameWindowEventCleanup = null;
  windowManager.destroyGameWindow(activeAccount);
  activityHistoryStore?.flush?.();

  botEngine = null;
  cubePvpService = null;
  powerCrystalService = null;
  autoFarmService = null;
  monsterCatalogService = null;
  areaDirectoryService = null;
  targetDiscoveryService = null;
  lootDiscoveryService = null;
  statsService = null;
  areaAccessService = null;
  loadoutService = null;
  energyFarmEngine = null;
  chapterFarmer = null;
  mangaManager.setHttpClient(null);
  collectorRegistry = null;
  worldStateService = null;
  readCoordinator = null;
  worldStateAccountKey = null;
  configManager?.setActiveAccount(null);
  activeAccount = null;
}

// One explicitly demanded authenticated source is scanned at a time. Catalog
// visibility alone never authorizes a page read for the signed-in account.
function setupLootDiscoveryChecks() {
  const generation = ++lootScanGeneration;
  const service = lootDiscoveryService;
  const account = activeAccount;
  const demandedAreas = () => deriveDiscoveryDemand(botEngine?.config || configManager?.getConfig?.() || {});
  if (lootScanTimer) clearTimeout(lootScanTimer);
  if (!service || demandedAreas().length === 0) return;

  const schedule = () => {
    if (generation !== lootScanGeneration || service !== lootDiscoveryService || account !== activeAccount) return;
    const areaCount = demandedAreas().length;
    if (areaCount === 0) return;
    const minutes = Math.max(1, Number(botEngine?.config?.scheduler?.lootScanIntervalMinutes) || 1);
    const delay = Math.max(1000, Math.round((minutes * 60000) / areaCount));
    lootScanTimer = setTimeout(run, delay);
    lootScanTimer.unref?.();
  };
  const run = async () => {
    lootScanTimer = null;
    if (generation !== lootScanGeneration || service !== lootDiscoveryService || account !== activeAccount) return;
    // Active automation owns its required reads. The presentation/background
    // scanner must never interleave a large loot page with combat mutations.
    if (botEngine?.isRunning) {
      schedule();
      return;
    }
    const now = Date.now();
    const areas = demandedAreas().filter(area => Number(lootScanFailures.get(area.key)?.retryAt || 0) <= now);
    if (areas.length === 0) {
      schedule();
      return;
    }
    const area = areas[lootScanCursor % areas.length];
    lootScanCursor = (lootScanCursor + 1) % areas.length;
    try {
      const snapshot = await service.scan(area.key, {
        force: true,
        directoryPriority: ReadPriority.BACKGROUND,
      });
      lootScanFailures.delete(area.key);
      if (generation === lootScanGeneration) windowManager?.sendToMain('loot-discovery:update', snapshot);
    } catch (error) {
      const failures = Math.min(3, Number(lootScanFailures.get(area.key)?.failures || 0) + 1);
      const backoffMs = [60000, 300000, 900000][failures - 1];
      lootScanFailures.set(area.key, { failures, retryAt: Date.now() + backoffMs, message: error.message });
      if (generation === lootScanGeneration) {
        Logger.logClient(account, `Lootable scan ${area.label} deferred for ${Math.round(backoffMs / 60000)} minute(s): ${error.message}`);
      }
    } finally {
      schedule();
    }
  };
  schedule();
}

// ─── Hourly Server Reset Check ───────────────────────────────────────

function setupHourlyChecks() {
  const generation = ++pollingGeneration;
  const pollingEngine = botEngine;
  const pollingAccount = activeAccount;
  const isCurrent = () => generation === pollingGeneration
    && pollingEngine === botEngine
    && pollingAccount === activeAccount
    && Boolean(pollingEngine?.gameReader);
  if (hourlyCheckTimer) clearTimeout(hourlyCheckTimer);
  if (hourlyJitterTimer) clearTimeout(hourlyJitterTimer);

  let lastHourlyRefreshHour = -1;
  let nextRoutineStatsRefresh = Date.now();
  let nextFarmedEnergyRefresh = Date.now();

  const check = async () => {
    if (!isCurrent()) return;
    // Check for hourly server reset
    if (isCurrent()) {
      const timezoneOffset = stateStore.getState().serverTzOff ?? 19800;
      const serverDate = new Date(Date.now() + (timezoneOffset * 1000));
      const currentHour = serverDate.getUTCHours();
      const currentMin = serverDate.getUTCMinutes();

      if (currentMin === 0 && lastHourlyRefreshHour !== currentHour) {
        lastHourlyRefreshHour = currentHour;
        const jitterDelay = pollingEngine.timingEngine.getRandomDelay(5000, 15000);
        Logger.logClient(pollingAccount, `Hourly server reset detected (Hour: ${currentHour}:00). Scheduling stats auto-refresh in ${(jitterDelay / 1000).toFixed(1)}s.`);
        hourlyJitterTimer = setTimeout(async () => {
          hourlyJitterTimer = null;
          if (!isCurrent()) return;
          try {
            Logger.logApi(pollingAccount, 'GET', 'https://demonicscans.org/stats.php', null, 'Executing hourly server reset auto-refresh');
            await pollingEngine.refreshStats();
            if (!isCurrent()) return;
            Logger.logApi(pollingAccount, 'GET', 'https://demonicscans.org/stats.php', 200, 'Hourly auto-refresh completed successfully');
          } catch (err) {
            if (isCurrent()) Logger.logApi(pollingAccount, 'GET', 'https://demonicscans.org/stats.php', 500, `Hourly refresh error: ${err.message}`);
          }
        }, jitterDelay);
      }
    }

    // Read game state periodically
    if (isCurrent()) {
      try {
        await pollingEngine.gameReader.readState();
      } catch (err) {
        if (isCurrent()) Logger.logClient(pollingAccount, `State read error: ${err.message}`);
      }
    }
    if (!isCurrent()) return;

    // Manual activity in the companion browser may update server state
    // without navigating. Refresh the authoritative pages independently of
    // whether the automation loop is running.
    if (Date.now() >= nextRoutineStatsRefresh) {
      try {
        await pollingEngine.refreshStats();
      } catch (err) {
        if (isCurrent()) Logger.logClient(pollingAccount, `Routine Stats refresh deferred: ${err.message}`);
      } finally {
        if (isCurrent()) {
          nextRoutineStatsRefresh = Date.now() + pollingEngine.timingEngine.getRandomDelay(12000, 20000);
        }
      }
    }
    if (!isCurrent()) return;

    if (Date.now() >= nextFarmedEnergyRefresh) {
      let energy = null;
      try {
        const mangaList = mangaManager.getAccountMangaList(pollingAccount);
        const targetSlug = mangaList?.[0]?.slug || 'The-Investor-Who-Sees-The-Future';
        energy = await pollingEngine.gameReader.fetchFarmedEnergy(targetSlug, 1);
      } catch (err) {
        if (isCurrent()) Logger.logClient(pollingAccount, `Routine farmed-energy refresh deferred: ${err.message}`);
      } finally {
        if (isCurrent()) {
          const bounds = energy === null ? [12000, 20000] : [45000, 75000];
          nextFarmedEnergyRefresh = Date.now() + pollingEngine.timingEngine.getRandomDelay(...bounds);
        }
      }
    }

    if (isCurrent()) {
      const delay = pollingEngine.timingEngine.getRandomDelay(2000, 3500);
      hourlyCheckTimer = setTimeout(check, delay);
    }
  };
  check();
}

// ─── Engine Event Wiring ─────────────────────────────────────────────

function wireEngineEvents() {
  if (!botEngine) return;

  botEngine.on('state-change', (data) => {
    Logger.logAuto(activeAccount, `State changed to ${data.state} (${data.reason || 'No reason'})`);
    windowManager?.sendToMain('bot:state-change', data);
  });

  botEngine.on('telemetry', (data) => {
    windowManager?.sendToMain('bot:telemetry', data);
  });

  botEngine.on('log', (data) => {
    Logger.logAuto(activeAccount, `[${data.level}] ${data.message}`);
    windowManager?.sendToMain('bot:log', data);
  });

  botEngine.on('captcha-alert', (data) => {
    windowManager?.sendToMain('bot:captcha-alert', data);
    if (data.active) {
      windowManager?.flashMainWindow();
      windowManager?.showGameWindow();
    }
  });

  botEngine.on('discovery-demand-changed', () => {
    setupLootDiscoveryChecks();
  });
}

// ─── Game Window Event Wiring ────────────────────────────────────────

function wireGameWindowEvents() {
  gameWindowEventCleanup?.();
  gameWindowEventCleanup = null;
  const wc = windowManager.getGameWebContents();
  if (!wc) return;
  const wiredEngine = botEngine;
  const wiredAccount = activeAccount;
  const isCurrent = () => botEngine === wiredEngine
    && activeAccount === wiredAccount
    && !wc.isDestroyed();

  const mutationReader = createCoalescedRunner(async () => {
    if (!isCurrent() || !wiredEngine?.gameReader) return;
    try {
      const state = await wiredEngine.gameReader.readState({ syncStamina: true });
      if (isCurrent() && state?.player) windowManager?.sendToMain('bot:stats', state.player);
    } catch (err) {
      if (isCurrent()) Logger.logClient(wiredAccount, `DOM mutation read error: ${err.message}`);
    }
  }, { minIntervalMs: 250 });

  // DOM mutation relay
  const onConsoleMessage = (event, level, message) => {
    if (message === '__VEYRA_DOM_MUTATION__') {
      mutationReader.request();
    }
  };

  // Page reload/navigation → re-inject observers, refresh stats
  const onDidFinishLoad = () => {
    void (async () => {
      try {
        await windowManager.injectGameBrowserControls();
        if (!isCurrent()) return;
        wiredEngine.setWebContents(wc);
        wiredEngine.log('INFO', `Game loaded: ${wc.getURL()}`);
        await wiredEngine.gameReader.injectDOMObserver();
        await wiredEngine.refreshStats();
        if (!isCurrent()) return;
        const mangaList = mangaManager.getAccountMangaList(wiredAccount);
        const targetSlug = (mangaList?.length > 0) ? mangaList[0].slug : 'The-Investor-Who-Sees-The-Future';
        await wiredEngine.gameReader.fetchFarmedEnergy(targetSlug, 1);
        const state = await wiredEngine.gameReader.readState();
        if (isCurrent() && state?.player) {
          windowManager?.sendToMain('bot:stats', state.player);
        }
      } catch (err) {
        if (isCurrent()) Logger.logClient(wiredAccount, `Page load init error: ${err.message}`);
      }
    })();
  };

  wc.on('console-message', onConsoleMessage);
  wc.on('did-finish-load', onDidFinishLoad);
  gameWindowEventCleanup = () => {
    mutationReader.dispose();
    if (wc.isDestroyed()) return;
    wc.removeListener('console-message', onConsoleMessage);
    wc.removeListener('did-finish-load', onDidFinishLoad);
  };
}

// ─── App Bootstrap ───────────────────────────────────────────────────

app.whenReady().then(() => {
  const dataInitialization = initializeAppDataDirectory(app);
  Logger.setLogsDirectory(getDataPath('logs'));
  mangaManager.setDataDirectory(getDataDirectory());
  if (dataInitialization.copied > 0) {
    Logger.logClient('System', `Migrated ${dataInitialization.copied} existing data file(s) into the per-user Veybot data directory`);
  }
  sessionManager = new SessionManager();
  credentialManager = new CredentialManager(safeStorage);
  damageObservationStore = new DamageObservationStore();
  xpModel = new XpModel();
  accountDatabase = new AccountDatabase(undefined, {
    maxActivitiesPerKind: 1000,
    maxEvents: 5000,
    writeDebounceMs: 250,
  });
  accountDatabase.importLegacyActivityHistory(getDataPath('activity_history.json'));
  configManager = new ConfigManager(undefined, { accountDatabase });
  activityHistoryStore = new ActivityHistoryStore(undefined, {
    database: accountDatabase,
    maxEntriesPerKind: 1000,
  });
  windowManager = new WindowManager(sessionManager, credentialManager);

  // Register all IPC handlers with dependency injection
  registerIpcHandlers({
    windowManager,
    sessionManager,
    credentialManager,
    getActiveAccount: () => activeAccount,
    getActiveAccountKey: () => worldStateAccountKey,
    setActiveAccount: (name) => { activeAccount = name; },
    onLogin: handleLogin,
    onLogout: handleLogout,
    getBotEngine: () => botEngine,
    getChapterFarmer: () => chapterFarmer,
    getEnergyFarmEngine: () => energyFarmEngine,
    getConfigManager: () => configManager,
    getAutoFarmService: () => autoFarmService,
    getMonsterCatalogService: () => monsterCatalogService,
    getAreaDirectoryService: () => areaDirectoryService,
    getTargetDiscoveryService: () => targetDiscoveryService,
    getLootDiscoveryService: () => lootDiscoveryService,
    getLoadoutService: () => loadoutService,
    getDamageObservationStore: () => damageObservationStore,
    getXpModel: () => xpModel,
    getActivityHistoryStore: () => activityHistoryStore,
    getAccountDatabase: () => accountDatabase,
    getCubePvpService: () => cubePvpService,
    getPowerCrystalService: () => powerCrystalService,
  });

  // Pipe logger events in real-time to renderer
  Logger.on('log', (entry) => {
    windowManager?.sendToMain('log:entry', entry);
  });

  windowManager.createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  activityHistoryStore?.flush?.();
  accountDatabase?.flush?.();
});
