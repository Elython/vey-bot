/**
 * Darkbot-Style Minimal Renderer App
 */

let activeAccount = null;
let currentTab = 'home';
let latestStats = null;
let latestProgressionTelemetry = null;
let latestProgressionLootView = null;
let latestProgressionLootRevision = -1;
let currentFarmConfig = 'scheduler';
let monsterCatalog = [];
let activeMonsterAreaKey = null;
let activeLootAreaKey = null;
let monsterConfig = { maps: {} };
let lootingConfig = { maps: {} };
let autoFarmConfig = { maps: {}, settings: {} };
let adventureQuestConfig = { quests: {} };
let battlePassConfig = { enabled: false, areaKey: 'grakthar_3', lootIfAchievable: false, safeCheck: false, targets: {} };
let progressionProfilesConfig = { activeId: 'default', profiles: {} };
let latestAdventureQuestState = null;
let latestBattlePassState = null;
let autoFarmServerTargetDrafts = new Map();
const autoFarmTargetDrafts = new Map();
const autoFarmRenderedRows = new Map();
let areaCatalogConfig = { custom: [], hidden: [] };
const monsterAreaCache = new Map();
const lootAreaCache = new Map();
const lootDiscoveryCache = new Map();
let activeCombatLoadout = null;
let activeClassSkills = null;
let allowedCombatAbilityIds = new Set();
let combatAbilityPolicies = {};
let configuredNukeAttack = 'auto';
let progressionLootViewRefreshPromise = null;
let progressionLootSnapshotSyncPromise = null;
let progressionLootSessionGeneration = 0;
const pendingConfigSaves = new Set();
let pendingConfigRevision = 0;
let appliedConfigRevision = 0;
let configApplyInFlight = false;
let savedDryRun = true;
let runtimeDryRun = true;
let autoFarmEligibility = { known: false, eligible: false, level: null };
const activityHistoryRequestGeneration = { target: 0, loot: 0 };
let lootableRequestGeneration = 0;
let purgeCountdownTimer = null;
let autoFarmSettingsDirty = false;
let accountRendererGeneration = 0;

const MAX_LIVE_LOG_ENTRIES = 500;
const MAX_FARM_LOG_ENTRIES = 500;
const MAX_DEVELOPER_LOG_LINES = 2000;
const MAX_DEVELOPER_LOG_CHARS = 256 * 1024;

function createLucideIcon(name, className = '') {
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  icon.setAttribute('aria-hidden', 'true');
  if (className) icon.className = className;
  return icon;
}

function refreshLucideIcons(root = document) {
  if (!window.lucide?.createIcons) return;
  window.lucide.createIcons({ root });
}

function setButtonIcon(button, iconName, text = '') {
  if (!button) return;
  button.replaceChildren(createLucideIcon(iconName));
  if (text) button.append(document.createTextNode(` ${text}`));
  refreshLucideIcons(button);
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '0';
}

function setWorkspaceStatus(element, message = '', tone = '') {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('is-error', tone === 'error');
  element.classList.toggle('is-success', tone === 'success');
}

function setRefreshBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('is-loading', busy);
  button.setAttribute('aria-busy', String(busy));
}

function withUiTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} is still running. Try Refresh again in a moment.`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timeoutId));
}

function classifyLogMessage(message) {
  const value = String(message || '').toLowerCase();
  if (/auto[ -]?farm/.test(value)) return 'auto-farm';
  if (/chapter|manga|reaction|farmed energy/.test(value)) return 'chapter';
  if (/\bheal|health\b/.test(value)) return 'heal';
  if (/potion|use_item|consumable/.test(value)) return 'potion';
  if (/\bloot|claim|reward/.test(value)) return 'loot';
  if (/scan|discover|catalog|monster stats|refresh(?:ing|ed)? stats|parsed .*monster/.test(value)) return 'scan';
  if (/attack|damage|battle|\bjoin(?:ed|ing)?\b|target/.test(value)) return 'attack';
  return 'system';
}

function applyLiveLogFilter() {
  if (!logConsole) return;
  const selected = logCategoryFilter?.value || 'all';
  for (const entry of logConsole.children) {
    entry.classList.toggle('is-filtered', selected !== 'all' && entry.dataset.category !== selected);
  }
}

function boundedDeveloperLogText(value) {
  let text = String(value || '');
  if (text.length > MAX_DEVELOPER_LOG_CHARS) text = text.slice(-MAX_DEVELOPER_LOG_CHARS);
  const lines = text.split('\n');
  if (lines.length > MAX_DEVELOPER_LOG_LINES) text = lines.slice(-MAX_DEVELOPER_LOG_LINES).join('\n');
  return text;
}

function appendDeveloperLogLine(element, line) {
  if (!element) return;
  const placeholder = /^(Loading (?:client|user) logs|No (?:client|user) logs found\.)/.test(element.textContent);
  element.textContent = boundedDeveloperLogText(placeholder ? line : `${element.textContent}\n${line}`);
  element.scrollTop = element.scrollHeight;
}

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

function renderPendingConfigState() {
  if (!btnHeaderApplyConfig) return;
  const dirty = pendingConfigRevision !== appliedConfigRevision;
  btnHeaderApplyConfig.classList.toggle('has-pending-changes', dirty);
  btnHeaderApplyConfig.title = dirty
    ? 'Apply saved changes to the bot'
    : 'Configuration is applied';
}

function markConfigDirty() {
  pendingConfigRevision += 1;
  renderPendingConfigState();
}

function markConfigApplied(revision = pendingConfigRevision) {
  appliedConfigRevision = revision;
  renderPendingConfigState();
}

function updateCanonicalConfig(patch) {
  const save = window.botAPI.updateConfig(patch).then(result => {
    // Persistence may normalize a value before reporting `changed`, while the
    // active bot still owns its previous snapshot. Any successful user save
    // therefore needs an explicit Apply before runtime can be considered current.
    if (result?.success) markConfigDirty();
    return result;
  });
  return trackConfigSave(save);
}

function renderBotModeState() {
  if (!botModeText) return;
  const runtimeLabel = runtimeDryRun ? 'Dry run' : 'Live actions';
  const savedLabel = savedDryRun ? 'Dry run' : 'Live actions';
  const pending = runtimeDryRun !== savedDryRun;
  botModeText.textContent = pending ? `${runtimeLabel} · ${savedLabel} pending` : runtimeLabel;
  botModeText.title = pending
    ? `The bot is currently using ${runtimeLabel.toLowerCase()}. Press Apply or Start to use ${savedLabel.toLowerCase()}.`
    : `The bot is using ${runtimeLabel.toLowerCase()}.`;
  botModeText.classList.toggle('live-mode', !runtimeDryRun);
}

function updateAutoFarmEligibility(stats = null) {
  const level = Number(stats?.level);
  const known = Number.isFinite(level) && level > 0;
  const eligible = known && level >= 400;
  autoFarmEligibility = { known, eligible, level: known ? level : null };
  const message = !known
    ? 'Auto Farm availability is waiting for account Level stats.'
    : eligible
      ? 'Server Auto Farm is available.'
      : `Auto Farm requires Level 400 (current Level: ${level}).`;
  if (tabAutoFarmBtn) {
    tabAutoFarmBtn.disabled = !eligible;
    tabAutoFarmBtn.title = message;
  }
  const option = selectGeneralModule?.querySelector('option[value="auto_farm"]');
  if (option) option.disabled = !eligible;
  if (!eligible && currentTab === 'autoFarm') window.switchTab?.('home');
}

function resetAccountScopedRendererState() {
  accountRendererGeneration += 1;
  progressionLootSessionGeneration += 1;
  activityHistoryRequestGeneration.target += 1;
  activityHistoryRequestGeneration.loot += 1;
  lootableRequestGeneration += 1;
  statisticsRequestGeneration += 1;
  clearTimeout(saveProgressionSettings.refreshTimer);
  saveProgressionSettings.refreshTimer = null;
  clearTimeout(targetHistoryLiveTimer);
  clearTimeout(progressionHistoryLiveTimer);
  targetHistoryLiveTimer = null;
  progressionHistoryLiveTimer = null;
  latestStats = null;
  monsterCatalog = [];
  activeMonsterAreaKey = null;
  activeLootAreaKey = null;
  monsterConfig = { maps: {} };
  lootingConfig = { maps: {} };
  autoFarmConfig = { maps: {}, settings: {} };
  adventureQuestConfig = { quests: {} };
  battlePassConfig = { enabled: false, areaKey: 'grakthar_3', lootIfAchievable: false, safeCheck: false, targets: {} };
  progressionProfilesConfig = { activeId: 'default', profiles: {} };
  latestAdventureQuestState = null;
  latestBattlePassState = null;
  areaCatalogConfig = { custom: [], hidden: [] };
  monsterAreaCache.clear();
  lootAreaCache.clear();
  lootDiscoveryCache.clear();
  autoFarmServerTargetDrafts.clear();
  autoFarmTargetDrafts.clear();
  autoFarmRenderedRows.clear();
  allowedCombatAbilityIds = new Set();
  combatAbilityPolicies = {};
  activeCombatLoadout = null;
  activeClassSkills = null;
  cubePvpTargetOverview = null;
  cubePvpTargetConfig = {};
  latestCubePvpStatus = {};
  if (chkCubePvpEnabled) chkCubePvpEnabled.checked = false;
  renderCubePvpStatus?.(latestCubePvpStatus);
  if (autoFarmServerState) {
    autoFarmServerState.textContent = 'Unavailable';
    autoFarmServerState.classList.remove('is-running');
  }
  autoFarmProgressGrid?.replaceChildren();
  savedDryRun = true;
  runtimeDryRun = true;
  updateAutoFarmEligibility(null);
  renderBotModeState();
  for (const container of [monsterAreaContent, lootAreaContent, targetHistoryContent, lootHistoryContent,
    progressionHistoryContent, autoFarmTargetContent, autoFarmServerTargetsContent]) {
    container?.replaceChildren();
  }
  resetStatisticsView?.();
}

function accountRequestToken() {
  return { generation: accountRendererGeneration, account: activeAccount };
}

function isCurrentAccountRequest(token) {
  return token?.generation === accountRendererGeneration && token?.account === activeAccount;
}

async function hydrateAccountConfiguration() {
  const config = await window.botAPI.getConfig();
  if (!config) throw new Error('Account configuration could not be loaded');
  await refreshMonsterCatalog(false);
  loadHomeConfiguration(config);
  loadSchedulerConfiguration(config);
  runtimeDryRun = savedDryRun;
  renderBotModeState();
  return config;
}
