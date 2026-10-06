// DOM Elements - Views & Navigation
const appContainer = document.querySelector('.app-container');
const viewLogin = document.getElementById('viewLogin');
const viewHome = document.getElementById('viewHome');
const viewAutoFarm = document.getElementById('viewAutoFarm');
const viewEnergyFarm = document.getElementById('viewEnergyFarm');
const viewNPCConfig = document.getElementById('viewNPCConfig');
const viewLootConfig = document.getElementById('viewLootConfig');
const viewStatistics = document.getElementById('viewStatistics');
const viewBattlePass = document.getElementById('viewBattlePass');
const viewAdventureQuests = document.getElementById('viewAdventureQuests');
const viewBossHunt = document.getElementById('viewBossHunt');
const viewConsole = document.getElementById('viewConsole');

const tabContainer = document.getElementById('tabContainer');
const unauthTitle = document.getElementById('unauthTitle');
const tabHomeBtn = document.getElementById('tabHomeBtn');
const tabBotSetupBtn = document.getElementById('tabBotSetupBtn');
const tabAutoFarmBtn = document.getElementById('tabAutoFarmBtn');
const tabCombatBtn = document.getElementById('tabCombatBtn');
const tabEnergyFarmBtn = document.getElementById('tabEnergyFarmBtn');
const tabNPCConfigBtn = document.getElementById('tabNPCConfigBtn');
const tabLootConfigBtn = document.getElementById('tabLootConfigBtn');
const tabStatisticsBtn = document.getElementById('tabStatisticsBtn');
const tabBattlePassBtn = document.getElementById('tabBattlePassBtn');
const tabAdventureQuestsBtn = document.getElementById('tabAdventureQuestsBtn');
const tabBossHuntBtn = document.getElementById('tabBossHuntBtn');
const tabConsoleBtn = document.getElementById('tabConsoleBtn');

// Home Subtabs
const subtabHomeGeneralBtn = document.getElementById('subtabHomeGeneralBtn');
const subtabHomeBotBtn = document.getElementById('subtabHomeBotBtn');
const subviewHomeGeneral = document.getElementById('subviewHomeGeneral');
const subviewHomeAutoFarm = document.getElementById('subviewHomeAutoFarm');
const subviewHomeEquipment = document.getElementById('subviewHomeEquipment');
const subviewHomeBot = document.getElementById('subviewHomeBot');
const selectGeneralModule = document.getElementById('selectGeneralModule');
const selectProgressionProfileSetup = document.getElementById('selectProgressionProfileSetup');
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
const btnExportAccountData = document.getElementById('btnExportAccountData');
const btnRestoreAccountData = document.getElementById('btnRestoreAccountData');
const chkProgressionLootLeveling = document.getElementById('chkProgressionLootLeveling');
const chkProgressionLootDungeons = document.getElementById('chkProgressionLootDungeons');
const chkProgressionLootEvents = document.getElementById('chkProgressionLootEvents');
const chkProgressionLootGates = document.getElementById('chkProgressionLootGates');
const chkProgressionChapterFallback = document.getElementById('chkProgressionChapterFallback');
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
const progressionCurrentState = document.getElementById('progressionCurrentState');
const progressionLootXp = document.getElementById('progressionLootXp');
const progressionLootScan = document.getElementById('progressionLootScan');
const progressionScanErrors = document.getElementById('progressionScanErrors');
const progressionScanErrorsSummary = document.getElementById('progressionScanErrorsSummary');
const progressionScanErrorsContent = document.getElementById('progressionScanErrorsContent');
const progressionXpNeeded = document.getElementById('progressionXpNeeded');
const progressionStaminaFlow = document.getElementById('progressionStaminaFlow');
const btnRefreshProgressionLoot = document.getElementById('btnRefreshProgressionLoot');
const selectProgressionProfile = document.getElementById('selectProgressionProfile');
const inputProgressionProfileName = document.getElementById('inputProgressionProfileName');
const btnCreateProgressionProfile = document.getElementById('btnCreateProgressionProfile');
const btnRenameProgressionProfile = document.getElementById('btnRenameProgressionProfile');
const btnDeleteProgressionProfile = document.getElementById('btnDeleteProgressionProfile');
const battlePassStatus = document.getElementById('battlePassStatus');
const battlePassCounters = document.getElementById('battlePassCounters');
const btnRefreshBattlePass = document.getElementById('btnRefreshBattlePass');
const chkBattlePassEnabled = document.getElementById('chkBattlePassEnabled');
const selectBattlePassArea = document.getElementById('selectBattlePassArea');
const chkBattlePassLootIfAchievable = document.getElementById('chkBattlePassLootIfAchievable');
const chkBattlePassSafeCheck = document.getElementById('chkBattlePassSafeCheck');
const subtabBattlePassGeneralBtn = document.getElementById('subtabBattlePassGeneralBtn');
const subtabBattlePassTargetsBtn = document.getElementById('subtabBattlePassTargetsBtn');
const subviewBattlePassGeneral = document.getElementById('subviewBattlePassGeneral');
const subviewBattlePassTargets = document.getElementById('subviewBattlePassTargets');
const battlePassTargetsContent = document.getElementById('battlePassTargetsContent');
const adventureQuestStatus = document.getElementById('adventureQuestStatus');
const adventureQuestList = document.getElementById('adventureQuestList');
const btnRefreshAdventureQuests = document.getElementById('btnRefreshAdventureQuests');
const bossHuntContent = document.getElementById('bossHuntContent');
const bossHuntStatus = document.getElementById('bossHuntStatus');
const btnRefreshBossHunt = document.getElementById('btnRefreshBossHunt');
// The old duplicate available-loot view was replaced by the shared Lootable
// workspace and persistent Progression history.
const btnRefreshAvailableLoot = null;
const progressionAvailableLootContent = null;
const progressionHistoryAreaTypeSelect = document.getElementById('progressionHistoryAreaTypeSelect');
const progressionHistoryAreaSelect = document.getElementById('progressionHistoryAreaSelect');
const progressionHistoryContent = document.getElementById('progressionHistoryContent');
const progressionHistoryConsole = document.getElementById('progressionHistoryConsole');
const btnRefreshProgressionHistory = document.getElementById('btnRefreshProgressionHistory');
const modalLootRewards = document.getElementById('modalLootRewards');
const lootRewardsTitle = document.getElementById('lootRewardsTitle');
const lootRewardsSummary = document.getElementById('lootRewardsSummary');
const lootRewardsContent = document.getElementById('lootRewardsContent');
const btnCloseLootRewards = document.getElementById('btnCloseLootRewards');
const subtabProgressionLootBtn = document.getElementById('subtabProgressionLootBtn');
const subviewProgressionLoot = document.getElementById('subviewProgressionLoot');
const inputAutoFarmTotal = document.getElementById('inputAutoFarmTotal');
const inputAutoFarmHpPots = document.getElementById('inputAutoFarmHpPots');
const inputAutoFarmSmallPots = document.getElementById('inputAutoFarmSmallPots');
const inputAutoFarmLargePots = document.getElementById('inputAutoFarmLargePots');
const inputAutoFarmFullPots = document.getElementById('inputAutoFarmFullPots');
const inputAutoFarmAdventurePots = document.getElementById('inputAutoFarmAdventurePots');
const selectAutoFarmPotionPriority = document.getElementById('selectAutoFarmPotionPriority');
const chkAutoFarmLootLevel = document.getElementById('chkAutoFarmLootLevel');
const inputAutoFarmExpLeft = document.getElementById('inputAutoFarmExpLeft');
const btnSaveAutoFarm = document.getElementById('btnSaveAutoFarm');
const btnRefreshAutoFarmServer = document.getElementById('btnRefreshAutoFarmServer');
const autoFarmServerState = document.getElementById('autoFarmServerState');
const autoFarmProgressGrid = document.getElementById('autoFarmProgressGrid');
const autoFarmServerTargetsContent = document.getElementById('autoFarmServerTargetsContent');
const btnModuleInfo = document.getElementById('btnModuleInfo');
const modalModuleInfo = document.getElementById('modalModuleInfo');
const moduleInfoTitle = document.getElementById('moduleInfoTitle');
const moduleInfoBody = document.getElementById('moduleInfoBody');
const btnCloseModuleInfo = document.getElementById('btnCloseModuleInfo');
const btnBotSetupPageInfo = document.getElementById('btnBotSetupPageInfo');
const btnCombatPageInfo = document.getElementById('btnCombatPageInfo');
const btnProgressionPageInfo = document.getElementById('btnProgressionPageInfo');
const inputKeepStaminaMin = document.getElementById('inputKeepStaminaMin');
const inputKeepStaminaMax = document.getElementById('inputKeepStaminaMax');
const inputStopStaminaBelow = document.getElementById('inputStopStaminaBelow');
const chkAllowStaminaPots = document.getElementById('chkAllowStaminaPots');
const selectStaminaPotionPriority = document.getElementById('selectStaminaPotionPriority');
const staminaPotionRows = ['rowProgressionDrainBeforePots', 'rowStaminaPotionPriority', 'rowSmallStaminaPotLimit', 'rowLargeStaminaPotLimit', 'rowFullStaminaPotLimit', 'rowAdventureStaminaPotLimit'].map(id => document.getElementById(id));
const inputSmallStaminaPotLimit = document.getElementById('inputSmallStaminaPotLimit');
const inputLargeStaminaPotLimit = document.getElementById('inputLargeStaminaPotLimit');
const inputFullStaminaPotLimit = document.getElementById('inputFullStaminaPotLimit');
const inputAdventureStaminaPotLimit = document.getElementById('inputAdventureStaminaPotLimit');
const progressionStaminaPotionCounters = Object.freeze({
  small: {
    used: document.getElementById('smallStaminaPotsUsed'),
    available: document.getElementById('smallStaminaPotsAvailable'),
  },
  large: {
    used: document.getElementById('largeStaminaPotsUsed'),
    available: document.getElementById('largeStaminaPotsAvailable'),
  },
  full: {
    used: document.getElementById('fullStaminaPotsUsed'),
    available: document.getElementById('fullStaminaPotsAvailable'),
  },
  adventure: {
    used: document.getElementById('adventureStaminaPotsUsed'),
    available: document.getElementById('adventureStaminaPotsAvailable'),
  },
});
const inputSleepHealthBelow = document.getElementById('inputSleepHealthBelow');
const inputMaxDeaths = document.getElementById('inputMaxDeaths');
const healthDeathsUsed = document.getElementById('healthDeathsUsed');
const chkUseHealingPotions = document.getElementById('chkUseHealingPotions');
const inputMaxHealingPotions = document.getElementById('inputMaxHealingPotions');
const rowHealingPotionLimit = document.getElementById('rowHealingPotionLimit');
const healthPotsUsed = document.getElementById('healthPotsUsed');
const healthPotsAvailable = document.getElementById('healthPotsAvailable');
const chkBuyHealthPotion = document.getElementById('chkBuyHealthPotion');
const inputMaxHealthPotionPurchases = document.getElementById('inputMaxHealthPotionPurchases');
const healthPotsPurchasedCount = document.getElementById('healthPotsPurchasedCount');
const btnResetHealthPurchases = document.getElementById('btnResetHealthPurchases');
const chkAllowManaPotions = document.getElementById('chkAllowManaPotions');
const selectManaPotionPriority = document.getElementById('selectManaPotionPriority');
const inputSmallManaPotLimit = document.getElementById('inputSmallManaPotLimit');
const inputLargeManaPotLimit = document.getElementById('inputLargeManaPotLimit');
const smallManaPotsUsed = document.getElementById('smallManaPotsUsed');
const smallManaPotsAvailable = document.getElementById('smallManaPotsAvailable');
const largeManaPotsUsed = document.getElementById('largeManaPotsUsed');
const largeManaPotsAvailable = document.getElementById('largeManaPotsAvailable');
const inputKeepManaMin = document.getElementById('inputKeepManaMin');
const inputKeepManaMax = document.getElementById('inputKeepManaMax');
const chkBuyManaPotion = document.getElementById('chkBuyManaPotion');
const inputMaxManaPotionPurchases = document.getElementById('inputMaxManaPotionPurchases');
const manaPotsPurchasedCount = document.getElementById('manaPotsPurchasedCount');
const btnResetManaPurchases = document.getElementById('btnResetManaPurchases');
const homeStatsBar = document.getElementById('homeStatsBar');
const homeRuntimeStatus = document.getElementById('homeRuntimeStatus');
const overviewCurrentPanel = document.getElementById('overviewCurrentPanel');
const homeSetupTabs = document.getElementById('homeSetupTabs');
const overviewTargetName = document.getElementById('overviewTargetName');
const overviewRuntimeBadge = document.getElementById('overviewRuntimeBadge');
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
const overviewCubePvpPanel = document.getElementById('overviewCubePvpPanel');
const overviewMonsterPhasePvpPanel = document.getElementById('overviewMonsterPhasePvpPanel');
const monsterPhasePvpLiveBadge = document.getElementById('monsterPhasePvpLiveBadge');
const monsterPhasePvpStatus = document.getElementById('monsterPhasePvpStatus');
const monsterPhasePvpOpponent = document.getElementById('monsterPhasePvpOpponent');
const monsterPhasePvpActiveId = document.getElementById('monsterPhasePvpActiveId');
const monsterPhasePvpWatcher = document.getElementById('monsterPhasePvpWatcher');
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
const chkCubePvpEnabled = document.getElementById('chkCubePvpEnabled');
const selectCubePvpMode = document.getElementById('selectCubePvpMode');
const inputCubePvpRecheck = document.getElementById('inputCubePvpRecheck');
const cubePvpStatus = document.getElementById('cubePvpStatus');
const cubePvpMatch = document.getElementById('cubePvpMatch');
const cubePvpSlot = document.getElementById('cubePvpSlot');
const cubePvpCooldown = document.getElementById('cubePvpCooldown');
const cubePvpWaitReason = document.getElementById('cubePvpWaitReason');
const cubePvpLastState = document.getElementById('cubePvpLastState');
const btnOpenCubePvpMatch = document.getElementById('btnOpenCubePvpMatch');
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
const btnTargetUnlimitedAll = document.getElementById('btnTargetUnlimitedAll');
const btnTargetEnableAll = document.getElementById('btnTargetEnableAll');
const cubePvpTargetPanel = document.getElementById('cubePvpTargetPanel');
const cubePvpTargetStatus = document.getElementById('cubePvpTargetStatus');
const cubePvpTargetContent = document.getElementById('cubePvpTargetContent');
const btnRefreshCubePvpTargets = document.getElementById('btnRefreshCubePvpTargets');
const lootAreaSelect = document.getElementById('lootAreaSelect');
const lootAreaTypeSelect = document.getElementById('lootAreaTypeSelect');
const lootAreaContent = document.getElementById('lootAreaContent');
const btnRefreshLootArea = document.getElementById('btnRefreshLootArea');
const btnLootUnlimitedAll = document.getElementById('btnLootUnlimitedAll');
const btnLootEnableAll = document.getElementById('btnLootEnableAll');
const subtabTargetsConfigBtn = document.getElementById('subtabTargetsConfigBtn');
const subtabTargetsHistoryBtn = document.getElementById('subtabTargetsHistoryBtn');
const subviewTargetsConfig = document.getElementById('subviewTargetsConfig');
const subviewTargetsHistory = document.getElementById('subviewTargetsHistory');
const subviewTargetsAutoFarm = document.getElementById('subviewTargetsAutoFarm');
const autoFarmTargetAreaTypeSelect = document.getElementById('autoFarmTargetAreaTypeSelect');
const autoFarmTargetAreaSelect = document.getElementById('autoFarmTargetAreaSelect');
const btnRefreshAutoFarmTargets = document.getElementById('btnRefreshAutoFarmTargets');
const btnSaveAutoFarmTargets = document.getElementById('btnSaveAutoFarmTargets');
const autoFarmTargetContent = document.getElementById('autoFarmTargetContent');
const autoFarmTargetStatus = document.getElementById('autoFarmTargetStatus');
const subtabAutoFarmGeneralBtn = document.getElementById('subtabAutoFarmGeneralBtn');
const subtabAutoFarmTargetsBtn = document.getElementById('subtabAutoFarmTargetsBtn');
const targetHistoryContent = document.getElementById('targetHistoryContent');
const targetHistoryConsole = document.getElementById('targetHistoryConsole');
const btnRefreshTargetHistory = document.getElementById('btnRefreshTargetHistory');
const targetHistoryStatus = document.getElementById('targetHistoryStatus');
const targetHistoryAreaTypeSelect = document.getElementById('targetHistoryAreaTypeSelect');
const targetHistoryAreaSelect = document.getElementById('targetHistoryAreaSelect');
const subtabLootingConfigBtn = document.getElementById('subtabLootingConfigBtn');
const subtabLootingHistoryBtn = document.getElementById('subtabLootingHistoryBtn');
const subviewLootingConfig = document.getElementById('subviewLootingConfig');
const subviewLootingHistory = document.getElementById('subviewLootingHistory');
const lootHistoryContent = document.getElementById('lootHistoryContent');
const btnRefreshLootHistory = document.getElementById('btnRefreshLootHistory');
const lootableHistoryStatus = document.getElementById('lootableHistoryStatus');
const lootableAreaTypeSelect = document.getElementById('lootableAreaTypeSelect');
const lootableAreaSelect = document.getElementById('lootableAreaSelect');
const menuGatesBtn = document.getElementById('menuGatesBtn');
const menuRefreshMonsterCatalogBtn = document.getElementById('menuRefreshMonsterCatalogBtn');
const modalGates = document.getElementById('modalGates');
const btnCloseGates = document.getElementById('btnCloseGates');
const selectNewAreaType = document.getElementById('selectNewAreaType');
const inputNewAreaName = document.getElementById('inputNewAreaName');
const inputNewAreaId = document.getElementById('inputNewAreaId');
const inputNewAreaWave = document.getElementById('inputNewAreaWave');
const btnAddGateArea = document.getElementById('btnAddGateArea');
const gatesManagerContent = document.getElementById('gatesManagerContent');
const menuClearHistoryBtn = document.getElementById('menuClearHistoryBtn');
const modalClearHistory = document.getElementById('modalClearHistory');
const btnCloseClearHistory = document.getElementById('btnCloseClearHistory');
const btnCancelClearHistory = document.getElementById('btnCancelClearHistory');
const btnConfirmClearHistory = document.getElementById('btnConfirmClearHistory');
const chkClearAttackHistory = document.getElementById('chkClearAttackHistory');
const chkClearLootHistory = document.getElementById('chkClearLootHistory');
const radioClearHistoryAll = document.getElementById('radioClearHistoryAll');
const radioClearHistoryBefore = document.getElementById('radioClearHistoryBefore');
const inputClearHistoryBefore = document.getElementById('inputClearHistoryBefore');
const clearHistoryStatus = document.getElementById('clearHistoryStatus');
const menuPurgeBtn = document.getElementById('menuPurgeBtn');
const modalPurge = document.getElementById('modalPurge');
const btnClosePurge = document.getElementById('btnClosePurge');
const btnCancelPurge = document.getElementById('btnCancelPurge');
const btnConfirmPurge = document.getElementById('btnConfirmPurge');
const purgeAccountName = document.getElementById('purgeAccountName');
const purgeStatus = document.getElementById('purgeStatus');
const progressionLootLevelingOptions = document.getElementById('progressionLootLevelingOptions');
const chkProgressionDrainBeforePots = document.getElementById('chkProgressionDrainBeforePots');

// The forms retain their stable IDs and save handlers, but belong to the
// dedicated Auto Farm workspace instead of Bot Setup or normal Targets.
if (viewAutoFarm) viewAutoFarm.append(subviewHomeAutoFarm, subviewTargetsAutoFarm);
const monsterStatsView = window.MonsterStatsView ? new window.MonsterStatsView(window.botAPI) : null;

// Developer Mode Checkbox
const chkDevMode = document.getElementById('chkDevMode');

// Log-file Subtabs
const subtabConsoleUserBtn = document.getElementById('subtabConsoleUserBtn');
const subtabConsoleServerBtn = document.getElementById('subtabConsoleServerBtn');
const subviewConsoleUser = document.getElementById('subviewConsoleUser');
const subviewConsoleServer = document.getElementById('subviewConsoleServer');
const logConsole = document.getElementById('logConsole');
const userLogsText = document.getElementById('userLogsText');
const serverLogsText = document.getElementById('serverLogsText');
const btnClearLiveLogs = document.getElementById('btnClearLiveLogs');
const logCategoryFilter = document.getElementById('logCategoryFilter');
const btnRefreshUserLogs = document.getElementById('btnRefreshUserLogs');
const btnRefreshServerLogs = document.getElementById('btnRefreshServerLogs');

// Account Statistics
const statisticsPeriod = document.getElementById('statisticsPeriod');
const btnRefreshStatistics = document.getElementById('btnRefreshStatistics');
const statisticsStatus = document.getElementById('statisticsStatus');
const statisticsAttacks = document.getElementById('statisticsAttacks');
const statisticsReached = document.getElementById('statisticsReached');
const statisticsStamina = document.getElementById('statisticsStamina');
const statisticsClaims = document.getElementById('statisticsClaims');
const statisticsXp = document.getElementById('statisticsXp');
const statisticsGold = document.getElementById('statisticsGold');
const statisticsItems = document.getElementById('statisticsItems');
const statisticsPvpJoined = document.getElementById('statisticsPvpJoined');
const statisticsPvpWins = document.getElementById('statisticsPvpWins');
const statisticsPvpLosses = document.getElementById('statisticsPvpLosses');
const statisticsPvpTable = document.getElementById('statisticsPvpTable');
const statisticsReachRate = document.getElementById('statisticsReachRate');
const statisticsAverageStamina = document.getElementById('statisticsAverageStamina');
const statisticsAverageXp = document.getElementById('statisticsAverageXp');
const statisticsAreasTable = document.getElementById('statisticsAreasTable');
const statisticsPotionsUsed = document.getElementById('statisticsPotionsUsed');
const statisticsChapters = document.getElementById('statisticsChapters');
const statisticsHeals = document.getElementById('statisticsHeals');
const statisticsPvpDuration = document.getElementById('statisticsPvpDuration');
const statisticsTrend = document.getElementById('statisticsTrend');
const statisticsCombatTable = document.getElementById('statisticsCombatTable');
const statisticsLootTable = document.getElementById('statisticsLootTable');
const statisticsResourcesTable = document.getElementById('statisticsResourcesTable');
const statisticsItemsTable = document.getElementById('statisticsItemsTable');

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
const btnChaptersPageInfo = document.getElementById('btnChaptersPageInfo');
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
const btnHeaderApplyConfig = document.getElementById('btnHeaderApplyConfig');
const menuViewBrowserBtn = document.getElementById('menuViewBrowserBtn');
const menuPauseResumeBtn = document.getElementById('menuPauseResumeBtn');
const menuAddAccountBtn = document.getElementById('menuAddAccountBtn');
const menuSavedAccountsBtn = document.getElementById('menuSavedAccountsBtn');
const menuLogoutBtn = document.getElementById('menuLogoutBtn');
const btnHeaderQuit = document.getElementById('btnHeaderQuit');

const savedAccountsList = document.getElementById('savedAccountsList');
const btnAddNewAccount = document.getElementById('btnAddNewAccount');

const inputGateMinDelaySeconds = document.getElementById('inputGateMinDelaySeconds');
const inputGateMaxDelaySeconds = document.getElementById('inputGateMaxDelaySeconds');
const inputDungeonMinDelaySeconds = document.getElementById('inputDungeonMinDelaySeconds');
const inputDungeonMaxDelaySeconds = document.getElementById('inputDungeonMaxDelaySeconds');
const inputLootScanIntervalMinutes = document.getElementById('inputLootScanIntervalMinutes');
const inputTargetScanIntervalSeconds = document.getElementById('inputTargetScanIntervalSeconds');
const chkDryRun = document.getElementById('chkDryRun');
const btnSaveScheduler = document.getElementById('btnSaveScheduler');

const modalSavedAccounts = document.getElementById('modalSavedAccounts');
const modalAccountsList = document.getElementById('modalAccountsList');
const btnCloseModal = document.getElementById('btnCloseModal');

// Footer Elements
const footerUsername = document.getElementById('footerUsername');
const footerServerTime = document.getElementById('footerServerTime');
const footerLocalTime = document.getElementById('footerLocalTime');

// Initialize the pinned local Lucide bundle.
refreshLucideIcons();

let serverTzOffsetSeconds = 19800;

// Helper: Calculate current server date using the offset reported by the game.
