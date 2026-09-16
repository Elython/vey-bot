/**
 * Electron Preload Bridge
 * Exposes a secure API bridge between the Main process and Renderer UI
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('botAPI', {
  // Account & Session Management
  listAccounts: () => ipcRenderer.invoke('account:list'),
  deleteAccount: (accountName) => ipcRenderer.invoke('account:delete', accountName),
  openAddAccountWindow: () => ipcRenderer.invoke('account:add-window'),
  loginWithAccount: (accountName) => ipcRenderer.invoke('account:login', accountName),
  logout: () => ipcRenderer.invoke('bot:logout'),

  // Browser View & Application
  openBrowserView: () => ipcRenderer.invoke('game:open-browser'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // Bot Lifecycle Controls
  start: () => ipcRenderer.invoke('bot:start'),
  pause: () => ipcRenderer.invoke('bot:pause'),
  resume: () => ipcRenderer.invoke('bot:resume'),
  stop: () => ipcRenderer.invoke('bot:stop'),

  // Configuration
  updateConfig: (config) => ipcRenderer.invoke('bot:update-config', config),
  getConfig: () => ipcRenderer.invoke('bot:get-config'),
  exportConfig: () => ipcRenderer.invoke('bot:export-config'),
  importConfig: () => ipcRenderer.invoke('bot:import-config'),
  getMonsterCatalog: () => ipcRenderer.invoke('monsters:get-catalog'),
  listMonstersForArea: (areaKey) => ipcRenderer.invoke('monsters:list-area', areaKey),
  listLootableMonstersForArea: (areaKey) => ipcRenderer.invoke('monsters:list-lootable-area', areaKey),
  getMonsterStats: (areaKey, monsterKey, refresh = false) => ipcRenderer.invoke('monsters:get-stats', areaKey, monsterKey, refresh),
  collectMonsterStatsForArea: (areaKey) => ipcRenderer.invoke('monsters:collect-area-stats', areaKey),
  getActiveLoadout: (options = {}) => ipcRenderer.invoke('loadouts:get-active', options),
  getSavedLoadoutSet: (options = {}) => ipcRenderer.invoke('loadouts:get-saved-set', options),
  getAttackStrategyStatus: (force = false) => ipcRenderer.invoke('combat:get-strategy-status', force),
  getClassSkills: () => ipcRenderer.invoke('combat:get-class-skills'),

  // Telemetry & Status
  getTelemetry: () => ipcRenderer.invoke('bot:get-telemetry'),
  refreshProgressionLoot: () => ipcRenderer.invoke('progression:refresh-loot'),

  // Event Subscriptions
  onStateChange: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bot:state-change', handler);
    return () => ipcRenderer.removeListener('bot:state-change', handler);
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
