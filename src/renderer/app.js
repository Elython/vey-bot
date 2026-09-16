/**
 * Darkbot-Style Minimal Renderer App
 */

let activeAccount = null;
let currentTab = 'home';
let latestStats = null;
let latestProgressionTelemetry = null;
let currentFarmConfig = 'scheduler';
let monsterCatalog = [];
let activeMonsterAreaKey = null;
let activeLootAreaKey = null;
let monsterConfig = { maps: {} };
let lootingConfig = { maps: {} };
const monsterAreaCache = new Map();
const lootAreaCache = new Map();
let activeCombatLoadout = null;
let activeClassSkills = null;
let allowedCombatAbilityIds = new Set();
let configuredNukeAttack = 'auto';
const pendingConfigSaves = new Set();

function trackConfigSave(promise) {
  const tracked = Promise.resolve(promise).finally(() => pendingConfigSaves.delete(tracked));
  pendingConfigSaves.add(tracked);
  return tracked;
}

async function flushPendingConfigSaves() {
  while (pendingConfigSaves.size > 0) {
    await Promise.allSettled([...pendingConfigSaves]);
  }
}

function updateCanonicalConfig(patch) {
  return trackConfigSave(window.botAPI.updateConfig(patch));
}

// DOM Elements - Views & Navigation
const appContainer = document.querySelector('.app-container');
const viewLogin = document.getElementById('viewLogin');
const viewHome = document.getElementById('viewHome');
const viewEnergyFarm = document.getElementById('viewEnergyFarm');
const viewNPCConfig = document.getElementById('viewNPCConfig');
const viewLootConfig = document.getElementById('viewLootConfig');
const viewConsole = document.getElementById('viewConsole');

const tabContainer = document.getElementById('tabContainer');
const unauthTitle = document.getElementById('unauthTitle');
const tabHomeBtn = document.getElementById('tabHomeBtn');
const tabBotSetupBtn = document.getElementById('tabBotSetupBtn');
const tabCombatBtn = document.getElementById('tabCombatBtn');
const tabEnergyFarmBtn = document.getElementById('tabEnergyFarmBtn');
const tabNPCConfigBtn = document.getElementById('tabNPCConfigBtn');
const tabLootConfigBtn = document.getElementById('tabLootConfigBtn');
const tabConsoleBtn = document.getElementById('tabConsoleBtn');

// Home Subtabs
const subtabHomeGeneralBtn = document.getElementById('subtabHomeGeneralBtn');
const subtabHomeBotBtn = document.getElementById('subtabHomeBotBtn');
const subviewHomeGeneral = document.getElementById('subviewHomeGeneral');
const subviewHomeEquipment = document.getElementById('subviewHomeEquipment');
const subviewHomeBot = document.getElementById('subviewHomeBot');
const selectGeneralModule = document.getElementById('selectGeneralModule');
const selectGeneralMap = document.getElementById('selectGeneralMap');
const selectGeneralDungeonMap = document.getElementById('selectGeneralDungeonMap');
const selectGeneralGateMap = document.getElementById('selectGeneralGateMap');
const selectGeneralEventMap = document.getElementById('selectGeneralEventMap');
const rowGeneralMap = document.getElementById('rowGeneralMap');
const rowGeneralDungeonMap = document.getElementById('rowGeneralDungeonMap');
const rowGeneralGateMap = document.getElementById('rowGeneralGateMap');
const rowGeneralEventMap = document.getElementById('rowGeneralEventMap');
const btnLoadConfig = document.getElementById('btnLoadConfig');
const btnSaveConfig = document.getElementById('btnSaveConfig');
const chkEnableProgression = document.getElementById('chkEnableProgression');
const chkProgressionLootLeveling = document.getElementById('chkProgressionLootLeveling');
const chkProgressionLootDungeons = document.getElementById('chkProgressionLootDungeons');
const chkProgressionLootEvents = document.getElementById('chkProgressionLootEvents');
const chkProgressionLootGates = document.getElementById('chkProgressionLootGates');
const chkProgressionChapterFallback = document.getElementById('chkProgressionChapterFallback');
const chkProgressionPotionFallback = document.getElementById('chkProgressionPotionFallback');
const rowProgressionLootLeveling = document.getElementById('rowProgressionLootLeveling');
const rowProgressionDungeonSources = document.getElementById('rowProgressionDungeonSources');
const rowProgressionEventSources = document.getElementById('rowProgressionEventSources');
const rowProgressionGateSources = document.getElementById('rowProgressionGateSources');
const progressionDungeonSourcePicker = document.getElementById('progressionDungeonSourcePicker');
const progressionEventSourcePicker = document.getElementById('progressionEventSourcePicker');
const progressionGateSourcePicker = document.getElementById('progressionGateSourcePicker');
const progressionDungeonSourceList = document.getElementById('progressionDungeonSourceList');
const progressionEventSourceList = document.getElementById('progressionEventSourceList');
const progressionGateSourceList = document.getElementById('progressionGateSourceList');
const progressionDungeonSourceCount = document.getElementById('progressionDungeonSourceCount');
const progressionEventSourceCount = document.getElementById('progressionEventSourceCount');
const progressionGateSourceCount = document.getElementById('progressionGateSourceCount');
const rowProgressionChapterFallback = document.getElementById('rowProgressionChapterFallback');
const rowProgressionPotionFallback = document.getElementById('rowProgressionPotionFallback');
const rowProgressionDrainBeforeLoot = document.getElementById('rowProgressionDrainBeforeLoot');
const progressionCurrentState = document.getElementById('progressionCurrentState');
const progressionLootXp = document.getElementById('progressionLootXp');
const progressionLootScan = document.getElementById('progressionLootScan');
const progressionXpNeeded = document.getElementById('progressionXpNeeded');
const btnRefreshProgressionLoot = document.getElementById('btnRefreshProgressionLoot');
const btnModuleInfo = document.getElementById('btnModuleInfo');
const modalModuleInfo = document.getElementById('modalModuleInfo');
const moduleInfoTitle = document.getElementById('moduleInfoTitle');
const moduleInfoBody = document.getElementById('moduleInfoBody');
const btnCloseModuleInfo = document.getElementById('btnCloseModuleInfo');
const chkSpendStaminaRed = document.getElementById('chkSpendStaminaRed');
const selectOverflowArea = document.getElementById('selectOverflowArea');
const selectOverflowMonster = document.getElementById('selectOverflowMonster');
const selectOverflowMode = document.getElementById('selectOverflowMode');
const inputOverflowAmount = document.getElementById('inputOverflowAmount');
const selectOverflowBackupArea = document.getElementById('selectOverflowBackupArea');
const selectOverflowBackupMonster = document.getElementById('selectOverflowBackupMonster');
const inputKeepStaminaMin = document.getElementById('inputKeepStaminaMin');
const inputKeepStaminaMax = document.getElementById('inputKeepStaminaMax');
const inputStopStaminaBelow = document.getElementById('inputStopStaminaBelow');
const chkAllowStaminaPots = document.getElementById('chkAllowStaminaPots');
const inputSmallStaminaPotLimit = document.getElementById('inputSmallStaminaPotLimit');
const inputLargeStaminaPotLimit = document.getElementById('inputLargeStaminaPotLimit');
const inputFullStaminaPotLimit = document.getElementById('inputFullStaminaPotLimit');
const inputAdventureStaminaPotLimit = document.getElementById('inputAdventureStaminaPotLimit');
const inputSleepHealthBelow = document.getElementById('inputSleepHealthBelow');
const inputMaxDeaths = document.getElementById('inputMaxDeaths');
const chkUseHealingPotions = document.getElementById('chkUseHealingPotions');
const inputMaxHealingPotions = document.getElementById('inputMaxHealingPotions');
const chkBuyHealthPotion = document.getElementById('chkBuyHealthPotion');
const inputMaxHealthPotionPurchases = document.getElementById('inputMaxHealthPotionPurchases');
const healthPotsPurchasedCount = document.getElementById('healthPotsPurchasedCount');
const btnResetHealthPurchases = document.getElementById('btnResetHealthPurchases');
const chkAllowManaAbilities = document.getElementById('chkAllowManaAbilities');
const chkAllowManaPotions = document.getElementById('chkAllowManaPotions');
const inputSmallManaPotLimit = document.getElementById('inputSmallManaPotLimit');
const inputLargeManaPotLimit = document.getElementById('inputLargeManaPotLimit');
const inputStopManaBelow = document.getElementById('inputStopManaBelow');
const chkBuyManaPotion = document.getElementById('chkBuyManaPotion');
const inputMaxManaPotionPurchases = document.getElementById('inputMaxManaPotionPurchases');
const manaPotsPurchasedCount = document.getElementById('manaPotsPurchasedCount');
const btnResetManaPurchases = document.getElementById('btnResetManaPurchases');
const homeStatsBar = document.getElementById('homeStatsBar');
const homeRuntimeStatus = document.getElementById('homeRuntimeStatus');
const overviewCurrentPanel = document.getElementById('overviewCurrentPanel');
const homeSetupTabs = document.getElementById('homeSetupTabs');
const overviewTargetName = document.getElementById('overviewTargetName');
const overviewActionReason = document.getElementById('overviewActionReason');
const overviewProgressFill = document.getElementById('overviewProgressFill');
const overviewProgressText = document.getElementById('overviewProgressText');
const overviewInfoGrid = document.getElementById('overviewInfoGrid');
const overviewConsolePanel = document.getElementById('overviewConsolePanel');
const overviewModuleName = document.getElementById('overviewModuleName');
const overviewConnectionText = document.getElementById('overviewConnectionText');
const overviewProgressionState = document.getElementById('overviewProgressionState');
const overviewProgressionXp = document.getElementById('overviewProgressionXp');
const overviewSessionKills = document.getElementById('overviewSessionKills');
const overviewSessionLoot = document.getElementById('overviewSessionLoot');
const overviewSessionDamage = document.getElementById('overviewSessionDamage');
const overviewSessionStaminaPots = document.getElementById('overviewSessionStaminaPots');
const overviewSessionManaPots = document.getElementById('overviewSessionManaPots');
const overviewSessionHealthPots = document.getElementById('overviewSessionHealthPots');
const overviewSessionErrors = document.getElementById('overviewSessionErrors');
const overviewPotionCounters = document.getElementById('overviewPotionCounters');
const selectGearPve = document.getElementById('selectGearPve');
const selectPetsPve = document.getElementById('selectPetsPve');
const selectAttackMode = document.getElementById('selectAttackMode');
const selectFixedAttack = document.getElementById('selectFixedAttack');
const selectMaxAttack = document.getElementById('selectMaxAttack');
const inputAttackOvershoot = document.getElementById('inputAttackOvershoot');
const chkAllowClassAbilities = document.getElementById('chkAllowClassAbilities');
const rowFixedAttack = document.getElementById('rowFixedAttack');
const rowAdaptiveMax = document.getElementById('rowAdaptiveMax');
const rowAdaptiveOvershoot = document.getElementById('rowAdaptiveOvershoot');
const rowAdaptiveFailSafe = document.getElementById('rowAdaptiveFailSafe');
const rowAdaptiveFailSafePercent = document.getElementById('rowAdaptiveFailSafePercent');
const chkAdaptiveFailSafe = document.getElementById('chkAdaptiveFailSafe');
const inputAdaptiveFailSafePercent = document.getElementById('inputAdaptiveFailSafePercent');
const rowAdaptiveRequireTargetStamina = document.getElementById('rowAdaptiveRequireTargetStamina');
const chkAdaptiveRequireTargetStamina = document.getElementById('chkAdaptiveRequireTargetStamina');
const rowAdaptiveNuke = document.getElementById('rowAdaptiveNuke');
const rowAdaptiveNukeAttack = document.getElementById('rowAdaptiveNukeAttack');
const rowAdaptiveNukeAbilities = document.getElementById('rowAdaptiveNukeAbilities');
const chkAdaptiveNuke = document.getElementById('chkAdaptiveNuke');
const selectAdaptiveNukeAttack = document.getElementById('selectAdaptiveNukeAttack');
const chkAdaptiveNukeAbilities = document.getElementById('chkAdaptiveNukeAbilities');
const btnAttackModuleInfo = document.getElementById('btnAttackModuleInfo');
const btnRefreshAttackStrategy = document.getElementById('btnRefreshAttackStrategy');
const btnGearSetInfo = document.getElementById('btnGearSetInfo');
const btnPetSetInfo = document.getElementById('btnPetSetInfo');
const combatPlayerAttack = document.getElementById('combatPlayerAttack');
const combatPlayerDefense = document.getElementById('combatPlayerDefense');
const combatGearAttack = document.getElementById('combatGearAttack');
const combatGearDefense = document.getElementById('combatGearDefense');
const combatPetAttack = document.getElementById('combatPetAttack');
const combatPetDefense = document.getElementById('combatPetDefense');
const combatUnlockedAbilities = document.getElementById('combatUnlockedAbilities');
const modalLoadoutInfo = document.getElementById('modalLoadoutInfo');
const loadoutInfoTitle = document.getElementById('loadoutInfoTitle');
const loadoutInfoSummary = document.getElementById('loadoutInfoSummary');
const loadoutInfoContent = document.getElementById('loadoutInfoContent');
const btnCloseLoadoutInfo = document.getElementById('btnCloseLoadoutInfo');

// Monsters Workspace
const targetAreaSelect = document.getElementById('targetAreaSelect');
const targetAreaTypeSelect = document.getElementById('targetAreaTypeSelect');
const monsterAreaContent = document.getElementById('monsterAreaContent');
const btnRefreshMonsterArea = document.getElementById('btnRefreshMonsterArea');
const btnCollectMonsterStats = document.getElementById('btnCollectMonsterStats');
const lootAreaSelect = document.getElementById('lootAreaSelect');
const lootAreaTypeSelect = document.getElementById('lootAreaTypeSelect');
const lootAreaContent = document.getElementById('lootAreaContent');
const btnRefreshLootArea = document.getElementById('btnRefreshLootArea');
const monsterStatsView = window.MonsterStatsView ? new window.MonsterStatsView(window.botAPI) : null;

// Developer Mode Checkbox
const chkDevMode = document.getElementById('chkDevMode');

// Console Subtabs
const subtabConsoleLiveBtn = document.getElementById('subtabConsoleLiveBtn');
const subtabConsoleUserBtn = document.getElementById('subtabConsoleUserBtn');
const subtabConsoleServerBtn = document.getElementById('subtabConsoleServerBtn');
const subviewConsoleLive = document.getElementById('subviewConsoleLive');
const subviewConsoleUser = document.getElementById('subviewConsoleUser');
const subviewConsoleServer = document.getElementById('subviewConsoleServer');
const logConsole = document.getElementById('logConsole');
const userLogsText = document.getElementById('userLogsText');
const serverLogsText = document.getElementById('serverLogsText');
const btnClearLiveLogs = document.getElementById('btnClearLiveLogs');
const btnRefreshUserLogs = document.getElementById('btnRefreshUserLogs');
const btnRefreshServerLogs = document.getElementById('btnRefreshServerLogs');

// Stats Elements (Home Tab)
const btnRefreshStats = document.getElementById('btnRefreshStats');
const statStamina = document.getElementById('statStamina');
const statStaminaNext = document.getElementById('statStaminaNext');
const statHealth = document.getElementById('statHealth');
const statMana = document.getElementById('statMana');
const statGold = document.getElementById('statGold');
const statGems = document.getElementById('statGems');
const statLevel = document.getElementById('statLevel');
const statEnergy = document.getElementById('statEnergy');
const botStateText = document.getElementById('botStateText');
const botActionText = document.getElementById('botActionText');
const botTargetText = document.getElementById('botTargetText');
const botModeText = document.getElementById('botModeText');

// Energy Farm Elements
const subtabStaminaGeneralBtn = document.getElementById('subtabStaminaGeneralBtn');
const subtabChaptersBtn = document.getElementById('subtabChaptersBtn');
const subviewStaminaGeneral = document.getElementById('subviewStaminaGeneral');
const subviewChaptersFarm = document.getElementById('subviewChaptersFarm');

// Chapters Farm - Tree Form Controls
const selectFarmModule = document.getElementById('selectFarmModule');
const rowManualFarmControls = document.getElementById('rowManualFarmControls');
const selectManualManga = document.getElementById('selectManualManga');
const inputManualChapterCount = document.getElementById('inputManualChapterCount');
const btnStartManualFarm = document.getElementById('btnStartManualFarm');
const workingMangaText = document.getElementById('workingMangaText');
const btnConfigScheduler = document.getElementById('btnConfigScheduler');
const btnConfigIndependent = document.getElementById('btnConfigIndependent');
const rowIndependentDelay = document.getElementById('rowIndependentDelay');
const selectFarmDelay = document.getElementById('selectFarmDelay');

// Safety Section Controls
const chkStopMaxStamina = document.getElementById('chkStopMaxStamina');
const inputMaxStaminaFarm = document.getElementById('inputMaxStaminaFarm');
const inputStopHourlyStaminaMin = document.getElementById('inputStopHourlyStaminaMin');
const selectReactionType = document.getElementById('selectReactionType');

// Mangas Section Controls
const inputMangaTarget = document.getElementById('inputMangaTarget');
const btnAddManga = document.getElementById('btnAddManga');
const mangaListTable = document.getElementById('mangaListTable');

// Running Terminal Section Controls
const farmTerminalOutput = document.getElementById('farmTerminalOutput');
const btnClearFarmTerminal = document.getElementById('btnClearFarmTerminal');

// Gear & Window Controls
const gearBtn = document.getElementById('gearBtn');
const gearDropdown = document.getElementById('gearDropdown');
const btnHeaderStartStop = document.getElementById('btnHeaderStartStop');
const menuViewBrowserBtn = document.getElementById('menuViewBrowserBtn');
const menuPauseResumeBtn = document.getElementById('menuPauseResumeBtn');
const menuAddAccountBtn = document.getElementById('menuAddAccountBtn');
const menuSavedAccountsBtn = document.getElementById('menuSavedAccountsBtn');
const menuLogoutBtn = document.getElementById('menuLogoutBtn');
const btnHeaderQuit = document.getElementById('btnHeaderQuit');

const savedAccountsList = document.getElementById('savedAccountsList');
const btnAddNewAccount = document.getElementById('btnAddNewAccount');

const inputActionMinDelaySeconds = document.getElementById('inputActionMinDelaySeconds');
const inputActionMaxDelaySeconds = document.getElementById('inputActionMaxDelaySeconds');
const chkDryRun = document.getElementById('chkDryRun');
const btnSaveScheduler = document.getElementById('btnSaveScheduler');

const modalSavedAccounts = document.getElementById('modalSavedAccounts');
const modalAccountsList = document.getElementById('modalAccountsList');
const btnCloseModal = document.getElementById('btnCloseModal');

// Footer Elements
const footerUsername = document.getElementById('footerUsername');
const footerServerTime = document.getElementById('footerServerTime');
const footerLocalTime = document.getElementById('footerLocalTime');

// Initialize Lucide icons
lucide.createIcons();

let serverTzOffsetSeconds = 19800;

// Helper: Calculate current server date using the offset reported by the game.
function getServerDate() {
  const now = new Date();
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utcTime + (serverTzOffsetSeconds * 1000));
}

// Live Footer Clock (Ticking every second from app startup)
function updateClocks() {
  const now = new Date();
  const serverDate = getServerDate();

  if (footerServerTime) {
    footerServerTime.textContent = serverDate.toLocaleTimeString();
  }
  if (footerLocalTime) {
    footerLocalTime.textContent = now.toLocaleTimeString();
  }
}
updateClocks();
setInterval(updateClocks, 1000);

// Developer Mode Toggle
function initDevMode() {
  const isDev = localStorage.getItem('devMode') === 'true';
  if (chkDevMode) chkDevMode.checked = isDev;
  if (tabConsoleBtn) tabConsoleBtn.style.display = isDev ? 'block' : 'none';

  if (chkDevMode) {
    chkDevMode.addEventListener('change', () => {
      const checked = chkDevMode.checked;
      localStorage.setItem('devMode', checked ? 'true' : 'false');
      if (tabConsoleBtn) tabConsoleBtn.style.display = checked ? 'block' : 'none';
      if (!checked && currentTab === 'console') {
        switchTab('home');
      }
    });
  }
}

// Collapsible Tree Section Toggle (Safety, Mangas, Running)
window.toggleTreeSection = function (sectionId) {
  const sec = document.getElementById(sectionId);
  if (sec) {
    sec.classList.toggle('collapsed');
  }
};

document.querySelectorAll('[data-tree-section]').forEach(header => {
  header.addEventListener('click', () => window.toggleTreeSection(header.dataset.treeSection));
});

// Segmented Button Config Toggle ([Scheduler] | [Independent])
function setFarmConfig(config, persist = true) {
  currentFarmConfig = config;
  if (btnConfigScheduler) btnConfigScheduler.classList.toggle('active', config === 'scheduler');
  if (btnConfigIndependent) btnConfigIndependent.classList.toggle('active', config === 'independent');
  if (rowIndependentDelay) {
    rowIndependentDelay.style.display = config === 'independent' ? 'flex' : 'none';
  }
  if (persist) saveCurrentFarmSettings();
}

if (btnConfigScheduler) btnConfigScheduler.addEventListener('click', () => setFarmConfig('scheduler'));
if (btnConfigIndependent) btnConfigIndependent.addEventListener('click', () => setFarmConfig('independent'));

// Farm Terminal Output Appender
function appendFarmTerminal(type, message) {
  if (!farmTerminalOutput) return;
  const line = document.createElement('div');
  line.className = `terminal-line text-${type || 'info'}`;
  const serverDate = getServerDate();
  const time = serverDate.toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  farmTerminalOutput.appendChild(line);
  farmTerminalOutput.scrollTop = farmTerminalOutput.scrollHeight;
}

if (btnClearFarmTerminal) {
  btnClearFarmTerminal.addEventListener('click', () => {
    if (farmTerminalOutput) {
      farmTerminalOutput.innerHTML = '<div class="terminal-line text-muted">[Cleared] Farm terminal log reset.</div>';
    }
  });
}

// Farm Settings Manager (Per-Account & Persistent)
async function loadFarmSettings() {
  if (!activeAccount) return;
  try {
    const settings = await window.botAPI.getFarmSettings(activeAccount);
    if (settings) {
      if (selectFarmModule && settings.module) selectFarmModule.value = settings.module;
      updateFarmModuleUI();
      if (settings.configMode) {
        setFarmConfig(settings.configMode, false);
      }
      if (selectFarmDelay && settings.delay) selectFarmDelay.value = settings.delay;
      if (chkStopMaxStamina) chkStopMaxStamina.checked = settings.stopMaxStamina !== undefined ? Boolean(settings.stopMaxStamina) : true;
      if (inputMaxStaminaFarm) inputMaxStaminaFarm.value = settings.maxStaminaFarm !== undefined ? settings.maxStaminaFarm : 1000;
      if (inputStopHourlyStaminaMin) inputStopHourlyStaminaMin.value = settings.stopHourlyMin !== undefined ? settings.stopHourlyMin : 10;
      if (selectReactionType && settings.reactionType) selectReactionType.value = settings.reactionType;
      if (inputManualChapterCount && settings.manualChapterCount) inputManualChapterCount.value = settings.manualChapterCount;
      if (selectManualManga && settings.lastWorkingManga && [...selectManualManga.options].some(option => option.value === settings.lastWorkingManga)) {
        selectManualManga.value = settings.lastWorkingManga;
      }
      if (workingMangaText) workingMangaText.textContent = settings.lastWorkingManga || '-';
    }
    await syncFarmModuleToEngine();
  } catch (err) {
    console.error('Error loading farm settings:', err);
  }
}

async function syncFarmModuleToEngine() {
  const automatic = selectFarmModule?.value === 'automatic';
  const reactionType = selectReactionType?.value || 'random';
  return updateCanonicalConfig({
    energyFarming: { enabled: automatic, reactionType },
  });
}

async function saveCurrentFarmSettings() {
  if (!activeAccount) return;
  const settings = {
    module: selectFarmModule ? selectFarmModule.value : 'manual',
    configMode: currentFarmConfig,
    delay: selectFarmDelay ? selectFarmDelay.value : '1.0s',
    stopMaxStamina: chkStopMaxStamina ? Boolean(chkStopMaxStamina.checked) : true,
    maxStaminaFarm: parseInt(inputMaxStaminaFarm?.value, 10) || 1000,
    stopHourlyMin: parseInt(inputStopHourlyStaminaMin?.value, 10) || 10,
    reactionType: selectReactionType ? selectReactionType.value : '1',
    manualChapterCount: Math.max(1, parseInt(inputManualChapterCount?.value, 10) || 1),
    lastWorkingManga: workingMangaText ? workingMangaText.textContent : '-',
  };
  try {
    await Promise.all([
      window.botAPI.saveFarmSettings(settings, activeAccount),
      syncFarmModuleToEngine(),
    ]);
  } catch (err) {
    console.error('Error saving farm settings:', err);
  }
}

function updateFarmModuleUI() {
  if (rowManualFarmControls) rowManualFarmControls.style.display = selectFarmModule?.value === 'manual' ? 'flex' : 'none';
}

if (selectFarmModule) selectFarmModule.addEventListener('change', () => {
  updateFarmModuleUI();
  saveCurrentFarmSettings();
});
if (inputManualChapterCount) inputManualChapterCount.addEventListener('change', saveCurrentFarmSettings);
if (selectManualManga) selectManualManga.addEventListener('change', () => {
  if (workingMangaText && selectManualManga.value) workingMangaText.textContent = selectManualManga.value;
  saveCurrentFarmSettings();
});
if (selectFarmDelay) selectFarmDelay.addEventListener('change', saveCurrentFarmSettings);
if (chkStopMaxStamina) chkStopMaxStamina.addEventListener('change', saveCurrentFarmSettings);
if (inputMaxStaminaFarm) inputMaxStaminaFarm.addEventListener('change', saveCurrentFarmSettings);
if (inputStopHourlyStaminaMin) inputStopHourlyStaminaMin.addEventListener('change', saveCurrentFarmSettings);
if (selectReactionType) selectReactionType.addEventListener('change', saveCurrentFarmSettings);

const GATE_MAPS = [
  ['grakthar_1', 'Grakthar 1'], ['grakthar_2', 'Grakthar 2'], ['grakthar_3', 'Grakthar 3'],
  ['olympus_1', 'Olympus 1'], ['olympus_hermes', 'Olympus Hermes'],
  ['olympus_artemis', 'Olympus Artemis'], ['olympus_poseidon', 'Olympus Poseidon'],
  ['olympus_ares', 'Olympus Ares'], ['olympus_apollo', 'Olympus Apollo'],
  ['olympus_athena', 'Olympus Athena'], ['olympus_hera', 'Olympus Hera'],
  ['olympus_zeus', 'Olympus Zeus'],
];
const DUNGEON_MAPS = [
  ['castle_fallen_prince', 'Castle of the Fallen Prince'],
  ['shadowbridge_warrens', 'Shadowbridge Warrens'],
  ['polyhedral_crucible', 'The Polyhedral Crucible'],
];
const EVENT_MAPS = [
  ['event_black_crown_ascends', 'The Black Crown Ascends'],
];

function populateProgressionSourceList(container, areas) {
  if (!container) return;
  container.replaceChildren();
  for (const [areaKey, label] of areas) {
    const option = document.createElement('label');
    option.className = 'progression-source-option';
    const text = document.createElement('span');
    text.textContent = label;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tree-checkbox progression-source-checkbox';
    checkbox.dataset.areaKey = areaKey;
    checkbox.addEventListener('change', saveProgressionSettings);
    option.append(text, checkbox);
    container.append(option);
  }
}

function populateProgressionSourceLists() {
  populateProgressionSourceList(progressionDungeonSourceList, DUNGEON_MAPS);
  populateProgressionSourceList(progressionEventSourceList, EVENT_MAPS);
  populateProgressionSourceList(progressionGateSourceList, GATE_MAPS);
}

function selectedProgressionAreas(container) {
  return [...(container?.querySelectorAll('.progression-source-checkbox:checked') || [])]
    .map(checkbox => checkbox.dataset.areaKey)
    .filter(Boolean);
}

function loadProgressionAreaSelection(container, selectedAreas) {
  const selected = new Set(Array.isArray(selectedAreas) ? selectedAreas : []);
  for (const checkbox of container?.querySelectorAll('.progression-source-checkbox') || []) {
    checkbox.checked = selected.has(checkbox.dataset.areaKey);
  }
}

function updateProgressionSourceCount(container, output) {
  if (!output) return;
  const selected = selectedProgressionAreas(container).length;
  output.textContent = `${selected} selected`;
}
const MODULE_DESCRIPTIONS = {
  idle: {
    title: 'Idle module',
    body: 'Does not start automated combat or chapter actions. Account authentication, resource statistics, and background synchronization remain available.',
  },
  gates: {
    title: 'Gates module',
    body: 'Scans the selected Gate and considers only enabled Targets. Lower priority numbers run first, Minimum HP filters instances, configured quick sets are applied before combat, and target-authorized Stamina potions obey the global permission and per-type limits.',
  },
  dungeons: {
    title: 'Dungeons module',
    body: 'Finds the selected open guild dungeon through the Guild Dungeons index, reads its real location links, and considers only enabled live Targets. It never invents room numbers. Shadowbridge and Castle use this verified flow; the Polyhedral Crucible remains unavailable until its Cube route is captured.',
  },
  gates_dungeons: {
    title: 'Dungeons → Gates module',
    body: 'Checks the selected Dungeon first and uses the selected Gate as a fallback when no eligible Dungeon Target is available. Progression can bank configured loot, drain Stamina, claim only a verified level-up batch, spend the refill on unfinished Dungeon Targets, and return to the Gate when Dungeon work is unavailable.',
  },
  event: {
    title: 'Event module',
    body: 'Runs The Black Crown Ascends from its fixed Event wave. It uses the same Target, Combat, Health, pacing, and normal battle rules as Gates.',
  },
};
const ATTACK_MODULE_DESCRIPTIONS = {
  fixed: {
    title: 'Fixed attack module',
    body: 'Uses the selected multiplier as the normal-hit fallback. An explicitly allowed class ability may replace it when its learned x1-based estimate fits the remaining target and its Mana/Stamina policy passes. Normal multiplier limits do not authorize class abilities.',
  },
  adaptive: {
    title: 'Adaptive attack module',
    body: 'Learns x1 damage for the current player stats, monster, Gear, and Pets, then compares permitted attacks under the target and resource rules. Nuke enemy works in Gates, Events, or Dungeons: it can use a selected finishing hit, or Auto can choose the smallest permitted hit that reaches the remaining contribution when shared monster HP is too low. If none can reach it, that transient monster is skipped. Exact server-reported total damage still decides completion.',
  },
};

function populateOverflowAreaOptions(select, preferred = null, placeholder = 'Choose area') {
  if (!select) return;
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = placeholder;
  const options = [...GATE_MAPS, ...EVENT_MAPS, ...DUNGEON_MAPS].map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  });
  select.replaceChildren(empty, ...options);
  if (preferred && [...GATE_MAPS, ...EVENT_MAPS, ...DUNGEON_MAPS].some(([value]) => value === preferred)) select.value = preferred;
}

function populateOverflowMonsterOptions(areaKey, select, preferred = '') {
  if (!select) return;
  const choices = new Map();
  for (const [key, entry] of Object.entries(monsterConfig.maps?.[areaKey] || {})) {
    choices.set(key, entry.name || key);
  }
  for (const monster of monsterAreaCache.get(areaKey)?.monsters || []) {
    choices.set(monster.key, monster.name);
  }
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = choices.size ? 'Choose mob' : 'No mobs loaded';
  const options = [...choices.entries()]
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    });
  select.replaceChildren(empty, ...options);
  if (preferred && choices.has(preferred)) select.value = preferred;
}

async function refreshOverflowMonsterOptions(areaSelect, monsterSelect, preferred = '', discover = false) {
  const areaKey = areaSelect?.value || '';
  populateOverflowMonsterOptions(areaKey, monsterSelect, preferred);
  if (!discover || !areaKey) return;
  const result = await window.botAPI.listMonstersForArea(areaKey);
  if (result?.success && areaSelect?.value === areaKey) {
    monsterAreaCache.set(areaKey, result);
    populateOverflowMonsterOptions(areaKey, monsterSelect, preferred);
  }
}

function enhanceNumberInput(input) {
  if (!input || input.dataset.customStepper === 'true') return;
  input.dataset.customStepper = 'true';
  const wrapper = document.createElement('span');
  wrapper.className = 'number-stepper';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  for (const [direction, label] of [[1, '+'], [-1, '−']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `number-stepper-btn ${direction > 0 ? 'number-stepper-up' : 'number-stepper-down'}`;
    button.textContent = label;
    button.tabIndex = -1;
    button.setAttribute('aria-label', `${direction > 0 ? 'Increase' : 'Decrease'} ${input.getAttribute('aria-label') || 'value'}`);
    button.addEventListener('click', () => {
      if (direction > 0) input.stepUp(); else input.stepDown();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    wrapper.appendChild(button);
  }
}

function enhanceNumberInputs(root = document) {
  root.querySelectorAll('input[type="number"]').forEach(enhanceNumberInput);
}

function showInfoDialog(description) {
  if (!modalModuleInfo) return;
  if (moduleInfoTitle) moduleInfoTitle.textContent = description.title;
  if (moduleInfoBody) moduleInfoBody.textContent = description.body;
  modalModuleInfo.style.display = 'flex';
}

if (btnModuleInfo) btnModuleInfo.addEventListener('click', () => {
  showInfoDialog(MODULE_DESCRIPTIONS[selectGeneralModule?.value] || MODULE_DESCRIPTIONS.idle);
});
if (btnAttackModuleInfo) btnAttackModuleInfo.addEventListener('click', () => {
  showInfoDialog(ATTACK_MODULE_DESCRIPTIONS[selectAttackMode?.value] || ATTACK_MODULE_DESCRIPTIONS.fixed);
});
if (btnCloseModuleInfo) btnCloseModuleInfo.addEventListener('click', () => { modalModuleInfo.style.display = 'none'; });
if (modalModuleInfo) {
  modalModuleInfo.addEventListener('click', event => {
    if (event.target === modalModuleInfo) modalModuleInfo.style.display = 'none';
  });
}

function replaceMapOptions(select, maps, preferred = null) {
  if (!select) return;
  select.replaceChildren(...maps.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value || '';
    option.textContent = label;
    return option;
  }));
  if (preferred && [...select.options].some(option => option.value === preferred)) {
    select.value = preferred;
  }
}

function updateGeneralMaps(preferredMap = null, preferredDungeonMap = null, preferredGateMap = null, preferredEventMap = null) {
  const module = selectGeneralModule?.value || 'idle';
  const combined = module === 'gates_dungeons';
  const dungeonOnly = module === 'dungeons';
  const gateOnly = module === 'gates';
  const eventOnly = module === 'event';
  const setModuleAvailability = (row, select, enabled) => {
    if (row) {
      row.style.display = 'flex';
      row.classList.toggle('module-setting-disabled', !enabled);
      row.setAttribute('aria-disabled', String(!enabled));
    }
    if (select) select.disabled = !enabled;
  };
  setModuleAvailability(rowGeneralMap, selectGeneralMap, gateOnly);
  setModuleAvailability(rowGeneralDungeonMap, selectGeneralDungeonMap, dungeonOnly || combined);
  setModuleAvailability(rowGeneralGateMap, selectGeneralGateMap, combined);
  setModuleAvailability(rowGeneralEventMap, selectGeneralEventMap, eventOnly);
  replaceMapOptions(selectGeneralMap, GATE_MAPS, preferredMap);
  replaceMapOptions(selectGeneralDungeonMap, DUNGEON_MAPS, preferredDungeonMap);
  replaceMapOptions(selectGeneralGateMap, GATE_MAPS, preferredGateMap);
  replaceMapOptions(selectGeneralEventMap, EVENT_MAPS, preferredEventMap);
}

async function saveGeneralSelection() {
  const module = selectGeneralModule?.value || 'idle';
  const result = await updateCanonicalConfig({
    general: {
      module,
      map: module === 'gates'
        ? selectGeneralMap?.value || null
        : module === 'dungeons'
          ? selectGeneralDungeonMap?.value || null
          : module === 'event'
            ? selectGeneralEventMap?.value || null
            : null,
      primaryGateMap: selectGeneralMap?.value || null,
      dungeonMap: selectGeneralDungeonMap?.value || null,
      gateMap: selectGeneralGateMap?.value || null,
      eventMap: selectGeneralEventMap?.value || null,
    },
  });
  if (!result?.success) appendLog('ERROR', result?.error || 'Could not save Module and Map');
}

if (selectGeneralModule) selectGeneralModule.addEventListener('change', () => {
  updateGeneralMaps(null, selectGeneralDungeonMap?.value || null, selectGeneralGateMap?.value || null, selectGeneralEventMap?.value || null);
  saveGeneralSelection();
});
if (selectGeneralMap) selectGeneralMap.addEventListener('change', saveGeneralSelection);
if (selectGeneralDungeonMap) selectGeneralDungeonMap.addEventListener('change', saveGeneralSelection);
if (selectGeneralGateMap) selectGeneralGateMap.addEventListener('change', saveGeneralSelection);
if (selectGeneralEventMap) selectGeneralEventMap.addEventListener('change', saveGeneralSelection);
updateGeneralMaps();

const EQUIPMENT_SELECTS = {
  gear: { pve: selectGearPve },
  pets: { pve: selectPetsPve },
};

function populateEquipmentSetOptions() {
  Object.values(EQUIPMENT_SELECTS).flatMap(group => Object.values(group)).forEach(select => {
    if (!select) return;
    for (let setNumber = 1; setNumber <= 10; setNumber += 1) {
      const option = document.createElement('option');
      option.value = `quick_set_${setNumber}`;
      option.textContent = `Quick Set ${setNumber}`;
      select.appendChild(option);
    }
  });
}

function renderProgressionStatus(stats = latestStats) {
  const enabled = chkEnableProgression?.checked === true;
  const lootLevelingEnabled = enabled && chkProgressionLootLeveling?.checked === true;
  const hasLootSource = (
    chkProgressionLootDungeons?.checked === true && selectedProgressionAreas(progressionDungeonSourceList).length > 0
  ) || (
    chkProgressionLootEvents?.checked === true && selectedProgressionAreas(progressionEventSourceList).length > 0
  ) || (
    chkProgressionLootGates?.checked === true && selectedProgressionAreas(progressionGateSourceList).length > 0
  );
  const scanned = Number(latestProgressionTelemetry?.lootScannedAt) > 0;
  if (progressionCurrentState) {
    const status = latestProgressionTelemetry?.status || 'Monitoring';
    const boostPercent = Number(latestProgressionTelemetry?.lootXpBoostPercent) || 0;
    progressionCurrentState.textContent = enabled
      ? `${status}${latestProgressionTelemetry?.lootXpBoostActive === true ? ` · XP +${boostPercent}%` : ''}`
      : 'Disabled';
  }
  if (progressionLootXp) {
    const eligible = Number(latestProgressionTelemetry?.eligibleLootXp);
    progressionLootXp.textContent = lootLevelingEnabled && scanned && Number.isFinite(eligible)
      ? eligible.toLocaleString()
      : '-';
  }
  if (progressionLootScan) {
    const eligibleCount = Number(latestProgressionTelemetry?.eligibleLootCount) || 0;
    const unknownCount = Number(latestProgressionTelemetry?.unknownLootCount) || 0;
    const errorCount = Number(latestProgressionTelemetry?.lootScanErrorCount) || 0;
    progressionLootScan.textContent = !lootLevelingEnabled
      ? '-'
      : !scanned
        ? 'Not scanned'
        : `${eligibleCount} eligible${unknownCount ? ` · ${unknownCount} unverified` : ''}${errorCount ? ` · ${errorCount} failed` : ''}`;
  }
  if (btnRefreshProgressionLoot) btnRefreshProgressionLoot.disabled = !lootLevelingEnabled || !hasLootSource;
  if (!progressionXpNeeded) return;
  let current = Number(stats?.expCurrent);
  let required = Number(stats?.expRequired);
  if ((!Number.isFinite(current) || !Number.isFinite(required)) && typeof stats?.exp === 'string') {
    const match = stats.exp.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    if (match) {
      current = Number(match[1].replace(/,/g, ''));
      required = Number(match[2].replace(/,/g, ''));
    }
  }
  progressionXpNeeded.textContent = Number.isFinite(current) && Number.isFinite(required)
    ? Math.max(0, required - current).toLocaleString()
    : '-';
}

if (btnRefreshProgressionLoot) btnRefreshProgressionLoot.addEventListener('click', async () => {
  btnRefreshProgressionLoot.disabled = true;
  if (progressionLootScan) progressionLootScan.textContent = 'Scanning…';
  try {
    const result = await window.botAPI.refreshProgressionLoot();
    if (!result?.success) throw new Error(result?.error || 'Eligible loot could not be scanned');
    latestProgressionTelemetry = result.progression || null;
    renderProgressionStatus();
    const unknown = Number(result.progression?.unknownLootCount) || 0;
    const errors = Number(result.progression?.lootScanErrorCount) || 0;
    if (unknown || errors) {
      appendLog('WARN', `Loot scan completed with ${unknown} unverified reward${unknown === 1 ? '' : 's'} and ${errors} area error${errors === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    if (progressionLootScan) progressionLootScan.textContent = 'Scan failed';
    appendLog('ERROR', error.message);
  } finally {
    renderProgressionStatus();
  }
});

function updateProgressionControls() {
  const enabled = chkEnableProgression?.checked === true;
  for (const [row, control] of [
    [rowProgressionLootLeveling, chkProgressionLootLeveling],
    [rowProgressionChapterFallback, chkProgressionChapterFallback],
    [rowProgressionPotionFallback, chkProgressionPotionFallback],
  ]) {
    if (row) {
      row.classList.toggle('module-setting-disabled', !enabled);
      row.setAttribute('aria-disabled', String(!enabled));
    }
    if (control) control.disabled = !enabled;
  }
  const lootLevelingEnabled = enabled && chkProgressionLootLeveling?.checked === true;
  for (const [row, control] of [
    [rowProgressionDungeonSources, chkProgressionLootDungeons],
    [rowProgressionEventSources, chkProgressionLootEvents],
    [rowProgressionGateSources, chkProgressionLootGates],
  ]) {
    if (row) {
      row.classList.toggle('module-setting-disabled', !lootLevelingEnabled);
      row.setAttribute('aria-disabled', String(!lootLevelingEnabled));
    }
    if (control) control.disabled = !lootLevelingEnabled;
  }
  for (const [picker, container, sourceEnabled] of [
    [progressionDungeonSourcePicker, progressionDungeonSourceList, chkProgressionLootDungeons?.checked === true],
    [progressionEventSourcePicker, progressionEventSourceList, chkProgressionLootEvents?.checked === true],
    [progressionGateSourcePicker, progressionGateSourceList, chkProgressionLootGates?.checked === true],
  ]) {
    const interactive = lootLevelingEnabled && sourceEnabled;
    if (picker) {
      picker.classList.toggle('module-setting-disabled', !interactive);
      picker.setAttribute('aria-disabled', String(!interactive));
    }
    for (const checkbox of container?.querySelectorAll('.progression-source-checkbox') || []) {
      checkbox.disabled = !interactive;
    }
  }
  updateProgressionSourceCount(progressionDungeonSourceList, progressionDungeonSourceCount);
  updateProgressionSourceCount(progressionEventSourceList, progressionEventSourceCount);
  updateProgressionSourceCount(progressionGateSourceList, progressionGateSourceCount);
  if (rowProgressionDrainBeforeLoot) {
    rowProgressionDrainBeforeLoot.classList.toggle('module-setting-disabled', !lootLevelingEnabled);
    rowProgressionDrainBeforeLoot.setAttribute('aria-disabled', String(!lootLevelingEnabled));
  }
  renderProgressionStatus();
}

async function saveProgressionSettings() {
  updateProgressionControls();
  const result = await updateCanonicalConfig({
    progression: {
      enabled: chkEnableProgression?.checked === true,
      useLootForLeveling: chkProgressionLootLeveling?.checked === true,
      allowChapterFallback: chkProgressionChapterFallback?.checked === true,
      allowTargetPotionFallback: chkProgressionPotionFallback?.checked === true,
      lootSources: {
        dungeons: {
          enabled: chkProgressionLootDungeons?.checked === true,
          areas: selectedProgressionAreas(progressionDungeonSourceList),
        },
        events: {
          enabled: chkProgressionLootEvents?.checked === true,
          areas: selectedProgressionAreas(progressionEventSourceList),
        },
        gates: {
          enabled: chkProgressionLootGates?.checked === true,
          areas: selectedProgressionAreas(progressionGateSourceList),
        },
      },
    },
  });
  if (!result?.success) appendLog('ERROR', result?.error || 'Could not save Progression settings');
}

function nonNegativeInputValue(input) {
  return Math.max(0, Math.trunc(Number(input?.value) || 0));
}

function percentageInputValue(input, minimum = 0) {
  const value = Math.min(100, Math.max(minimum, nonNegativeInputValue(input)));
  if (input) input.value = String(value);
  return value;
}

function updateOverflowModeLabel() {
  if (!inputOverflowAmount) return;
  const staminaMode = selectOverflowMode?.value === 'spend_stamina';
  inputOverflowAmount.title = staminaMode ? 'Stamina to spend on the selected monster' : 'Damage to deal to the selected monster';
  inputOverflowAmount.setAttribute('aria-label', staminaMode ? 'Stamina to spend' : 'Target damage');
}

async function saveResourcePolicy() {
  const staminaMin = percentageInputValue(inputKeepStaminaMin);
  const staminaMax = percentageInputValue(inputKeepStaminaMax, staminaMin);
  const result = await updateCanonicalConfig({
    resources: {
      stamina: {
        spendInRed: Boolean(chkSpendStaminaRed?.checked),
        overflowArea: selectOverflowArea?.value || null,
        overflowMonster: selectOverflowMonster?.value || '',
        overflowMode: selectOverflowMode?.value || 'target_damage',
        overflowAmount: nonNegativeInputValue(inputOverflowAmount),
        overflowBackupArea: selectOverflowBackupArea?.value || null,
        overflowBackupMonster: selectOverflowBackupMonster?.value || '',
        keepMin: staminaMin,
        keepMax: staminaMax,
        stopBelow: percentageInputValue(inputStopStaminaBelow),
        allowPotions: Boolean(chkAllowStaminaPots?.checked),
        potionLimits: {
          small: nonNegativeInputValue(inputSmallStaminaPotLimit),
          large: nonNegativeInputValue(inputLargeStaminaPotLimit),
          full: nonNegativeInputValue(inputFullStaminaPotLimit),
          adventure: nonNegativeInputValue(inputAdventureStaminaPotLimit),
        },
      },
      health: {
        sleepBelow: percentageInputValue(inputSleepHealthBelow),
        maxDeaths: nonNegativeInputValue(inputMaxDeaths),
        usePotions: Boolean(chkUseHealingPotions?.checked),
        maxPotions: nonNegativeInputValue(inputMaxHealingPotions),
        buyPotionIfNeeded: Boolean(chkBuyHealthPotion?.checked),
        maxPurchases: nonNegativeInputValue(inputMaxHealthPotionPurchases),
      },
      mana: {
        allowAbilities: Boolean(chkAllowManaAbilities?.checked),
        allowPotions: Boolean(chkAllowManaPotions?.checked),
        potionLimits: {
          small: nonNegativeInputValue(inputSmallManaPotLimit),
          large: nonNegativeInputValue(inputLargeManaPotLimit),
        },
        stopBelow: percentageInputValue(inputStopManaBelow),
        buyPotionIfNeeded: Boolean(chkBuyManaPotion?.checked),
        maxPurchases: nonNegativeInputValue(inputMaxManaPotionPurchases),
      },
    },
  });
  if (!result?.success) appendLog('ERROR', result?.error || 'Could not save resource policy');
}

async function saveEquipmentConfig() {
  const equipment = {};
  Object.entries(EQUIPMENT_SELECTS).forEach(([groupName, group]) => {
    equipment[groupName] = {};
    Object.entries(group).forEach(([context, select]) => {
      equipment[groupName][context] = select?.value || 'default';
    });
  });
  const result = await updateCanonicalConfig({ equipment });
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not save Equipment configuration');
  }
}

async function saveAttackStrategy() {
  const result = await updateCanonicalConfig({
    combat: {
      allowAbilities: Boolean(chkAllowClassAbilities?.checked),
      allowedAbilityIds: [...allowedCombatAbilityIds],
      attackStrategy: {
        mode: selectAttackMode?.value || 'fixed',
        fixedMultiplier: Number(selectFixedAttack?.value) || 1,
        maxMultiplier: Number(selectMaxAttack?.value) || 200,
        overshootPercent: Math.min(500, Math.max(0, nonNegativeInputValue(inputAttackOvershoot))),
        failSafeEnabled: Boolean(chkAdaptiveFailSafe?.checked),
        failSafePercent: Math.min(100, Math.max(0, nonNegativeInputValue(inputAdaptiveFailSafePercent))),
        requireTargetStamina: Boolean(chkAdaptiveRequireTargetStamina?.checked),
        nukeEnabled: Boolean(chkAdaptiveNuke?.checked),
        nukeAttack: selectAdaptiveNukeAttack?.value || configuredNukeAttack || 'auto',
        nukeAllowAbilities: Boolean(chkAdaptiveNukeAbilities?.checked),
      },
    },
  });
  if (!result?.success) appendLog('ERROR', result?.error || 'Could not save Attack Strategy');
}

function updateAttackModuleRows() {
  const adaptive = selectAttackMode?.value === 'adaptive';
  if (rowFixedAttack) rowFixedAttack.style.display = adaptive ? 'none' : 'flex';
  if (rowAdaptiveMax) rowAdaptiveMax.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveOvershoot) rowAdaptiveOvershoot.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveFailSafe) rowAdaptiveFailSafe.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveRequireTargetStamina) rowAdaptiveRequireTargetStamina.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveNuke) rowAdaptiveNuke.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveNukeAttack) rowAdaptiveNukeAttack.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveNukeAbilities) rowAdaptiveNukeAbilities.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveFailSafePercent) {
    rowAdaptiveFailSafePercent.style.display = adaptive ? 'flex' : 'none';
  }
}

function formatCombatValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '-';
}

function renderCombatPlayerStats(stats = latestStats) {
  if (combatPlayerAttack) combatPlayerAttack.textContent = formatCombatValue(stats?.attack);
  if (combatPlayerDefense) combatPlayerDefense.textContent = formatCombatValue(stats?.defense);
}

function selectedSetLabel(select) {
  return select?.selectedOptions?.[0]?.textContent || 'Selected set';
}

function closeLoadoutInfo() {
  if (modalLoadoutInfo) modalLoadoutInfo.style.display = 'none';
}

function loadoutInfoEmpty(message) {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = message;
  loadoutInfoContent?.replaceChildren(empty);
}

async function showLoadoutInfo(kind) {
  const isGear = kind === 'gear';
  const select = isGear ? selectGearPve : selectPetsPve;
  const label = selectedSetLabel(select);
  if (loadoutInfoTitle) loadoutInfoTitle.textContent = `${label} ${isGear ? 'Gear' : 'Pets'}`;
  if (loadoutInfoSummary) loadoutInfoSummary.textContent = '';
  if (modalLoadoutInfo) modalLoadoutInfo.style.display = 'flex';
  let items;
  let totals;
  const selectedValue = select?.value || 'default';
  if (selectedValue === 'default') {
    if (!activeCombatLoadout) await refreshCombatData(true);
    items = isGear ? activeCombatLoadout?.gear : activeCombatLoadout?.pets;
    totals = isGear ? activeCombatLoadout?.totals?.gear : activeCombatLoadout?.totals?.pets;
  } else {
    const setNumber = Number(String(selectedValue).replace(/^quick_set_/, ''));
    loadoutInfoEmpty(`Reading ${label}…`);
    const result = await window.botAPI.getSavedLoadoutSet({
      kind: isGear ? 'gear' : 'pets',
      setNumber,
      context: 'attack',
    });
    if (!result?.success) {
      loadoutInfoEmpty(result?.error || `${label} could not be read.`);
      return;
    }
    items = result.savedSet?.items;
    totals = result.savedSet?.totals;
  }
  if (loadoutInfoSummary) {
    loadoutInfoSummary.textContent = `ATK ${formatCombatValue(totals?.attack)} · DEF ${formatCombatValue(totals?.defense)}`;
  }
  if (!Array.isArray(items) || items.length === 0) {
    loadoutInfoEmpty(activeAccount ? 'No active items were found.' : 'Log in to read the active set.');
    return;
  }
  const table = document.createElement('div');
  table.className = 'loadout-info-table';
  const header = document.createElement('div');
  header.className = 'loadout-info-row loadout-info-header';
  for (const labelText of [isGear ? 'Gear' : 'Pet', 'ATK', 'DEF', 'Ability']) {
    const cell = document.createElement('span');
    cell.textContent = labelText;
    header.appendChild(cell);
  }
  table.appendChild(header);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'loadout-info-row';
    for (const value of [item.name || '-', formatCombatValue(item.attack), formatCombatValue(item.defense), item.ability || '—']) {
      const cell = document.createElement('span');
      cell.textContent = value;
      cell.title = value;
      row.appendChild(cell);
    }
    table.appendChild(row);
  }
  loadoutInfoContent?.replaceChildren(table);
}

function renderUnlockedAbilities(data) {
  if (!combatUnlockedAbilities) return;
  populateNukeAttackOptions(data);
  const entries = [];
  if (data?.classPassive) {
    const passive = document.createElement('span');
    passive.className = 'combat-ability-chip combat-ability-passive';
    passive.textContent = `${data.className} passive · ${data.classPassive}`;
    passive.title = passive.textContent;
    entries.push(passive);
  }
  for (const skill of data?.unlockedSkills || []) {
    const cost = [skill.manaCost > 0 ? `${skill.manaCost} MP` : null, skill.staminaCost > 0 ? `${skill.staminaCost} Stamina` : null]
      .filter(Boolean)
      .join(', ') || 'No direct cost';
    if (skill.passive) {
      const passive = document.createElement('span');
      passive.className = 'combat-ability-chip combat-ability-passive';
      passive.textContent = `${skill.name} · Passive`;
      passive.title = passive.textContent;
      entries.push(passive);
      continue;
    }
    const item = document.createElement('label');
    item.className = 'combat-ability-chip combat-ability-option';
    item.title = `${skill.name} · ${cost}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tree-checkbox combat-ability-checkbox';
    checkbox.checked = allowedCombatAbilityIds.has(skill.id);
    checkbox.disabled = chkAllowClassAbilities?.checked !== true;
    checkbox.setAttribute('aria-label', `Allow ${skill.name}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) allowedCombatAbilityIds.add(skill.id);
      else allowedCombatAbilityIds.delete(skill.id);
      saveAttackStrategy();
    });
    const text = document.createElement('span');
    text.textContent = `${skill.name} · ${cost}`;
    item.append(text, checkbox);
    entries.push(item);
  }
  if (entries.length > 0) {
    combatUnlockedAbilities.replaceChildren(...entries);
    return;
  }
  combatUnlockedAbilities.replaceChildren(...['No class abilities found'].map(textValue => {
    const item = document.createElement('span');
    item.className = 'combat-ability-chip';
    item.textContent = textValue;
    item.title = textValue;
    return item;
  }));
}

function populateNukeAttackOptions(data) {
  if (!selectAdaptiveNukeAttack) return;
  const selected = configuredNukeAttack || selectAdaptiveNukeAttack.value || 'auto';
  const options = [
    ['auto', 'Auto'],
    ['normal:1', 'x1'], ['normal:10', 'x10'], ['normal:50', 'x50'],
    ['normal:100', 'x100'], ['normal:200', 'x200'], ['normal:1000', 'x1000'],
  ];
  for (const skill of data?.unlockedSkills || []) {
    if (skill.passive || !Number.isInteger(Number(skill.id))) continue;
    options.push([`ability:${skill.id}`, `${skill.name} (ability)`]);
  }
  selectAdaptiveNukeAttack.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  if (options.some(([value]) => value === selected)) selectAdaptiveNukeAttack.value = selected;
  else selectAdaptiveNukeAttack.value = 'auto';
}

async function refreshClassSkills(force = false) {
  if (!activeAccount) return;
  if (!force && activeClassSkills) {
    renderUnlockedAbilities(activeClassSkills);
    return;
  }
  try {
    const result = await window.botAPI.getClassSkills(force);
    if (!result?.success) {
      if (combatUnlockedAbilities) combatUnlockedAbilities.textContent = result?.error || 'Class skills could not be read';
      return;
    }
    activeClassSkills = result.skillTree;
    renderUnlockedAbilities(activeClassSkills);
  } catch (error) {
    if (combatUnlockedAbilities) combatUnlockedAbilities.textContent = error.message || 'Class skills could not be read';
  }
}

async function refreshAttackStrategyStatus(force = false) {
  if (!activeAccount) return;
  try {
    const result = await window.botAPI.getAttackStrategyStatus(force);
    if (!result?.success) throw new Error(result?.error || 'Active loadout could not be read');
    const loadout = result.loadout || {};
    activeCombatLoadout = loadout;
    const gearTotals = loadout.totals?.gear || {};
    const petTotals = loadout.totals?.pets || {};
    if (combatGearAttack) combatGearAttack.textContent = formatCombatValue(gearTotals.attack);
    if (combatGearDefense) combatGearDefense.textContent = formatCombatValue(gearTotals.defense);
    if (combatPetAttack) combatPetAttack.textContent = formatCombatValue(petTotals.attack);
    if (combatPetDefense) combatPetDefense.textContent = formatCombatValue(petTotals.defense);
    renderCombatPlayerStats();
  } catch (error) {
    appendLog('WARN', error.message || 'Active loadout could not be read');
  }
}

async function refreshCombatData(force = false) {
  if (!activeAccount) return;
  if (btnRefreshAttackStrategy) btnRefreshAttackStrategy.disabled = true;
  try {
    await Promise.all([refreshAttackStrategyStatus(force), refreshClassSkills(force)]);
  } finally {
    if (btnRefreshAttackStrategy) btnRefreshAttackStrategy.disabled = false;
    if (window.lucide) window.lucide.createIcons();
  }
}

function loadHomeConfiguration(config) {
  const requestedModule = config.general?.module || 'idle';
  const supportedModule = selectGeneralModule
    && [...selectGeneralModule.options].some(option => option.value === requestedModule)
    ? requestedModule
    : 'idle';
  if (selectGeneralModule) selectGeneralModule.value = supportedModule;
  updateGeneralMaps(
    config.general?.primaryGateMap
      || (supportedModule === 'gates' ? config.general?.map : null)
      || null,
    config.general?.dungeonMap || null,
    config.general?.gateMap || null,
    config.general?.eventMap || null,
  );
  if (supportedModule !== requestedModule) {
    updateCanonicalConfig({ general: { module: 'idle', map: null } })
      .then(result => {
        if (!result?.success) appendLog('ERROR', result?.error || 'Could not normalize unsupported Module');
      });
  }
  const progression = config.progression || {};
  if (chkEnableProgression) chkEnableProgression.checked = progression.enabled === true;
  if (chkProgressionLootLeveling) chkProgressionLootLeveling.checked = progression.useLootForLeveling === true;
  if (chkProgressionChapterFallback) chkProgressionChapterFallback.checked = progression.allowChapterFallback === true;
  if (chkProgressionPotionFallback) chkProgressionPotionFallback.checked = progression.allowTargetPotionFallback === true;
  if (chkProgressionLootDungeons) chkProgressionLootDungeons.checked = progression.lootSources?.dungeons?.enabled === true;
  if (chkProgressionLootEvents) chkProgressionLootEvents.checked = progression.lootSources?.events?.enabled === true;
  if (chkProgressionLootGates) chkProgressionLootGates.checked = progression.lootSources?.gates?.enabled === true;
  loadProgressionAreaSelection(progressionDungeonSourceList, progression.lootSources?.dungeons?.areas);
  loadProgressionAreaSelection(progressionEventSourceList, progression.lootSources?.events?.areas);
  loadProgressionAreaSelection(progressionGateSourceList, progression.lootSources?.gates?.areas);
  updateProgressionControls();
  const stamina = config.resources?.stamina || {};
  const health = config.resources?.health || {};
  const mana = config.resources?.mana || {};
  lootingConfig = config.looting || { maps: {} };
  monsterConfig = config.monsters || { maps: {} };
  populateOverflowAreaOptions(selectOverflowArea, stamina.overflowArea, 'Choose primary');
  populateOverflowMonsterOptions(stamina.overflowArea, selectOverflowMonster, stamina.overflowMonster);
  populateOverflowAreaOptions(selectOverflowBackupArea, stamina.overflowBackupArea, 'No backup');
  populateOverflowMonsterOptions(stamina.overflowBackupArea, selectOverflowBackupMonster, stamina.overflowBackupMonster);
  if (chkSpendStaminaRed) chkSpendStaminaRed.checked = stamina.spendInRed === true;
  if (selectOverflowMode) selectOverflowMode.value = stamina.overflowMode || 'target_damage';
  if (inputOverflowAmount) inputOverflowAmount.value = stamina.overflowAmount ?? 0;
  updateOverflowModeLabel();
  if (inputKeepStaminaMin) inputKeepStaminaMin.value = stamina.keepMin ?? 0;
  if (inputKeepStaminaMax) inputKeepStaminaMax.value = stamina.keepMax ?? 0;
  if (inputStopStaminaBelow) inputStopStaminaBelow.value = stamina.stopBelow ?? 0;
  if (chkAllowStaminaPots) chkAllowStaminaPots.checked = stamina.allowPotions === true;
  if (inputSmallStaminaPotLimit) inputSmallStaminaPotLimit.value = stamina.potionLimits?.small ?? 0;
  if (inputLargeStaminaPotLimit) inputLargeStaminaPotLimit.value = stamina.potionLimits?.large ?? 0;
  if (inputFullStaminaPotLimit) inputFullStaminaPotLimit.value = stamina.potionLimits?.full ?? 0;
  if (inputAdventureStaminaPotLimit) inputAdventureStaminaPotLimit.value = stamina.potionLimits?.adventure ?? 0;
  if (inputSleepHealthBelow) inputSleepHealthBelow.value = health.sleepBelow ?? 0;
  if (inputMaxDeaths) inputMaxDeaths.value = health.maxDeaths ?? 0;
  if (chkUseHealingPotions) chkUseHealingPotions.checked = health.usePotions === true;
  if (inputMaxHealingPotions) inputMaxHealingPotions.value = health.maxPotions ?? 0;
  if (chkBuyHealthPotion) chkBuyHealthPotion.checked = health.buyPotionIfNeeded === true;
  if (inputMaxHealthPotionPurchases) inputMaxHealthPotionPurchases.value = health.maxPurchases ?? 0;
  if (healthPotsPurchasedCount) healthPotsPurchasedCount.textContent = String(health.purchasedCount ?? 0);
  if (chkAllowManaAbilities) chkAllowManaAbilities.checked = mana.allowAbilities === true;
  if (chkAllowManaPotions) chkAllowManaPotions.checked = mana.allowPotions === true;
  if (inputSmallManaPotLimit) inputSmallManaPotLimit.value = mana.potionLimits?.small ?? 0;
  if (inputLargeManaPotLimit) inputLargeManaPotLimit.value = mana.potionLimits?.large ?? 0;
  if (inputStopManaBelow) inputStopManaBelow.value = mana.stopBelow ?? 0;
  if (chkBuyManaPotion) chkBuyManaPotion.checked = mana.buyPotionIfNeeded === true;
  if (inputMaxManaPotionPurchases) inputMaxManaPotionPurchases.value = mana.maxPurchases ?? 0;
  if (manaPotsPurchasedCount) manaPotsPurchasedCount.textContent = String(mana.purchasedCount ?? 0);
  Object.entries(EQUIPMENT_SELECTS).forEach(([groupName, group]) => {
    Object.entries(group).forEach(([context, select]) => {
      if (select) select.value = config.equipment?.[groupName]?.[context] || 'default';
    });
  });
  const attackStrategy = config.combat?.attackStrategy || {};
  if (selectAttackMode) selectAttackMode.value = attackStrategy.mode || 'fixed';
  if (selectFixedAttack) selectFixedAttack.value = String(attackStrategy.fixedMultiplier || 1);
  if (selectMaxAttack) selectMaxAttack.value = String(attackStrategy.maxMultiplier || 200);
  if (inputAttackOvershoot) inputAttackOvershoot.value = attackStrategy.overshootPercent ?? 10;
  if (chkAdaptiveFailSafe) chkAdaptiveFailSafe.checked = attackStrategy.failSafeEnabled === true;
  if (inputAdaptiveFailSafePercent) inputAdaptiveFailSafePercent.value = attackStrategy.failSafePercent ?? 80;
  if (chkAdaptiveRequireTargetStamina) chkAdaptiveRequireTargetStamina.checked = attackStrategy.requireTargetStamina === true;
  if (chkAdaptiveNuke) chkAdaptiveNuke.checked = attackStrategy.nukeEnabled === true;
  configuredNukeAttack = attackStrategy.nukeAttack || 'auto';
  populateNukeAttackOptions(activeClassSkills);
  if (chkAdaptiveNukeAbilities) chkAdaptiveNukeAbilities.checked = attackStrategy.nukeAllowAbilities === true;
  if (chkAllowClassAbilities) chkAllowClassAbilities.checked = config.combat?.allowAbilities === true;
  allowedCombatAbilityIds = new Set(config.combat?.allowedAbilityIds || []);
  if (activeClassSkills) renderUnlockedAbilities(activeClassSkills);
  updateAttackModuleRows();
}

function loadSchedulerConfiguration(config) {
  const attackIntervals = config.scheduler?.attackIntervals || {};
  if (inputActionMinDelaySeconds) inputActionMinDelaySeconds.value = ((attackIntervals.gate?.minDelay || 1050) / 1000).toFixed(2);
  if (inputActionMaxDelaySeconds) inputActionMaxDelaySeconds.value = ((attackIntervals.gate?.maxDelay || 1200) / 1000).toFixed(2);
  if (chkDryRun) chkDryRun.checked = config.safety?.dryRun !== false;
  if (botModeText) {
    botModeText.textContent = chkDryRun?.checked ? 'Dry run' : 'Live actions';
    botModeText.classList.toggle('live-mode', !chkDryRun?.checked);
  }
}

if (btnSaveConfig) {
  btnSaveConfig.addEventListener('click', async () => {
    await flushPendingConfigSaves();
    btnSaveConfig.disabled = true;
    try {
      const result = await window.botAPI.exportConfig();
      if (result?.success) appendLog('INFO', `Saved configuration preset: ${result.fileName}`);
      else if (!result?.canceled) appendLog('ERROR', result?.error || 'Could not save configuration preset');
    } finally {
      btnSaveConfig.disabled = false;
    }
  });
}

if (btnLoadConfig) {
  btnLoadConfig.addEventListener('click', async () => {
    await flushPendingConfigSaves();
    btnLoadConfig.disabled = true;
    try {
      const result = await window.botAPI.importConfig();
      if (!result?.success) {
        if (!result?.canceled) appendLog('ERROR', result?.error || 'Could not load configuration preset');
        return;
      }
      monsterAreaCache.clear();
      lootAreaCache.clear();
      loadHomeConfiguration(result.config);
      loadSchedulerConfiguration(result.config);
      appendLog('INFO', `Loaded configuration preset: ${result.fileName}`);
      if (currentTab === 'npcConfig') await loadMonsterWorkspace(true);
      if (currentTab === 'lootConfig') await loadLootWorkspace(true);
    } finally {
      btnLoadConfig.disabled = false;
      if (window.lucide) window.lucide.createIcons();
    }
  });
}

populateEquipmentSetOptions();
populateProgressionSourceLists();
populateOverflowAreaOptions(selectOverflowArea, null, 'Choose primary');
populateOverflowMonsterOptions('', selectOverflowMonster);
populateOverflowAreaOptions(selectOverflowBackupArea, null, 'No backup');
populateOverflowMonsterOptions('', selectOverflowBackupMonster);
enhanceNumberInputs();
for (const control of [
  chkEnableProgression,
  chkProgressionLootLeveling,
  chkProgressionLootDungeons,
  chkProgressionLootEvents,
  chkProgressionLootGates,
  chkProgressionChapterFallback,
  chkProgressionPotionFallback,
]) {
  if (control) control.addEventListener('change', saveProgressionSettings);
}
updateProgressionControls();
for (const control of [
  chkSpendStaminaRed, selectOverflowMonster, selectOverflowMode, inputOverflowAmount, selectOverflowBackupMonster,
  inputKeepStaminaMin, inputKeepStaminaMax, inputStopStaminaBelow, chkAllowStaminaPots,
  inputSmallStaminaPotLimit, inputLargeStaminaPotLimit, inputFullStaminaPotLimit, inputAdventureStaminaPotLimit,
  inputSleepHealthBelow, inputMaxDeaths,
  chkUseHealingPotions, inputMaxHealingPotions, chkBuyHealthPotion, inputMaxHealthPotionPurchases,
  chkAllowManaAbilities, chkAllowManaPotions, inputSmallManaPotLimit, inputLargeManaPotLimit,
  inputStopManaBelow, chkBuyManaPotion, inputMaxManaPotionPurchases,
]) {
  if (control) control.addEventListener('change', saveResourcePolicy);
}
if (selectOverflowArea) {
  selectOverflowArea.addEventListener('change', async () => {
    await refreshOverflowMonsterOptions(selectOverflowArea, selectOverflowMonster, '', true);
    await saveResourcePolicy();
  });
}
if (selectOverflowBackupArea) {
  selectOverflowBackupArea.addEventListener('change', async () => {
    await refreshOverflowMonsterOptions(selectOverflowBackupArea, selectOverflowBackupMonster, '', true);
    await saveResourcePolicy();
  });
}
if (selectOverflowMode) selectOverflowMode.addEventListener('change', updateOverflowModeLabel);
updateOverflowModeLabel();
async function resetPurchaseCounter(type) {
  const result = await updateCanonicalConfig({ resources: { [type]: { purchasedCount: 0 } } });
  if (!result?.success) {
    appendLog('ERROR', result?.error || `Could not reset ${type} purchase counter`);
    return;
  }
  const counter = type === 'health' ? healthPotsPurchasedCount : manaPotsPurchasedCount;
  if (counter) counter.textContent = '0';
}
if (btnResetHealthPurchases) btnResetHealthPurchases.addEventListener('click', () => resetPurchaseCounter('health'));
if (btnResetManaPurchases) btnResetManaPurchases.addEventListener('click', () => resetPurchaseCounter('mana'));
Object.values(EQUIPMENT_SELECTS).flatMap(group => Object.values(group)).forEach(select => {
  if (select) select.addEventListener('change', saveEquipmentConfig);
});
if (selectAttackMode) {
  selectAttackMode.addEventListener('change', () => {
    updateAttackModuleRows();
    saveAttackStrategy();
  });
}
for (const control of [selectFixedAttack, selectMaxAttack, inputAttackOvershoot]) {
  if (control) control.addEventListener('change', saveAttackStrategy);
}
if (chkAllowClassAbilities) {
  chkAllowClassAbilities.addEventListener('change', () => {
    if (activeClassSkills) renderUnlockedAbilities(activeClassSkills);
    saveAttackStrategy();
  });
}
if (chkAdaptiveFailSafe) {
  chkAdaptiveFailSafe.addEventListener('change', () => {
    updateAttackModuleRows();
    saveAttackStrategy();
  });
}
if (inputAdaptiveFailSafePercent) inputAdaptiveFailSafePercent.addEventListener('change', saveAttackStrategy);
if (chkAdaptiveRequireTargetStamina) chkAdaptiveRequireTargetStamina.addEventListener('change', saveAttackStrategy);
if (chkAdaptiveNuke) {
  chkAdaptiveNuke.addEventListener('change', () => {
    updateAttackModuleRows();
    saveAttackStrategy();
  });
}
if (selectAdaptiveNukeAttack) selectAdaptiveNukeAttack.addEventListener('change', () => {
  configuredNukeAttack = selectAdaptiveNukeAttack.value || 'auto';
  saveAttackStrategy();
});
if (chkAdaptiveNukeAbilities) chkAdaptiveNukeAbilities.addEventListener('change', saveAttackStrategy);
if (btnRefreshAttackStrategy) btnRefreshAttackStrategy.addEventListener('click', () => refreshCombatData(true));
if (btnGearSetInfo) btnGearSetInfo.addEventListener('click', () => showLoadoutInfo('gear'));
if (btnPetSetInfo) btnPetSetInfo.addEventListener('click', () => showLoadoutInfo('pets'));
if (btnCloseLoadoutInfo) btnCloseLoadoutInfo.addEventListener('click', closeLoadoutInfo);
if (modalLoadoutInfo) {
  modalLoadoutInfo.addEventListener('click', event => {
    if (event.target === modalLoadoutInfo) closeLoadoutInfo();
  });
}
updateAttackModuleRows();

function createMonsterSetSelect(value, label) {
  const select = document.createElement('select');
  select.className = 'monster-set-select';
  select.setAttribute('aria-label', label);
  for (let setNumber = 0; setNumber <= 10; setNumber += 1) {
    const option = document.createElement('option');
    option.value = setNumber === 0 ? 'default' : `quick_set_${setNumber}`;
    option.textContent = setNumber === 0 ? 'Default' : `Quick Set ${setNumber}`;
    select.appendChild(option);
  }
  select.value = value || 'default';
  return select;
}

function createStaminaPotionSelect(value, label) {
  const select = document.createElement('select');
  select.className = 'monster-potion-select';
  select.setAttribute('aria-label', label);
  for (const [optionValue, optionLabel] of [
    ['none', 'None'],
    ['small', 'Small Pot'],
    ['large', 'Large Pot'],
    ['full', 'Full Pot'],
    ['adventure', 'Adventure Pot'],
  ]) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionLabel;
    select.appendChild(option);
  }
  select.value = value || 'none';
  return select;
}

function areaWorkspaceType(area) {
  if (Number.isInteger(Number(area?.eventId))) return 'event';
  return area?.type || 'gate';
}

function populateTypedAreaSelect(select, type, selectedKey = null) {
  if (!select) return null;
  const areas = monsterCatalog.filter(area => areaWorkspaceType(area) === type);
  select.replaceChildren(...areas.map(area => {
    const option = document.createElement('option');
    option.value = area.key;
    option.textContent = area.label;
    return option;
  }));
  const nextKey = selectedKey && areas.some(area => area.key === selectedKey)
    ? selectedKey
    : areas[0]?.key || null;
  if (nextKey) select.value = nextKey;
  return nextKey;
}

function populateTargetAreaSelect(type, selectedKey = null) {
  return populateTypedAreaSelect(targetAreaSelect, type, selectedKey);
}

function populateLootAreaSelect(type, selectedKey = null) {
  return populateTypedAreaSelect(lootAreaSelect, type, selectedKey);
}

async function saveMonsterRow(areaKey, monsterKey, name, controls) {
  const entry = {
    name,
    targetDamage: Math.max(0, Math.trunc(Number(controls.targetDamage.value) || 0)),
    killCount: Math.max(0, Math.trunc(Number(controls.killCount.value) || 0)),
    unlimited: controls.unlimited.checked,
    priority: Math.max(0, Math.trunc(Number(controls.priority.value) || 0)),
    minimumHp: Math.max(0, Math.trunc(Number(controls.minimumHp.value) || 0)),
    gearSet: controls.gearSet.value,
    petSet: controls.petSet.value,
    staminaPotion: controls.staminaPotion.value,
    enabled: controls.enabled.checked,
  };
  const result = await updateCanonicalConfig({
    monsters: { maps: { [areaKey]: { [monsterKey]: entry } } },
  });
  if (result?.success) {
    monsterConfig = result.config?.monsters || monsterConfig;
  } else {
    appendLog('ERROR', result?.error || `Could not save ${name} configuration`);
  }
}

function renderMonsterArea(area, discovered = [], sourceAvailable = true, message = '') {
  if (!monsterAreaContent) return;
  const saved = monsterConfig.maps?.[area.key] || {};
  const merged = new Map(discovered.map(monster => [monster.key, monster]));
  Object.entries(saved).forEach(([key, entry]) => {
    if (!merged.has(key)) merged.set(key, { key, name: entry.name, boss: false, instances: 0, savedOnly: true });
  });

  if (!sourceAvailable && merged.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-config-panel compact-empty-config';
    const title = document.createElement('strong');
    title.textContent = `${area.label} uses a changing dungeon instance`;
    const detail = document.createElement('span');
    detail.textContent = message || 'Monster discovery will become available when an active dungeon instance can be resolved.';
    empty.append(title, detail);
    monsterAreaContent.replaceChildren(empty);
    return;
  }

  if (merged.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = message || `No monster types were found for ${area.label}.`;
    monsterAreaContent.replaceChildren(empty);
    return;
  }

  const table = document.createElement('div');
  table.className = 'monster-config-table';
  const header = document.createElement('div');
  header.className = 'monster-config-row monster-config-header';
  for (const [label, title] of [
    ['Monster', 'Monster Name'], ['Alive', 'Currently alive / total discovered'], ['Stats', 'Monster stats'], ['Damage', 'Target damage'], ['Kills', 'Kill count'], ['∞', 'Unlimited targets'],
    ['Pri', 'Priority — lower numbers run first'], ['Min HP', 'Minimum HP'],
    ['Done', 'Completed target count'], ['Gear', 'Gear set'], ['Pet', 'Pet set'],
    ['Potions', 'Stamina potion selection'], ['Target', 'Target enabled'],
  ]) {
    const cell = document.createElement('span');
    cell.textContent = label;
    cell.title = title;
    header.appendChild(cell);
  }
  table.appendChild(header);

  for (const monster of [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const stored = saved[monster.key] || {};
    const row = document.createElement('div');
    row.className = 'monster-config-row';
    const name = document.createElement('div');
    name.className = 'monster-config-name';
    const nameText = document.createElement('span');
    nameText.className = 'monster-config-name-text';
    nameText.textContent = monster.name;
    name.appendChild(nameText);
    if (monster.boss) {
      const badge = document.createElement('span');
      badge.className = 'monster-boss-badge';
      badge.textContent = 'Boss';
      name.appendChild(badge);
    }
    const availability = document.createElement('span');
    availability.className = 'monster-availability-count';
    const aliveCount = Math.max(0, Number(monster.aliveCount ?? monster.instances) || 0);
    const totalCount = Math.max(aliveCount, Number(monster.totalCount ?? monster.instances) || 0);
    availability.textContent = `${aliveCount}/${totalCount}`;
    availability.title = `${aliveCount} currently alive out of ${totalCount} discovered`;
    const statsButton = document.createElement('button');
    statsButton.type = 'button';
    statsButton.className = `monster-stats-help${monster.statsAvailable ? ' has-stats' : ''}`;
    statsButton.textContent = '?';
    statsButton.title = `View verified stats for ${monster.name}`;
    statsButton.setAttribute('aria-label', `View ${monster.name} stats`);
    statsButton.addEventListener('click', () => monsterStatsView?.open(area.key, monster.key, monster.name));

    const targetDamage = document.createElement('input');
    targetDamage.type = 'number';
    targetDamage.min = '0';
    targetDamage.step = '1';
    targetDamage.value = stored.targetDamage ?? 0;
    targetDamage.className = 'monster-number-input';
    targetDamage.setAttribute('aria-label', `${monster.name} target damage`);

    const killCount = document.createElement('input');
    killCount.type = 'number';
    killCount.min = '0';
    killCount.step = '1';
    killCount.value = stored.killCount ?? 0;
    killCount.className = 'monster-number-input';
    killCount.setAttribute('aria-label', `${monster.name} kill count`);

    const unlimited = document.createElement('input');
    unlimited.type = 'checkbox';
    unlimited.className = 'tree-checkbox monster-unlimited';
    unlimited.checked = stored.unlimited === true;
    unlimited.title = 'Keep targeting new instances without a kill-count limit.';
    unlimited.setAttribute('aria-label', `Unlimited targets for ${monster.name}`);
    const updateTargetLimitState = () => {
      killCount.disabled = unlimited.checked;
      killCount.classList.toggle('module-setting-disabled', unlimited.checked);
    };
    updateTargetLimitState();

    const priority = document.createElement('input');
    priority.type = 'number';
    priority.min = '0';
    priority.step = '1';
    priority.value = stored.priority ?? 0;
    priority.className = 'monster-number-input';
    priority.title = 'Lower numbers are targeted first; equal priorities sort by monster name.';
    priority.setAttribute('aria-label', `${monster.name} target priority`);

    const minimumHp = document.createElement('input');
    minimumHp.type = 'number';
    minimumHp.min = '0';
    minimumHp.step = '1';
    minimumHp.value = stored.minimumHp ?? 0;
    minimumHp.className = 'monster-number-input';
    minimumHp.title = 'Ignore an instance when its current HP is below this value.';
    minimumHp.setAttribute('aria-label', `${monster.name} minimum current HP`);

    const progress = document.createElement('div');
    progress.className = 'monster-progress';
    const progressText = document.createElement('span');
    progressText.textContent = `${stored.completedCount || 0}/${stored.unlimited === true ? '∞' : (stored.killCount || 0)}`;
    const resetProgress = document.createElement('button');
    resetProgress.type = 'button';
    resetProgress.className = 'monster-progress-reset';
    resetProgress.textContent = '↺';
    resetProgress.title = `Reset completed target count for ${monster.name}`;
    resetProgress.addEventListener('click', async () => {
      const result = await updateCanonicalConfig({
        monsters: { maps: { [area.key]: { [monster.key]: { completedCount: 0, completedInstanceIds: [] } } } },
      });
      if (result?.success) {
        monsterConfig = result.config?.monsters || monsterConfig;
        progressText.textContent = `0/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
      } else {
        appendLog('ERROR', result?.error || `Could not reset ${monster.name} progress`);
      }
    });
    progress.append(progressText, resetProgress);

    const gearSet = createMonsterSetSelect(stored.gearSet, `${monster.name} Gear set`);
    const petSet = createMonsterSetSelect(stored.petSet, `${monster.name} Pet set`);
    const staminaPotion = createStaminaPotionSelect(stored.staminaPotion, `${monster.name} stamina potion`);
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'tree-checkbox monster-enabled';
    enabled.checked = stored.enabled === true;
    enabled.title = 'Include this monster type as an automation target.';
    enabled.setAttribute('aria-label', `Target ${monster.name}`);

    const controls = { targetDamage, killCount, unlimited, priority, minimumHp, gearSet, petSet, staminaPotion, enabled };
    Object.values(controls).forEach(control => {
      control.addEventListener('change', () => {
        saveMonsterRow(area.key, monster.key, monster.name, controls);
      });
    });
    killCount.addEventListener('change', () => {
      progressText.textContent = `${stored.completedCount || 0}/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
    });
    unlimited.addEventListener('change', () => {
      updateTargetLimitState();
      progressText.textContent = `${stored.completedCount || 0}/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
    });
    row.append(name, availability, statsButton, targetDamage, killCount, unlimited, priority, minimumHp, progress, gearSet, petSet, staminaPotion, enabled);
    enhanceNumberInputs(row);
    table.appendChild(row);
  }

  monsterAreaContent.replaceChildren(table);
}

async function selectMonsterArea(areaKey, force = false) {
  const area = monsterCatalog.find(candidate => candidate.key === areaKey);
  if (!area || !monsterAreaContent) return;
  if (force) {
    const latestConfig = await window.botAPI.getConfig();
    monsterConfig = latestConfig?.monsters || monsterConfig;
  }
  activeMonsterAreaKey = areaKey;
  if (targetAreaSelect) targetAreaSelect.value = areaKey;
  if (targetAreaTypeSelect) targetAreaTypeSelect.value = areaWorkspaceType(area);

  if (!force && monsterAreaCache.has(areaKey)) {
    const cached = monsterAreaCache.get(areaKey);
    renderMonsterArea(area, cached.monsters, cached.sourceAvailable, cached.message);
    return;
  }

  monsterAreaContent.innerHTML = '<div class="empty-state">Loading monster types…</div>';
  const result = await window.botAPI.listMonstersForArea(areaKey);
  if (!result?.success) {
    renderMonsterArea(area, [], true, result?.error || 'Monster discovery failed.');
    return;
  }
  monsterAreaCache.set(areaKey, result);
  if (selectOverflowArea?.value === areaKey) {
    populateOverflowMonsterOptions(areaKey, selectOverflowMonster, selectOverflowMonster?.value || '');
  }
  if (selectOverflowBackupArea?.value === areaKey) {
    populateOverflowMonsterOptions(areaKey, selectOverflowBackupMonster, selectOverflowBackupMonster?.value || '');
  }
  renderMonsterArea(area, result.monsters || [], result.sourceAvailable !== false, result.message || '');
}

async function loadMonsterWorkspace(force = false) {
  const latestConfig = await window.botAPI.getConfig();
  monsterConfig = latestConfig?.monsters || monsterConfig;
  if (monsterCatalog.length === 0) {
    monsterCatalog = await window.botAPI.getMonsterCatalog();
  }
  const selectedArea = monsterCatalog.find(area => area.key === activeMonsterAreaKey);
  const selectedType = (selectedArea && areaWorkspaceType(selectedArea))
    || targetAreaTypeSelect?.value
    || 'gate';
  if (targetAreaTypeSelect) targetAreaTypeSelect.value = selectedType;
  activeMonsterAreaKey = populateTargetAreaSelect(selectedType, activeMonsterAreaKey);
  if (activeMonsterAreaKey) await selectMonsterArea(activeMonsterAreaKey, force);
}

if (targetAreaSelect) {
  targetAreaSelect.addEventListener('change', () => selectMonsterArea(targetAreaSelect.value));
}
if (targetAreaTypeSelect) {
  targetAreaTypeSelect.addEventListener('change', async () => {
    activeMonsterAreaKey = populateTargetAreaSelect(targetAreaTypeSelect.value);
    if (activeMonsterAreaKey) await selectMonsterArea(activeMonsterAreaKey);
  });
}

if (btnRefreshMonsterArea) {
  btnRefreshMonsterArea.addEventListener('click', async () => {
    if (!activeMonsterAreaKey) return;
    btnRefreshMonsterArea.disabled = true;
    try {
      await selectMonsterArea(activeMonsterAreaKey, true);
    } finally {
      btnRefreshMonsterArea.disabled = false;
    }
  });
}

if (btnCollectMonsterStats) {
  btnCollectMonsterStats.addEventListener('click', async () => {
    if (!activeMonsterAreaKey) return;
    btnCollectMonsterStats.disabled = true;
    const previousText = btnCollectMonsterStats.textContent;
    btnCollectMonsterStats.textContent = 'Collecting…';
    try {
      const result = await window.botAPI.collectMonsterStatsForArea(activeMonsterAreaKey);
      if (!result?.success) throw new Error(result?.error || 'Monster Stats collection failed');
      const details = `${result.collected} read, ${result.conflicts} conflicts, ${result.errors?.length || 0} errors`;
      appendLog(result.errors?.length || result.conflicts ? 'WARN' : 'INFO', `Monster Stats: ${details}`);
      monsterAreaCache.delete(activeMonsterAreaKey);
      await selectMonsterArea(activeMonsterAreaKey, true);
    } catch (error) {
      appendLog('ERROR', error.message);
    } finally {
      btnCollectMonsterStats.disabled = false;
      btnCollectMonsterStats.textContent = previousText;
    }
  });
}

async function saveLootRow(areaKey, monsterKey, name, controls) {
  const entry = {
    name,
    priority: nonNegativeInputValue(controls.priority),
    maxLooting: nonNegativeInputValue(controls.maxLooting),
    unlimited: Boolean(controls.unlimited.checked),
    enabled: Boolean(controls.enabled.checked),
  };
  const result = await updateCanonicalConfig({
    looting: { maps: { [areaKey]: { [monsterKey]: entry } } },
  });
  if (result?.success) {
    lootingConfig = result.config?.looting || lootingConfig;
  } else {
    appendLog('ERROR', result?.error || `Could not save ${name} loot priority`);
  }
}

function renderLootArea(area, discovered = [], sourceAvailable = true, message = '') {
  if (!lootAreaContent) return;
  const savedTargets = monsterConfig.maps?.[area.key] || {};
  const savedLoot = lootingConfig.maps?.[area.key] || {};
  const merged = new Map(discovered.map(monster => [monster.key, monster]));
  for (const [key, entry] of Object.entries(savedTargets)) {
    if (!merged.has(key)) merged.set(key, { key, name: entry.name, boss: false, savedOnly: true });
  }
  for (const [key, entry] of Object.entries(savedLoot)) {
    if (!merged.has(key)) merged.set(key, { key, name: entry.name, boss: false, savedOnly: true });
  }

  if (merged.size === 0) {
    const empty = document.createElement('div');
    empty.className = sourceAvailable ? 'empty-state' : 'empty-config-panel compact-empty-config';
    empty.textContent = message || (sourceAvailable
      ? `No monster types were found for ${area.label}.`
      : 'Dungeon monster discovery requires an active dungeon instance.');
    lootAreaContent.replaceChildren(empty);
    return;
  }

  const table = document.createElement('div');
  table.className = 'loot-config-table';
  const header = document.createElement('div');
  header.className = 'loot-config-row loot-config-header';
  for (const label of ['Monster', 'Lootable', 'Priority', 'Max looting', '∞', 'Done', 'Loot']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    header.appendChild(cell);
  }
  table.appendChild(header);
  for (const monster of [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const stored = savedLoot[monster.key] || {};
    const row = document.createElement('div');
    row.className = 'loot-config-row';
    const name = document.createElement('div');
    name.className = 'monster-config-name';
    name.textContent = monster.name;
    if (monster.boss) {
      const badge = document.createElement('span');
      badge.className = 'monster-boss-badge';
      badge.textContent = 'Boss';
      name.appendChild(badge);
    }
    const lootable = document.createElement('span');
    lootable.className = 'lootable-count';
    lootable.textContent = Number.isFinite(Number(monster.lootableCount)) ? String(monster.lootableCount) : '—';
    lootable.title = `${monster.name} currently available to loot`;
    const priority = document.createElement('input');
    priority.type = 'number';
    priority.min = '0';
    priority.step = '1';
    priority.value = stored.priority ?? 0;
    priority.className = 'monster-number-input loot-priority-input';
    priority.title = 'Lower numbers are looted first; equal priorities sort by monster name.';
    priority.setAttribute('aria-label', `${monster.name} loot priority`);
    const maxLooting = document.createElement('input');
    maxLooting.type = 'number';
    maxLooting.min = '0';
    maxLooting.step = '1';
    maxLooting.value = stored.maxLooting ?? 0;
    maxLooting.className = 'monster-number-input loot-limit-input';
    maxLooting.setAttribute('aria-label', `${monster.name} maximum looting count`);
    const unlimited = document.createElement('input');
    unlimited.type = 'checkbox';
    unlimited.className = 'tree-checkbox loot-unlimited';
    unlimited.checked = stored.unlimited === true;
    unlimited.title = 'Allow looting without a count limit.';
    unlimited.setAttribute('aria-label', `Unlimited looting for ${monster.name}`);
    const updateLootLimitState = () => {
      maxLooting.disabled = unlimited.checked;
      maxLooting.classList.toggle('module-setting-disabled', unlimited.checked);
    };
    updateLootLimitState();
    const progress = document.createElement('div');
    progress.className = 'monster-progress';
    const progressText = document.createElement('span');
    progressText.textContent = `${stored.lootedCount || 0}/${stored.unlimited === true ? '∞' : (stored.maxLooting || 0)}`;
    const resetProgress = document.createElement('button');
    resetProgress.type = 'button';
    resetProgress.className = 'monster-progress-reset';
    resetProgress.textContent = '↺';
    resetProgress.title = `Reset looted count for ${monster.name}`;
    resetProgress.addEventListener('click', async () => {
      const result = await updateCanonicalConfig({
        looting: { maps: { [area.key]: { [monster.key]: { lootedCount: 0, lootedInstanceIds: [] } } } },
      });
      if (result?.success) {
        lootingConfig = result.config?.looting || lootingConfig;
        progressText.textContent = `0/${unlimited.checked ? '∞' : (maxLooting.value || 0)}`;
      } else {
        appendLog('ERROR', result?.error || `Could not reset ${monster.name} loot progress`);
      }
    });
    progress.append(progressText, resetProgress);
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'tree-checkbox loot-enabled';
    enabled.checked = stored.enabled === true;
    enabled.setAttribute('aria-label', `Enable looting ${monster.name}`);
    const controls = { priority, maxLooting, unlimited, enabled };
    Object.values(controls).forEach(control => {
      control.addEventListener('change', () => saveLootRow(area.key, monster.key, monster.name, controls));
    });
    unlimited.addEventListener('change', () => {
      updateLootLimitState();
      progressText.textContent = `${stored.lootedCount || 0}/${unlimited.checked ? '∞' : (maxLooting.value || 0)}`;
    });
    maxLooting.addEventListener('change', () => {
      progressText.textContent = `${stored.lootedCount || 0}/${unlimited.checked ? '∞' : (maxLooting.value || 0)}`;
    });
    row.append(name, lootable, priority, maxLooting, unlimited, progress, enabled);
    enhanceNumberInputs(row);
    table.appendChild(row);
  }
  lootAreaContent.replaceChildren(table);
}

async function selectLootArea(areaKey, force = false) {
  const area = monsterCatalog.find(candidate => candidate.key === areaKey);
  if (!area || !lootAreaContent) return;
  if (force) {
    const latestConfig = await window.botAPI.getConfig();
    monsterConfig = latestConfig?.monsters || monsterConfig;
    lootingConfig = latestConfig?.looting || lootingConfig;
  }
  activeLootAreaKey = areaKey;
  if (lootAreaSelect) lootAreaSelect.value = areaKey;
  if (lootAreaTypeSelect) lootAreaTypeSelect.value = areaWorkspaceType(area);

  if (!force && lootAreaCache.has(areaKey)) {
    const cached = lootAreaCache.get(areaKey);
    renderLootArea(area, cached.monsters, cached.sourceAvailable, cached.message);
    return;
  }

  lootAreaContent.innerHTML = '<div class="empty-state">Loading monster types…</div>';
  const result = await window.botAPI.listLootableMonstersForArea(areaKey);
  if (!result?.success) {
    renderLootArea(area, [], true, result?.error || 'Monster discovery failed.');
    return;
  }
  lootAreaCache.set(areaKey, result);
  renderLootArea(area, result.monsters || [], result.sourceAvailable !== false, result.message || '');
}

async function loadLootWorkspace(force = false) {
  const latestConfig = await window.botAPI.getConfig();
  monsterConfig = latestConfig?.monsters || monsterConfig;
  lootingConfig = latestConfig?.looting || lootingConfig;
  if (monsterCatalog.length === 0) monsterCatalog = await window.botAPI.getMonsterCatalog();
  const selectedArea = monsterCatalog.find(area => area.key === activeLootAreaKey);
  const selectedType = (selectedArea && areaWorkspaceType(selectedArea))
    || lootAreaTypeSelect?.value
    || 'gate';
  if (lootAreaTypeSelect) lootAreaTypeSelect.value = selectedType;
  activeLootAreaKey = populateLootAreaSelect(selectedType, activeLootAreaKey);
  if (activeLootAreaKey) await selectLootArea(activeLootAreaKey, force);
}

if (lootAreaSelect) lootAreaSelect.addEventListener('change', () => selectLootArea(lootAreaSelect.value));
if (lootAreaTypeSelect) {
  lootAreaTypeSelect.addEventListener('change', async () => {
    activeLootAreaKey = populateLootAreaSelect(lootAreaTypeSelect.value);
    if (activeLootAreaKey) await selectLootArea(activeLootAreaKey);
  });
}
if (btnRefreshLootArea) {
  btnRefreshLootArea.addEventListener('click', async () => {
    if (!activeLootAreaKey) return;
    btnRefreshLootArea.disabled = true;
    try {
      await selectLootArea(activeLootAreaKey, true);
    } finally {
      btnRefreshLootArea.disabled = false;
    }
  });
}

window.switchHomeSubTab = function (subtab) {
  const tabs = { general: subtabHomeGeneralBtn, bot: subtabHomeBotBtn };
  const views = { general: subviewHomeGeneral, equipment: subviewHomeEquipment, bot: subviewHomeBot };
  Object.entries(tabs).forEach(([name, button]) => button?.classList.toggle('active', name === subtab));
  Object.entries(views).forEach(([name, view]) => { if (view) view.style.display = name === subtab ? 'flex' : 'none'; });
  if (subtab === 'equipment') {
    renderCombatPlayerStats();
    refreshCombatData(false);
  }
};

document.querySelectorAll('[data-home-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchHomeSubTab(button.dataset.homeTab));
});

// Tab Switching
window.switchTab = function (tab) {
  currentTab = tab;
  tabHomeBtn.classList.toggle('active', tab === 'home');
  tabBotSetupBtn.classList.toggle('active', tab === 'botSetup');
  tabCombatBtn?.classList.toggle('active', tab === 'combat');
  tabEnergyFarmBtn.classList.toggle('active', tab === 'energyFarm');
  tabNPCConfigBtn.classList.toggle('active', tab === 'npcConfig');
  tabLootConfigBtn.classList.toggle('active', tab === 'lootConfig');
  if (tabConsoleBtn) tabConsoleBtn.classList.toggle('active', tab === 'console');

  const homeShellVisible = tab === 'home' || tab === 'botSetup' || tab === 'combat';
  viewHome.style.display = homeShellVisible ? 'flex' : 'none';
  viewEnergyFarm.style.display = tab === 'energyFarm' ? 'flex' : 'none';
  viewNPCConfig.style.display = tab === 'npcConfig' ? 'flex' : 'none';
  viewLootConfig.style.display = tab === 'lootConfig' ? 'flex' : 'none';
  if (viewConsole) viewConsole.style.display = tab === 'console' ? 'flex' : 'none';

  if (tab === 'console') {
    switchConsoleSubTab('live');
  }
  if (tab === 'energyFarm') {
    loadMangaList();
    loadFarmSettings();
  }
  if (tab === 'npcConfig') loadMonsterWorkspace();
  if (tab === 'lootConfig') loadLootWorkspace();
  if (homeStatsBar) homeStatsBar.style.display = tab === 'home' ? 'flex' : 'none';
  if (homeRuntimeStatus) homeRuntimeStatus.style.display = tab === 'home' ? 'flex' : 'none';
  if (overviewCurrentPanel) overviewCurrentPanel.style.display = tab === 'home' ? 'flex' : 'none';
  if (overviewInfoGrid) overviewInfoGrid.style.display = tab === 'home' ? 'grid' : 'none';
  if (overviewConsolePanel) overviewConsolePanel.style.display = tab === 'home' ? 'flex' : 'none';
  if (homeSetupTabs) homeSetupTabs.style.display = tab === 'botSetup' ? 'flex' : 'none';
  if (tab === 'botSetup') window.switchHomeSubTab('general');
  if (tab === 'combat') window.switchHomeSubTab('equipment');
  if (tab !== 'botSetup' && tab !== 'combat') {
    for (const view of [subviewHomeGeneral, subviewHomeEquipment, subviewHomeBot]) {
      if (view) view.style.display = 'none';
    }
  }
};

document.querySelectorAll('[data-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchTab(button.dataset.tab));
});

// Energy Farm Subtab Switching
window.switchEnergySubTab = function (subtab) {
  subtabStaminaGeneralBtn.classList.toggle('active', subtab === 'strategy');
  subtabChaptersBtn.classList.toggle('active', subtab === 'chapters');

  subviewStaminaGeneral.style.display = subtab === 'strategy' ? 'flex' : 'none';
  subviewChaptersFarm.style.display = subtab === 'chapters' ? 'flex' : 'none';
};

document.querySelectorAll('[data-energy-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchEnergySubTab(button.dataset.energyTab));
});

// Console Subtab Switching (Developer Mode)
window.switchConsoleSubTab = async function (subtab) {
  subtabConsoleLiveBtn.classList.toggle('active', subtab === 'live');
  subtabConsoleUserBtn.classList.toggle('active', subtab === 'user');
  subtabConsoleServerBtn.classList.toggle('active', subtab === 'server');

  subviewConsoleLive.style.display = subtab === 'live' ? 'flex' : 'none';
  subviewConsoleUser.style.display = subtab === 'user' ? 'flex' : 'none';
  subviewConsoleServer.style.display = subtab === 'server' ? 'flex' : 'none';

  if (subtab === 'user') {
    await refreshUserLogs();
  } else if (subtab === 'server') {
    await refreshServerLogs();
  }
};

document.querySelectorAll('[data-console-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchConsoleSubTab(button.dataset.consoleTab));
});

async function refreshUserLogs() {
  if (userLogsText) {
    userLogsText.textContent = 'Loading user logs...';
    try {
      const logs = await window.botAPI.getUserLogs();
      userLogsText.textContent = logs || 'No user logs found.';
      userLogsText.scrollTop = userLogsText.scrollHeight;
    } catch (e) {
      userLogsText.textContent = `Error loading user logs: ${e.message}`;
    }
  }
}

async function refreshServerLogs() {
  if (serverLogsText) {
    serverLogsText.textContent = 'Loading client logs...';
    try {
      const logs = (window.botAPI.getClientLogs ? await window.botAPI.getClientLogs() : await window.botAPI.getAutoLogs());
      serverLogsText.textContent = logs || 'No client logs found.';
      serverLogsText.scrollTop = serverLogsText.scrollHeight;
    } catch (e) {
      serverLogsText.textContent = `Error loading client logs: ${e.message}`;
    }
  }
}

if (btnClearLiveLogs) {
  btnClearLiveLogs.addEventListener('click', () => {
    if (logConsole) logConsole.innerHTML = '';
  });
}
if (btnRefreshUserLogs) {
  btnRefreshUserLogs.addEventListener('click', refreshUserLogs);
}
if (btnRefreshServerLogs) {
  btnRefreshServerLogs.addEventListener('click', refreshServerLogs);
}

// Gear Dropdown Toggle
gearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  gearDropdown.classList.toggle('show');
});

document.addEventListener('click', () => {
  gearDropdown.classList.remove('show');
});

gearDropdown.addEventListener('click', (e) => {
  e.stopPropagation();
});

// Live Application Stream Log Appender
function appendLog(level, message) {
  if (!logConsole) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-${level || 'INFO'}`;
  const serverDate = getServerDate();
  const time = serverDate.toLocaleTimeString();
  entry.textContent = `[${time}] [${level || 'INFO'}] ${message}`;
  logConsole.appendChild(entry);
  logConsole.scrollTop = logConsole.scrollHeight;
}

// Load Accounts List
function createAccountItem(account, includeLogin) {
  const item = document.createElement('div');
  item.className = 'account-item';
  const name = document.createElement('div');
  name.className = 'account-name';
  name.textContent = account.name;
  const actions = document.createElement('div');
  actions.className = 'account-actions';
  if (includeLogin) {
    const login = document.createElement('button');
    login.className = 'btn btn-primary btn-sm';
    login.textContent = 'Login';
    login.addEventListener('click', () => window.loginWith(account.name));
    actions.appendChild(login);
  }
  const remove = document.createElement('button');
  remove.className = 'btn btn-danger btn-sm';
  remove.textContent = 'Delete';
  remove.addEventListener('click', () => window.deleteAccount(account.name));
  actions.appendChild(remove);
  item.append(name, actions);
  return item;
}

async function refreshAccounts() {
  const accounts = await window.botAPI.listAccounts();

  if (savedAccountsList) {
    savedAccountsList.innerHTML = '';
    if (accounts.length === 0) {
      savedAccountsList.innerHTML = '<div class="empty-state">No saved accounts found. Click below to add one.</div>';
    } else {
      accounts.forEach(acc => savedAccountsList.appendChild(createAccountItem(acc, true)));
    }
  }

  if (modalAccountsList) {
    modalAccountsList.innerHTML = '';
    if (accounts.length === 0) {
      modalAccountsList.innerHTML = '<div class="empty-state">No saved accounts.</div>';
    } else {
      accounts.forEach(acc => modalAccountsList.appendChild(createAccountItem(acc, false)));
    }
  }
}

// Login with Account
window.loginWith = async function (accountName) {
  appendLog('INFO', `Logging in as ${accountName}...`);
  const res = await window.botAPI.loginWithAccount(accountName);
  if (res.success) {
    activeAccount = accountName;
    latestProgressionTelemetry = null;
    activeCombatLoadout = null;
    activeClassSkills = null;
    localStorage.setItem('activeAccount', accountName);
    if (footerUsername) footerUsername.textContent = accountName;

    // Switch to Logged-in View
    viewLogin.style.display = 'none';
    appContainer?.classList.add('is-authenticated');
    unauthTitle.style.display = 'block';
    tabContainer.style.display = 'flex';
    btnHeaderStartStop.style.display = 'flex';
    switchTab('home');

    menuViewBrowserBtn.disabled = false;
    menuPauseResumeBtn.disabled = false;
    menuLogoutBtn.disabled = false;

    appendLog('INFO', `Logged in successfully. Bot engine ready.`);
    if (res.warning) appendLog('WARN', res.warning);
    if (res.stats) renderPlayerStats(res.stats);
    const telemetry = await window.botAPI.getTelemetry();
    if (telemetry) {
      updateBotStatus(telemetry.state || 'STOPPED');
      latestProgressionTelemetry = telemetry.progression || null;
      renderProgressionStatus();
      renderOverviewTelemetry(telemetry);
    }
    await loadMangaList();
    await loadFarmSettings();

  } else {
    alert(`Failed to login: ${res.error}`);
    appendLog('ERROR', `Login failed: ${res.error}`);
  }
};

// Delete Account
window.deleteAccount = async function (accountName) {
  if (confirm(`Are you sure you want to delete ${accountName}?`)) {
    await window.botAPI.deleteAccount(accountName);
    if (activeAccount === accountName) {
      performLogout();
    }
    await refreshAccounts();
  }
};

// Logout
async function performLogout() {
  await window.botAPI.logout();
  activeAccount = null;
  latestProgressionTelemetry = null;
  activeCombatLoadout = null;
  activeClassSkills = null;
  localStorage.removeItem('activeAccount');
  if (footerUsername) footerUsername.textContent = '-';

  viewHome.style.display = 'none';
  viewEnergyFarm.style.display = 'none';
  viewNPCConfig.style.display = 'none';
  viewLootConfig.style.display = 'none';
  if (viewConsole) viewConsole.style.display = 'none';
  tabContainer.style.display = 'none';
  appContainer?.classList.remove('is-authenticated');
  btnHeaderStartStop.style.display = 'none';
  unauthTitle.style.display = 'block';
  viewLogin.style.display = 'flex';

  menuViewBrowserBtn.disabled = true;
  menuPauseResumeBtn.disabled = true;
  menuLogoutBtn.disabled = true;

  updateBotStatus('STOPPED');
  await refreshAccounts();
}

let currentBotState = 'STOPPED';

function updateBotStatus(state) {
  currentBotState = state;

  const runningStates = new Set([
    'IDLE', 'SCANNING_GATES', 'JOINING_BATTLE', 'ATTACKING', 'WAITING_LOOT',
    'LOOTING', 'HEALING', 'FARMING_ENERGY', 'CHALLENGE_WAIT',
  ]);
  const labels = {
    STOPPED: 'Stopped', IDLE: 'Idle', SCANNING_GATES: 'Scanning gates',
    JOINING_BATTLE: 'Joining battle', ATTACKING: 'Attacking', WAITING_LOOT: 'Waiting to loot',
    LOOTING: 'Looting', HEALING: 'Healing', FARMING_ENERGY: 'Farming energy',
    CHALLENGE_WAIT: 'Challenge waiting', PAUSED: 'Paused',
  };
  if (botStateText) botStateText.textContent = labels[state] || state;
  if (menuPauseResumeBtn) {
    menuPauseResumeBtn.textContent = state === 'PAUSED' ? 'Resume Bot' : 'Pause Bot';
    menuPauseResumeBtn.disabled = state === 'STOPPED';
  }

  if (runningStates.has(state)) {
    btnHeaderStartStop.innerHTML = '<i data-lucide="square"></i>';
    btnHeaderStartStop.classList.add('is-running');
  } else {
    btnHeaderStartStop.innerHTML = '<i data-lucide="play"></i>';
    btnHeaderStartStop.classList.remove('is-running');
  }
  lucide.createIcons();
}

btnHeaderStartStop.addEventListener('click', async () => {
  let result;
  if (currentBotState === 'STOPPED') {
    document.activeElement?.blur();
    await Promise.resolve();
    await flushPendingConfigSaves();
    result = await window.botAPI.start();
  } else if (currentBotState === 'PAUSED') {
    result = await window.botAPI.resume();
  } else {
    result = await window.botAPI.stop();
  }
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Bot lifecycle request failed');
  }
});

btnAddNewAccount.addEventListener('click', () => {
  window.botAPI.openAddAccountWindow();
});

menuAddAccountBtn.addEventListener('click', () => {
  window.botAPI.openAddAccountWindow();
});

menuViewBrowserBtn.addEventListener('click', () => {
  window.botAPI.openBrowserView();
});

menuPauseResumeBtn.addEventListener('click', async () => {
  const result = currentBotState === 'PAUSED' ? await window.botAPI.resume() : await window.botAPI.pause();
  if (!result?.success) appendLog('ERROR', result?.error || 'Pause/resume request failed');
});

menuSavedAccountsBtn.addEventListener('click', () => {
  modalSavedAccounts.style.display = 'flex';
  refreshAccounts();
});

btnCloseModal.addEventListener('click', () => {
  modalSavedAccounts.style.display = 'none';
});

menuLogoutBtn.addEventListener('click', () => {
  performLogout();
});

btnHeaderQuit.addEventListener('click', () => {
  if (confirm('Are you sure you want to quit?')) {
    window.botAPI.quitApp();
  }
});

btnSaveScheduler.addEventListener('click', async () => {
  const actionMinSeconds = Number(inputActionMinDelaySeconds.value);
  const actionMaxSeconds = Number(inputActionMaxDelaySeconds.value);
  if (![actionMinSeconds, actionMaxSeconds].every(Number.isFinite)
    || actionMinSeconds < 1.05 || actionMaxSeconds < actionMinSeconds) {
    appendLog('ERROR', 'Action delay requires at least 1.05 sec and the maximum must be at least the minimum.');
    return;
  }
  if (!chkDryRun.checked && !confirm('Enable live actions? The bot will send join, attack, heal, loot, and reaction requests to the game.')) {
    chkDryRun.checked = true;
    return;
  }
  const result = await updateCanonicalConfig({
    scheduler: {
      attackIntervals: {
        gate: { minDelay: Math.round(actionMinSeconds * 1000), maxDelay: Math.round(actionMaxSeconds * 1000) },
        dungeon: { minDelay: Math.round(actionMinSeconds * 1000), maxDelay: Math.round(actionMaxSeconds * 1000) },
      },
    },
    safety: { dryRun: Boolean(chkDryRun.checked) },
  });
  if (result?.success) {
    appendLog('INFO', `Action pacing updated: ${actionMinSeconds}-${actionMaxSeconds}s (${chkDryRun.checked ? 'dry run' : 'live mode'})`);
    alert('Bot pacing saved!');
  } else {
    appendLog('ERROR', result?.error || 'Could not save settings');
  }
});

// IPC Event Listeners
window.botAPI.onStateChange((data) => {
  if (data && data.state) {
    updateBotStatus(data.state);
  }
});

window.botAPI.onTelemetry((telemetry) => {
  if (!telemetry) return;
  latestProgressionTelemetry = telemetry.progression || null;
  renderProgressionStatus();
  if (telemetry.state) updateBotStatus(telemetry.state);
  renderOverviewTelemetry(telemetry);
});

function renderOverviewTelemetry(telemetry) {
  if (!telemetry) return;
  if (botActionText) botActionText.textContent = telemetry.currentAction || '-';
  if (botTargetText) botTargetText.textContent = telemetry.target?.name || '-';
  if (overviewTargetName) overviewTargetName.textContent = telemetry.target?.name || 'Nothing running';
  if (overviewActionReason) overviewActionReason.textContent = telemetry.currentReason || 'Waiting for the next decision.';
  const currentDamage = Number(telemetry.target?.userDmg || 0);
  const targetDamage = Number(telemetry.target?.targetDamage || 0);
  const progressPercent = targetDamage > 0 ? Math.min(100, Math.max(0, (currentDamage / targetDamage) * 100)) : 0;
  if (overviewProgressFill) overviewProgressFill.style.width = `${progressPercent}%`;
  if (overviewProgressText) {
    overviewProgressText.textContent = targetDamage > 0
      ? `${currentDamage.toLocaleString()} / ${targetDamage.toLocaleString()}`
      : '-';
  }
  if (overviewModuleName) overviewModuleName.textContent = telemetry.module?.displayName || telemetry.module?.label || 'Idle';
  if (overviewConnectionText) {
    overviewConnectionText.textContent = telemetry.connection?.connected
      ? 'Game session connected'
      : 'Game session unavailable';
  }
  const eligibleLootCount = Number(telemetry.progression?.eligibleLootCount) || 0;
  if (overviewProgressionState) {
    overviewProgressionState.textContent = telemetry.state === 'STOPPED' && eligibleLootCount > 0
      ? `${eligibleLootCount.toLocaleString()} eligible · press Start`
      : (telemetry.progression?.status || 'Monitoring');
  }
  if (overviewProgressionXp) {
    const eligibleXp = Number(telemetry.progression?.eligibleLootXp);
    overviewProgressionXp.textContent = `Eligible loot XP: ${Number.isFinite(eligibleXp) ? eligibleXp.toLocaleString() : '-'}`;
  }
  const runStats = telemetry.stats || {};
  if (overviewSessionKills) overviewSessionKills.textContent = (Number(runStats.monstersKilled) || 0).toLocaleString();
  if (overviewSessionLoot) overviewSessionLoot.textContent = (Number(runStats.lootCollected) || 0).toLocaleString();
  if (overviewSessionDamage) overviewSessionDamage.textContent = (Number(runStats.damageDealt) || 0).toLocaleString();
  if (overviewSessionStaminaPots) {
    const staminaPots = Object.values(runStats.staminaPotionsUsed || {}).reduce((total, value) => total + (Number(value) || 0), 0);
    overviewSessionStaminaPots.textContent = staminaPots.toLocaleString();
  }
  if (overviewSessionManaPots) {
    const manaPots = Object.values(runStats.manaPotionsUsed || {}).reduce((total, value) => total + (Number(value) || 0), 0);
    overviewSessionManaPots.textContent = manaPots.toLocaleString();
  }
  if (overviewSessionHealthPots) overviewSessionHealthPots.textContent = (Number(runStats.healthPotionsUsed) || 0).toLocaleString();
  if (overviewSessionErrors) overviewSessionErrors.textContent = (Number(runStats.errors) || 0).toLocaleString();
  renderOverviewPotionCounters(telemetry.potions);
  if (botModeText) {
    botModeText.textContent = telemetry.dryRun ? 'Dry run' : 'Live actions';
    botModeText.classList.toggle('live-mode', !telemetry.dryRun);
  }
}

function renderOverviewPotionCounters(potions) {
  if (!overviewPotionCounters) return;
  overviewPotionCounters.replaceChildren();
  if (potions?.recognized !== true) {
    const message = document.createElement('span');
    message.className = 'overview-card-detail';
    message.textContent = 'Read when a battle page is available.';
    overviewPotionCounters.appendChild(message);
    return;
  }
  const quantities = new Map();
  for (const item of potions.items || []) {
    if (!['stamina', 'health', 'mana'].includes(item.category)) continue;
    if (/\bxp\s*boost\b/i.test(String(item.name || ''))) continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    quantities.set(name, (quantities.get(name) || 0) + Math.max(0, Number(item.quantity) || 0));
  }
  if (quantities.size === 0) {
    const message = document.createElement('span');
    message.className = 'overview-card-detail';
    message.textContent = 'No supported potions are present in the battle inventory.';
    overviewPotionCounters.appendChild(message);
    return;
  }
  for (const [name, quantity] of [...quantities].sort(([left], [right]) => left.localeCompare(right))) {
    const counter = document.createElement('span');
    counter.className = 'overview-potion-counter';
    const label = document.createElement('span');
    label.textContent = `${name} `;
    const value = document.createElement('strong');
    value.textContent = quantity.toLocaleString();
    counter.append(label, value);
    overviewPotionCounters.appendChild(counter);
  }
}

window.botAPI.onLog((data) => {
  if (data) {
    appendLog(data.level, data.message);
  }
});

window.botAPI.onCaptchaAlert((data) => {
  if (data && data.active) {
    updateBotStatus('CHALLENGE_WAIT');
    appendLog('WARN', '⚠️ Cloudflare Captcha detected! Please solve it in the game window.');
  }
});

// Live Stats Subscriber & Color Logic for Stamina (+Next)
function renderPlayerStats(stats) {
  if (!stats) return;
  latestStats = stats;
  if (Number.isFinite(Number(stats.serverTzOff))) serverTzOffsetSeconds = Number(stats.serverTzOff);

  const currentStamina = (stats.stamina && stats.stamina.current) !== undefined ? stats.stamina.current : 0;
  const maxStamina = (stats.stamina && stats.stamina.max) || stats.totalStamina || 0;
  const nextInc = stats.nextStaminaIncrease || stats.hourlyRefill || 40;

  if (statStamina && (currentStamina > 0 || maxStamina > 0)) {
    statStamina.textContent = `${currentStamina} / ${maxStamina}`;
  }

  if (statStaminaNext && (currentStamina > 0 || maxStamina > 0)) {
    statStaminaNext.style.display = 'inline';
    statStaminaNext.textContent = `(+${nextInc})`;

    // If next stamina + current stamina > max stamina, display in red, else green
    if (currentStamina + nextInc > maxStamina) {
      statStaminaNext.style.color = '#ff5252';
    } else {
      statStaminaNext.style.color = '#4caf50';
    }
  }

  if (statHealth && stats.hp && (Number(stats.hp.current) >= 0 || Number(stats.hp.max) > 0)) {
    statHealth.textContent = `${stats.hp.current ?? '-'} / ${stats.hp.max ?? '-'}`;
  }
  if (statMana && stats.mp && (Number(stats.mp.current) >= 0 || Number(stats.mp.max) > 0)) {
    statMana.textContent = `${stats.mp.current ?? '-'} / ${stats.mp.max ?? '-'}`;
  }

  renderCombatPlayerStats(stats);
  if (statGold && stats.gold && stats.gold !== '0') statGold.textContent = stats.gold;
  if (statGems && stats.gems && stats.gems !== '0') statGems.textContent = stats.gems;
  if (statLevel && stats.level && stats.level > 0) statLevel.textContent = `Lv. ${stats.level} (${stats.expPercent || '0%'})`;
  renderProgressionStatus(stats);

  if (statEnergy && ((stats.farmedEnergy !== undefined && stats.farmedEnergy !== null) || stats.energy !== undefined)) {
    const energyVal = (stats.farmedEnergy !== undefined && stats.farmedEnergy !== null) ? stats.farmedEnergy : stats.energy;
    statEnergy.textContent = `${energyVal} / 1000`;
  }
}

window.botAPI.onStats((stats) => {
  renderPlayerStats(stats);
});

// Real-Time Log Streaming from Main Process
if (window.botAPI.onLogEntry) {
  window.botAPI.onLogEntry((entry) => {
    if (!entry) return;
    const { type, line, action } = entry;
    const logLine = line || action || '';

    if (type === 'client' || type === 'api') {
      if (serverLogsText) {
        if (serverLogsText.textContent.includes('Loading client logs') || serverLogsText.textContent.includes('No client logs found.')) {
          serverLogsText.textContent = logLine;
        } else {
          serverLogsText.textContent += '\n' + logLine;
        }
        serverLogsText.scrollTop = serverLogsText.scrollHeight;
      }
      appendLog('INFO', logLine.replace(/^\[.*?\]\s*/, ''));
    } else if (type === 'user') {
      if (userLogsText) {
        if (userLogsText.textContent.includes('Loading user logs') || userLogsText.textContent.includes('No user logs found.')) {
          userLogsText.textContent = logLine;
        } else {
          userLogsText.textContent += '\n' + logLine;
        }
        userLogsText.scrollTop = userLogsText.scrollHeight;
      }
      appendLog('USER', logLine.replace(/^\[.*?\]\s*/, ''));
    }
  });
}

// Home Tab Stats Refresh Button
if (btnRefreshStats) {
  btnRefreshStats.addEventListener('click', async () => {
    btnRefreshStats.disabled = true;
    btnRefreshStats.classList.add('spinning');
    appendLog('INFO', 'Refreshing player stats from server...');
    try {
      const res = await window.botAPI.refreshStats();
      if (res && res.success) {
        const statsData = res.stats || res.player;
        if (statsData) {
          renderPlayerStats(statsData);
        }
        appendLog('INFO', 'Player stats refreshed successfully.');
      } else {
        appendLog('WARN', `Stats refresh response: ${res?.error || 'No update'}`);
      }
    } catch (err) {
      appendLog('ERROR', `Failed to refresh stats: ${err.message}`);
    } finally {
      btnRefreshStats.classList.remove('spinning');
      btnRefreshStats.disabled = false;
      if (window.lucide) window.lucide.createIcons();
    }
  });
}

// Manga Manager UI Logic (Per-Account) - URLs hidden from view
function populateManualMangaOptions(list) {
  if (!selectManualManga) return;
  const previous = selectManualManga.value || workingMangaText?.textContent || '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select manga';
  const options = (list || []).map(manga => {
    const option = document.createElement('option');
    option.value = manga.slug;
    option.textContent = manga.title || manga.slug;
    return option;
  });
  selectManualManga.replaceChildren(placeholder, ...options);
  if (options.some(option => option.value === previous)) selectManualManga.value = previous;
  else if (options.length > 0) selectManualManga.value = options[0].value;
  if (workingMangaText && selectManualManga.value) workingMangaText.textContent = selectManualManga.value;
}

async function loadMangaList() {
  if (!mangaListTable) return;
  try {
    const list = await window.botAPI.getMangaList(activeAccount);
    populateManualMangaOptions(list);
    mangaListTable.innerHTML = '';
    if (!list || list.length === 0) {
      mangaListTable.innerHTML = '<div class="empty-state">No manga configured yet. Add one above.</div>';
      return;
    }

    list.forEach((manga) => {
      const item = document.createElement('div');
      item.className = 'manga-item-card';
      const info = document.createElement('div');
      info.className = 'manga-item-info';
      const title = document.createElement('div');
      title.className = 'manga-item-title';
      title.append(document.createTextNode(`${manga.title || manga.slug} `));
      const chapters = document.createElement('span');
      chapters.className = 'manga-item-chapters';
      chapters.textContent = `| ${manga.chapters || 0} chapters`;
      title.appendChild(chapters);
      info.appendChild(title);

      const actions = document.createElement('div');
      actions.className = 'manga-item-actions';
      const farmed = document.createElement('span');
      farmed.className = 'farmed-counter-badge';
      farmed.title = 'Chapters farmed by this account';
      farmed.textContent = `Farmed: ${manga.farmedCount || 0}`;
      const refresh = document.createElement('button');
      refresh.className = 'btn-refresh-manga';
      refresh.title = 'Refresh chapter count';
      refresh.textContent = '↻';
      refresh.addEventListener('click', () => window.refreshSingleManga(manga.slug));
      const farm = document.createElement('button');
      farm.className = 'btn-refresh-manga';
      farm.title = 'Farm the next chapter';
      farm.textContent = '▶';
      farm.addEventListener('click', () => window.farmSpecificManga(manga.slug));
      const remove = document.createElement('button');
      remove.className = 'btn-delete-x';
      remove.title = 'Remove for this account';
      remove.textContent = '✕';
      remove.addEventListener('click', () => window.deleteMangaTarget(manga.slug));
      actions.append(farmed, farm, refresh, remove);
      item.append(info, actions);
      mangaListTable.appendChild(item);
    });

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    mangaListTable.innerHTML = '';
    const errorState = document.createElement('div');
    errorState.className = 'empty-state';
    errorState.textContent = `Error loading manga: ${err.message}`;
    mangaListTable.appendChild(errorState);
  }
}

window.refreshSingleManga = async function (slug) {
  appendFarmTerminal('info', `Refreshing chapter count for "${slug}"...`);
  try {
    const res = await window.botAPI.refreshSingleManga(slug, activeAccount);
    if (res && res.success) {
      appendFarmTerminal('success', `Refreshed "${res.manga?.title || slug}" (${res.manga?.chapters || 0} chapters).`);
      await loadMangaList();
    } else {
      appendFarmTerminal('error', `Failed to refresh "${slug}": ${res?.error || 'Unknown error'}`);
    }
  } catch (err) {
    appendFarmTerminal('error', `Error refreshing "${slug}": ${err.message}`);
  } finally {
    if (window.lucide) window.lucide.createIcons();
  }
};

if (btnAddManga) {
  btnAddManga.addEventListener('click', async () => {
    const input = inputMangaTarget ? inputMangaTarget.value.trim() : '';
    if (!input) {
      alert('Please enter a manga name or URL.');
      return;
    }
    btnAddManga.disabled = true;
    appendFarmTerminal('info', `Verifying manga "${input}"...`);

    try {
      const res = await window.botAPI.addManga(input, activeAccount);
      if (res.success) {
        appendFarmTerminal('success', `Added "${res.manga.title}" (${res.manga.chapters} chapters).`);
        inputMangaTarget.value = '';
        await loadMangaList();
      } else {
        alert(res.error || 'Failed to add manga.');
        appendFarmTerminal('error', `Failed to add manga: ${res.error || 'Unknown error'}`);
      }
    } catch (err) {
      appendFarmTerminal('error', `Error: ${err.message}`);
    } finally {
      btnAddManga.disabled = false;
    }
  });

  if (inputMangaTarget) {
    inputMangaTarget.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnAddManga.click();
      }
    });
  }
}

window.deleteMangaTarget = async function (slug) {
  if (confirm(`Remove manga "${slug}" for this account?`)) {
    await window.botAPI.deleteManga(slug, activeAccount);
    appendFarmTerminal('info', `Removed "${slug}" from account manga list.`);
    await loadMangaList();
  }
};

window.farmSpecificManga = async function (slug) {
  if (!confirm(`Farm the next available chapter for "${slug}" now? This sends a reaction request.`)) return;
  appendFarmTerminal('info', `Posting a verified chapter reaction for ${slug}...`);
  if (workingMangaText) {
    workingMangaText.textContent = slug;
    saveCurrentFarmSettings();
  }

  try {
    const res = await window.botAPI.startEnergyFarm({ targetManga: slug });
    if (res && res.success) {
      appendFarmTerminal('success', `Farm successful for "${slug}"! ${res.message || ''}`);
    } else {
      appendFarmTerminal('warn', `Farm completed for "${slug}": ${res ? res.message : 'No response'}`);
    }
    if (res && res.energy !== undefined && statEnergy) {
      statEnergy.textContent = `${res.energy} / 1000`;
    }
    await loadMangaList();
  } catch (err) {
    appendFarmTerminal('error', `Farm error for "${slug}": ${err.message}`);
  }
};

if (btnStartManualFarm) {
  btnStartManualFarm.addEventListener('click', async () => {
    const targetManga = selectManualManga?.value || '';
    const chapterCount = Number(inputManualChapterCount?.value);
    if (!targetManga) {
      appendFarmTerminal('warn', 'Choose a manga before starting manual farming.');
      return;
    }
    if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 1000) {
      appendFarmTerminal('warn', 'Chapter count must be between 1 and 1000.');
      return;
    }
    const safety = shouldStopFarming();
    if (safety.stop) {
      appendFarmTerminal('warn', `Manual farm not started: ${safety.reason}`);
      return;
    }
    if (!confirm(`Farm ${chapterCount} chapter${chapterCount === 1 ? '' : 's'} from "${targetManga}"? This sends one reaction request per chapter.`)) return;

    btnStartManualFarm.disabled = true;
    if (workingMangaText) workingMangaText.textContent = targetManga;
    await saveCurrentFarmSettings();
    appendFarmTerminal('info', `Starting manual farm for ${chapterCount} chapter${chapterCount === 1 ? '' : 's'}...`);
    try {
      const result = await window.botAPI.startEnergyFarm({ targetManga, chapterCount });
      appendFarmTerminal(result?.success ? 'success' : 'warn', result?.message || 'Manual farm finished without a response.');
      if (result?.energy !== undefined && statEnergy) statEnergy.textContent = `${result.energy} / 1000`;
      await loadMangaList();
    } catch (error) {
      appendFarmTerminal('error', `Manual farm failed: ${error.message}`);
    } finally {
      btnStartManualFarm.disabled = false;
    }
  });
}

if (window.botAPI.onEnergyProgress) {
  window.botAPI.onEnergyProgress(progress => {
    if (!progress) return;
    if (progress.type === 'start') {
      appendFarmTerminal('info', `[${progress.current}/${progress.total}] Farming chapter ${progress.chapter}...`);
    } else if (progress.type === 'success') {
      appendFarmTerminal('success', `[${progress.current}/${progress.total}] Chapter ${progress.chapter} updated.`);
    } else if (progress.type === 'error') {
      appendFarmTerminal('error', `[${progress.current}/${progress.total}] Chapter ${progress.chapter}: ${progress.message || 'failed'}`);
    }
  });
}

// Check stopping criteria before farming
function shouldStopFarming() {
  const currentStamina = (latestStats && latestStats.stamina && latestStats.stamina.current) !== undefined ? latestStats.stamina.current : 0;
  const maxStamina = (latestStats && latestStats.stamina && latestStats.stamina.max) || (latestStats && latestStats.totalStamina) || 0;

  // 1. Safety: Stop if Max Stamina reached
  if (chkStopMaxStamina?.checked && maxStamina > 0 && currentStamina >= maxStamina) {
    return { stop: true, reason: `Max stamina reached (${currentStamina}/${maxStamina}).` };
  }

  // 2. Safety: Max Stamina Farm target threshold
  const maxFarmTarget = parseInt(inputMaxStaminaFarm?.value, 10);
  if (!isNaN(maxFarmTarget) && maxFarmTarget > 0 && currentStamina >= maxFarmTarget) {
    return { stop: true, reason: `Current stamina (${currentStamina}) reached the Max Stamina Farm threshold (${maxFarmTarget}).` };
  }

  // 3. Safety: Stop when hourly stamina is in [X] min
  const stopMinutes = parseInt(inputStopHourlyStaminaMin?.value, 10);
  if (!isNaN(stopMinutes) && stopMinutes > 0 && stopMinutes < 60) {
    const serverDate = getServerDate();
    const minutesLeftInHour = 59 - serverDate.getMinutes();
    if (minutesLeftInHour < stopMinutes) {
      return { stop: true, reason: `Next hourly stamina refill is in ${minutesLeftInHour}m (threshold is ${stopMinutes}m).` };
    }
  }

  return { stop: false };
}

window.botAPI.onAccountAdded(async (data) => {
  appendLog('INFO', `Account saved: ${data.name}`);
  await refreshAccounts();
  if (data.name) {
    await window.loginWith(data.name);
  }
});

// Initialize on Load
document.addEventListener('DOMContentLoaded', async () => {
  initDevMode();
  await refreshAccounts();
  await loadMangaList();

  const config = await window.botAPI.getConfig();
  if (config) {
    loadHomeConfiguration(config);
    loadSchedulerConfiguration(config);
  }
  updateFarmModuleUI();

  // Restore active account session on reload (e.g. Ctrl+R)
  const savedAccount = localStorage.getItem('activeAccount');
  if (savedAccount) {
    const accounts = await window.botAPI.listAccounts();
    if (accounts && accounts.some((a) => a.name === savedAccount)) {
      await window.loginWith(savedAccount);
    }
  }
});
