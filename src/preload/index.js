/**
 * Electron Preload Bridge
 * Exposes a secure API bridge between the Main process and Renderer UI
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('botAPI', {
  // Account & Session Management
  listAccounts: () => ipcRenderer.invoke('account:list'),
  deleteAccount: (accountName) => ipcRenderer.invoke('account:delete', accountName),
  purgeActiveAccount: () => ipcRenderer.invoke('account:purge-active'),
  openAddAccountWindow: () => ipcRenderer.invoke('account:add-window'),
  loginWithAccount: (accountName) => ipcRenderer.invoke('account:login', accountName),
  logout: () => ipcRenderer.invoke('bot:logout'),

  // Browser View & Application
  openBrowserView: () => ipcRenderer.invoke('game:open-browser'),
  openBattleInBrowser: (pageUrl) => ipcRenderer.invoke('game:open-battle', pageUrl),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // Bot Lifecycle Controls
  start: () => ipcRenderer.invoke('bot:start'),
  pause: () => ipcRenderer.invoke('bot:pause'),
  resume: () => ipcRenderer.invoke('bot:resume'),
  stop: () => ipcRenderer.invoke('bot:stop'),

  // Configuration
  updateConfig: (config) => ipcRenderer.invoke('bot:update-config', config),
  applyConfig: () => ipcRenderer.invoke('bot:apply-config'),
  getConfig: () => ipcRenderer.invoke('bot:get-config'),
  exportConfig: () => ipcRenderer.invoke('bot:export-config'),
  importConfig: () => ipcRenderer.invoke('bot:import-config'),
  exportAccountData: () => ipcRenderer.invoke('account:export-data'),
  restoreAccountData: () => ipcRenderer.invoke('account:restore-data'),
  getMonsterCatalog: (includeHidden = false) => ipcRenderer.invoke('monsters:get-catalog', includeHidden),
  getAutoFarmState: (force = false) => ipcRenderer.invoke('auto-farm:get-state', { force: force === true }),
  saveAutoFarmToServer: () => ipcRenderer.invoke('auto-farm:save'),
  addAutoFarmTargets: (areaKey) => ipcRenderer.invoke('auto-farm:add-targets', areaKey),
  removeAutoFarmTarget: (targetId) => ipcRenderer.invoke('auto-farm:remove-target', targetId),
  listMonstersForArea: (areaKey, force = false) => ipcRenderer.invoke('monsters:list-area', areaKey, force === true),
  listLootableMonstersForArea: (areaKey) => ipcRenderer.invoke('monsters:list-lootable-area', areaKey),
  getMonsterStats: (areaKey, monsterKey, refresh = false) => ipcRenderer.invoke('monsters:get-stats', areaKey, monsterKey, refresh),
  applyObservedMonsterStats: (areaKey, monsterKey) => ipcRenderer.invoke('monsters:apply-observed-stats', areaKey, monsterKey),
  collectMonsterStatsForArea: (areaKey) => ipcRenderer.invoke('monsters:collect-area-stats', areaKey),
  listBossHuntTargets: (force = false) => ipcRenderer.invoke('boss-hunt:list-targets', force === true),
  getActivityHistory: (kind, limit = 100) => ipcRenderer.invoke('history:list', kind, limit),
  clearActivityHistory: (kinds, before = null) => ipcRenderer.invoke('history:clear', { kinds, before }),
  getStatistics: (period = '7d') => ipcRenderer.invoke('statistics:get', { period }),
  getActiveLoadout: (options = {}) => ipcRenderer.invoke('loadouts:get-active', options),
  getSavedLoadoutSet: (options = {}) => ipcRenderer.invoke('loadouts:get-saved-set', options),
  getAttackStrategyStatus: (force = false) => ipcRenderer.invoke('combat:get-strategy-status', force),
  getClassSkills: () => ipcRenderer.invoke('combat:get-class-skills'),
  getCubePvpStatus: () => ipcRenderer.invoke('cube-pvp:get-status'),
  getCubePvpOverview: (force = false) => ipcRenderer.invoke('cube-pvp:get-overview', { force: force === true }),
  openCubePvpMatch: () => ipcRenderer.invoke('cube-pvp:open-match'),
  getCubePvpHistory: () => ipcRenderer.invoke('cube-pvp:get-history'),
  getAdventurerQuests: () => ipcRenderer.invoke('objectives:get-adventure-quests'),
  getBattlePass: () => ipcRenderer.invoke('objectives:get-battle-pass'),

  // Telemetry & Status
  getTelemetry: () => ipcRenderer.invoke('bot:get-telemetry'),
  refreshProgressionLoot: () => ipcRenderer.invoke('progression:refresh-loot'),
  updateProgressionSettings: (progression) => ipcRenderer.invoke('progression:update-settings', progression),
  createProgressionProfile: name => ipcRenderer.invoke('progression:create-profile', { name }),
  renameProgressionProfile: (profileId, name) => ipcRenderer.invoke('progression:rename-profile', { profileId, name }),
  deleteProgressionProfile: (profileId) => ipcRenderer.invoke('progression:delete-profile', profileId),
  selectProgressionProfile: (profileId) => ipcRenderer.invoke('progression:select-profile', profileId),
  updateCombatStrategy: (combat) => ipcRenderer.invoke('combat:update-strategy', combat),
  listAvailableProgressionLoot: () => ipcRenderer.invoke('progression:list-available-loot'),
  listLootDiscovery: (areaKey = null) => ipcRenderer.invoke('loot-discovery:list', areaKey),
  refreshLootDiscovery: (areaKey) => ipcRenderer.invoke('loot-discovery:refresh', areaKey),
  claimDiscoveredLoot: (areaKey, candidateKey) => ipcRenderer.invoke('loot-discovery:claim', areaKey, candidateKey),

  // Event Subscriptions
  onStateChange: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bot:state-change', handler);
    return () => ipcRenderer.removeListener('bot:state-change', handler);
  },
  onCubePvpStatus: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('cube-pvp:status', handler);
    return () => ipcRenderer.removeListener('cube-pvp:status', handler);
  },

  onTelemetry: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bot:telemetry', handler);
    return () => ipcRenderer.removeListener('bot:telemetry', handler);
  },

  onLog: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bot:log', handler);
    return () => ipcRenderer.removeListener('bot:log', handler);
  },

  onCaptchaAlert: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bot:captcha-alert', handler);
    return () => ipcRenderer.removeListener('bot:captcha-alert', handler);
  },

  onLootDiscovery: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('loot-discovery:update', handler);
    return () => ipcRenderer.removeListener('loot-discovery:update', handler);
  },

  onServerTime: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bot:server-time', handler);
    return () => ipcRenderer.removeListener('bot:server-time', handler);
  },

  onAccountAdded: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('account:added', handler);
    return () => ipcRenderer.removeListener('account:added', handler);
  },

  onStats: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bot:stats', handler);
    return () => ipcRenderer.removeListener('bot:stats', handler);
  },

  onEnergyProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('energy:progress', handler);
    return () => ipcRenderer.removeListener('energy:progress', handler);
  },

  refreshStats: () => ipcRenderer.invoke('bot:refresh-stats'),
  getFarmedEnergy: (accountName) => ipcRenderer.invoke('bot:get-farmed-energy', accountName),
  onLogEntry: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('log:entry', handler);
    return () => ipcRenderer.removeListener('log:entry', handler);
  },

  getUserLogs: () => ipcRenderer.invoke('logs:get-user'),
  getClientLogs: () => ipcRenderer.invoke('logs:get-client'),
  getAutoLogs: () => ipcRenderer.invoke('logs:get-auto'),
  startEnergyFarm: (options) => ipcRenderer.invoke('energy:start', options),
  farmSingleChapter: (options) => ipcRenderer.invoke('energy:farm-single-chapter', options),
  getMangaList: (accountName) => ipcRenderer.invoke('manga:list', accountName),
  addManga: (input, accountName) => ipcRenderer.invoke('manga:add', input, accountName),
  deleteManga: (slug, accountName) => ipcRenderer.invoke('manga:delete', slug, accountName),
  saveFarmSettings: (settings, accountName) => ipcRenderer.invoke('manga:farm-settings:save', settings, accountName),
  getFarmSettings: (accountName) => ipcRenderer.invoke('manga:farm-settings:get', accountName),
  reloadMangaList: (accountName) => ipcRenderer.invoke('manga:reload', accountName),
  refreshSingleManga: (slug, accountName) => ipcRenderer.invoke('manga:refresh-single', slug, accountName),
  getMangaLogs: () => ipcRenderer.invoke('manga:logs'),
});
