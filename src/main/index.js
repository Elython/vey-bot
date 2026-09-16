/**
 * Main Process Entry Point (Bootstrap)
 * Thin orchestrator — creates services, wires dependencies, boots the app.
 * All window management lives in windowManager.js, IPC in ipcRouter.js.
 */

const { app, BrowserWindow, safeStorage } = require('electron');
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
const { TimingEngine } = require('../scheduler/timingEngine');
const { SessionManager } = require('./sessionManager');
const { CredentialManager } = require('./credentialManager');
const { WindowManager } = require('./windowManager');
const { registerIpcHandlers } = require('./ipcRouter');
const { Logger } = require('./logger');
const { mangaManager } = require('./mangaManager');
const { stateStore } = require('../engine/stateStore');

let windowManager = null;
let sessionManager = null;
let credentialManager = null;
let botEngine = null;
let energyFarmEngine = null;
let chapterFarmer = null;
let configManager = null;
let monsterCatalogService = null;
let loadoutService = null;
let damageObservationStore = null;
let xpModel = null;
let activeAccount = null;
let hourlyCheckTimer = null;
let loginPromise = null;
let loginAccount = null;
let gameWindowEventCleanup = null;

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
    return { success: false, error: 'Saved session is expired. Please add the account again.' };
  }

  // Create the API-driven dependency graph.
  const config = configManager.getConfig();
  const timingEngine = new TimingEngine(config.scheduler);
  const httpClient = new HttpClient(wc, accountName, timingEngine);
  const gameAPI = new GameAPI(httpClient, accountName);
  monsterCatalogService = new MonsterCatalogService(gameAPI);
  loadoutService = new LoadoutService(gameAPI, accountName);
  const gameController = new GameController(gameAPI, timingEngine);
  const battleManager = new BattleManager(gameAPI, gameController, accountName);
  const moduleRegistry = new ModuleRegistry();
  const attackPlanner = new AttackPlanner(config);
  const strategyEngine = new StrategyEngine(config, accountName, moduleRegistry, attackPlanner);
  const resourcePolicyEngine = new ResourcePolicyEngine(config);
  const progressionEngine = new ProgressionEngine(config, xpModel);
  const gameReader = new GameReader(wc, gameAPI, httpClient, accountName);
  chapterFarmer = new ChapterFarmer(httpClient, timingEngine);
  energyFarmEngine = new EnergyFarmEngine(chapterFarmer);
  botEngine = new BotEngine({
    accountName,
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
    monsterCatalogService,
    damageObservationStore,
    xpModel,
    progressionEngine,
    chapterFarmer,
    getMangaTargets: account => mangaManager.getAccountMangaList(account),
    onChapterFarmed: (account, slug) => mangaManager.incrementFarmedCount(account, slug),
  });
  stateStore.setAccount(accountName);

  // Start hourly stats polling
  setupHourlyChecks();

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
  if (botEngine) botEngine.stop();
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
  windowManager.hideGameWindow();

  botEngine = null;
  monsterCatalogService = null;
  loadoutService = null;
  energyFarmEngine = null;
  chapterFarmer = null;
  activeAccount = null;
}

// ─── Hourly Server Reset Check ───────────────────────────────────────

function setupHourlyChecks() {
  if (hourlyCheckTimer) clearTimeout(hourlyCheckTimer);

  let lastHourlyRefreshHour = -1;
  let nextRoutineStatsRefresh = Date.now();
  let nextFarmedEnergyRefresh = Date.now();

  const check = async () => {
    // Check for hourly server reset
    if (activeAccount && botEngine?.gameReader) {
      const timezoneOffset = stateStore.getState().serverTzOff ?? 19800;
      const serverDate = new Date(Date.now() + (timezoneOffset * 1000));
      const currentHour = serverDate.getUTCHours();
      const currentMin = serverDate.getUTCMinutes();

      if (currentMin === 0 && lastHourlyRefreshHour !== currentHour) {
        lastHourlyRefreshHour = currentHour;
        const jitterDelay = botEngine.timingEngine.getRandomDelay(5000, 15000);
        Logger.logClient(activeAccount, `Hourly server reset detected (Hour: ${currentHour}:00). Scheduling stats auto-refresh in ${(jitterDelay / 1000).toFixed(1)}s.`);
        setTimeout(async () => {
          if (!activeAccount || !botEngine?.gameReader) return;
          try {
            Logger.logApi(activeAccount, 'GET', 'https://demonicscans.org/stats.php', null, 'Executing hourly server reset auto-refresh');
            await botEngine.refreshStats();
            Logger.logApi(activeAccount, 'GET', 'https://demonicscans.org/stats.php', 200, 'Hourly auto-refresh completed successfully');
          } catch (err) {
            Logger.logApi(activeAccount, 'GET', 'https://demonicscans.org/stats.php', 500, `Hourly refresh error: ${err.message}`);
          }
        }, jitterDelay);
      }
    }

    // Read game state periodically
    if (botEngine?.gameReader) {
      try {
        await botEngine.gameReader.readState();
      } catch (err) {
        Logger.logClient(activeAccount, `State read error: ${err.message}`);
      }
    }

    // Manual activity in the companion browser may update server state
    // without navigating. Refresh the authoritative pages independently of
    // whether the automation loop is running.
    if (activeAccount && botEngine?.gameReader && Date.now() >= nextRoutineStatsRefresh) {
      const currentEngine = botEngine;
      try {
        await currentEngine.refreshStats();
      } catch (err) {
        Logger.logClient(activeAccount, `Routine Stats refresh deferred: ${err.message}`);
      } finally {
        if (botEngine === currentEngine) {
          nextRoutineStatsRefresh = Date.now() + currentEngine.timingEngine.getRandomDelay(12000, 20000);
        }
      }
    }

    if (activeAccount && botEngine?.gameReader && Date.now() >= nextFarmedEnergyRefresh) {
      const currentEngine = botEngine;
      let energy = null;
      try {
        const mangaList = mangaManager.getAccountMangaList(activeAccount);
        const targetSlug = mangaList?.[0]?.slug || 'The-Investor-Who-Sees-The-Future';
        energy = await currentEngine.gameReader.fetchFarmedEnergy(targetSlug, 1);
      } catch (err) {
        Logger.logClient(activeAccount, `Routine farmed-energy refresh deferred: ${err.message}`);
      } finally {
        if (botEngine === currentEngine) {
          const bounds = energy === null ? [12000, 20000] : [45000, 75000];
          nextFarmedEnergyRefresh = Date.now() + currentEngine.timingEngine.getRandomDelay(...bounds);
        }
      }
    }

    if (activeAccount && botEngine) {
      const delay = botEngine.timingEngine.getRandomDelay(2000, 3500);
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
}

// ─── Game Window Event Wiring ────────────────────────────────────────

function wireGameWindowEvents() {
  gameWindowEventCleanup?.();
  gameWindowEventCleanup = null;
  const wc = windowManager.getGameWebContents();
  if (!wc) return;

  // DOM mutation relay
  const onConsoleMessage = async (event, level, message) => {
    if (message === '__VEYRA_DOM_MUTATION__') {
      if (botEngine?.gameReader) {
        try {
          const state = await botEngine.gameReader.readState({ syncStamina: true });
          if (state?.player) {
            windowManager?.sendToMain('bot:stats', state.player);
          }
        } catch (err) {
          Logger.logClient(activeAccount, `DOM mutation read error: ${err.message}`);
        }
      }
    }
  };

  // Page reload/navigation → re-inject observers, refresh stats
  const onDidFinishLoad = async () => {
    await windowManager.injectGameBrowserControls();
    if (!botEngine) return;
    botEngine.setWebContents(wc);
    botEngine.log('INFO', `Game loaded: ${wc.getURL()}`);
    try {
      await botEngine.gameReader.injectDOMObserver();
      await botEngine.refreshStats();
      const mangaList = mangaManager.getAccountMangaList(activeAccount);
      const targetSlug = (mangaList?.length > 0) ? mangaList[0].slug : 'The-Investor-Who-Sees-The-Future';
      await botEngine.gameReader.fetchFarmedEnergy(targetSlug, 1);
      const state = await botEngine.gameReader.readState();
      if (state?.player) {
        windowManager?.sendToMain('bot:stats', state.player);
      }
    } catch (err) {
      Logger.logClient(activeAccount, `Page load init error: ${err.message}`);
    }
  };

  wc.on('console-message', onConsoleMessage);
  wc.on('did-finish-load', onDidFinishLoad);
  gameWindowEventCleanup = () => {
    if (wc.isDestroyed()) return;
    wc.removeListener('console-message', onConsoleMessage);
    wc.removeListener('did-finish-load', onDidFinishLoad);
  };
}

// ─── App Bootstrap ───────────────────────────────────────────────────

app.whenReady().then(() => {
  sessionManager = new SessionManager();
  credentialManager = new CredentialManager(safeStorage);
  configManager = new ConfigManager();
  damageObservationStore = new DamageObservationStore();
  xpModel = new XpModel();
  windowManager = new WindowManager(sessionManager, credentialManager);

  // Register all IPC handlers with dependency injection
  registerIpcHandlers({
    windowManager,
    sessionManager,
    credentialManager,
    getActiveAccount: () => activeAccount,
    setActiveAccount: (name) => { activeAccount = name; },
    onLogin: handleLogin,
    onLogout: handleLogout,
    getBotEngine: () => botEngine,
    getChapterFarmer: () => chapterFarmer,
    getEnergyFarmEngine: () => energyFarmEngine,
    getConfigManager: () => configManager,
    getMonsterCatalogService: () => monsterCatalogService,
    getLoadoutService: () => loadoutService,
    getDamageObservationStore: () => damageObservationStore,
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
