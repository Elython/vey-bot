const { deepMerge, validateConfig } = require('./configManager');

class LootLimitLedger {
  constructor(config, configManager = null) {
    this.config = config;
    this.configManager = configManager;
  }

  updateConfig(config) {
    this.config = config;
  }

  getSettings(target) {
    if (!target?.areaKey || !target?.monsterKey) return null;
    return this.config.looting?.maps?.[target.areaKey]?.[target.monsterKey] || null;
  }

  isAllowed(target) {
    const settings = this.getSettings(target);
    return Boolean(settings?.enabled === true
      && (settings.unlimited === true || Number(settings.lootedCount) < Number(settings.maxLooting)));
  }

  recordLooted(target, logicalCount = 1) {
    const settings = this.getSettings(target);
    if (!settings) return null;
    const instanceId = String(target?.id || target?.battleId || target?.battleRef?.dgmid || target?.battleRef || '');
    if (instanceId && settings.lootedInstanceIds?.includes(instanceId)) {
      return { config: this.config, lootedCount: settings.lootedCount, duplicate: true };
    }
    const increment = Math.max(1, Math.trunc(Number(logicalCount) || 1));
    const lootedCount = settings.unlimited === true
      ? Math.min(1000000, (settings.lootedCount || 0) + increment)
      : Math.min(settings.maxLooting, (settings.lootedCount || 0) + increment);
    const lootedInstanceIds = instanceId
      ? [...(settings.lootedInstanceIds || []), instanceId].slice(-2000)
      : [...(settings.lootedInstanceIds || [])];
    const patch = {
      looting: { maps: { [target.areaKey]: { [target.monsterKey]: { lootedCount, lootedInstanceIds } } } },
    };
    this.config = this.configManager
      ? this.configManager.update(patch)
      : validateConfig(deepMerge(this.config, patch));
    return { config: this.config, lootedCount, duplicate: false };
  }
}

module.exports = { LootLimitLedger };
