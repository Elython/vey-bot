const { selectGateMonster } = require('./monsterCatalog');
const { deepMerge, validateConfig } = require('./configManager');

class TargetLedger {
  constructor(config, configManager = null) {
    this.config = config;
    this.configManager = configManager;
    this.roundRobinCursor = new Map();
  }

  updateConfig(config) {
    this.config = config;
  }

  selectGateTarget(areaKey, monsters, nowEpoch) {
    return this.selectTarget(areaKey, monsters, nowEpoch);
  }

  selectTarget(areaKey, monsters, nowEpoch, options = {}) {
    const configured = this.config.monsters?.maps?.[areaKey] || {};
    const preferredMonsterKey = String(options.preferredMonsterKey || '');
    if (preferredMonsterKey) {
      const base = configured[preferredMonsterKey] || {};
      return selectGateMonster(monsters, {
        [preferredMonsterKey]: {
          ...base,
          name: base.name || preferredMonsterKey,
          enabled: true,
          unlimited: true,
          killCount: 1,
          completedCount: 0,
          targetDamage: Math.max(1, Number(options.targetDamage) || Number(base.targetDamage) || 1),
          minimumHp: Math.max(0, Number(base.minimumHp) || 0),
        },
      }, nowEpoch);
    }
    const lowestPriority = Object.values(configured)
      .filter(settings => settings?.enabled === true
        && settings.targetDamage > 0
        && (settings.unlimited === true || settings.completedCount < settings.killCount))
      .reduce((lowest, settings) => Math.min(lowest, Number(settings.priority) || 0), Infinity);
    const cursorKey = `${areaKey}:${Number.isFinite(lowestPriority) ? lowestPriority : 0}`;
    return selectGateMonster(monsters, configured, nowEpoch, {
      afterMonsterKey: this.roundRobinCursor.get(cursorKey) || '',
    });
  }

  getSettings(target) {
    if (!target?.areaKey || !target?.monsterKey) return null;
    return this.config.monsters?.maps?.[target.areaKey]?.[target.monsterKey] || null;
  }

  isAllowed(target, battle, general) {
    const settings = this.getSettings(target);
    const currentHp = battle?.monsterHp ?? target?.hp;
    const selectedAreas = general?.module === 'gates_dungeons'
      ? new Set([general.dungeonMap, general.gateMap].filter(Boolean))
      : general?.module === 'event'
        ? new Set([general.eventMap || general.map].filter(Boolean))
        : new Set([general?.map].filter(Boolean));
    return Boolean(
      target &&
      ['gates', 'dungeons', 'gates_dungeons', 'event'].includes(general?.module) &&
      selectedAreas.has(target.areaKey) &&
      settings?.enabled &&
      settings.targetDamage > 0 &&
      (settings.unlimited === true || settings.completedCount < settings.killCount) &&
      Number.isFinite(Number(currentHp)) &&
      currentHp >= settings.minimumHp
    );
  }

  recordCompleted(target) {
    const settings = this.getSettings(target);
    if (!settings || !target?.id) return null;
    const instanceId = String(target.id);
    if (settings.completedInstanceIds?.includes(instanceId)) {
      return { config: this.config, completedCount: settings.completedCount, duplicate: true };
    }
    const completedInstanceIds = [...(settings.completedInstanceIds || []), instanceId].slice(-2000);
    const completedCount = settings.unlimited === true
      ? Math.min(1000000, (settings.completedCount || 0) + 1)
      : Math.min(settings.killCount, (settings.completedCount || 0) + 1);
    const cursorKey = `${target.areaKey}:${Number(settings.priority) || 0}`;
    this.roundRobinCursor.set(cursorKey, target.monsterKey);
    const patch = {
      monsters: { maps: { [target.areaKey]: { [target.monsterKey]: { completedCount, completedInstanceIds } } } },
    };
    this.config = this.configManager
      ? this.configManager.update(patch)
      : validateConfig(deepMerge(this.config, patch));
    return { config: this.config, completedCount, duplicate: false };
  }
}

module.exports = { TargetLedger };
