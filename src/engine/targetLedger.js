const { selectGateMonster } = require('./monsterCatalog');
const { deepMerge } = require('./configManager');
const { bossTargetKey, isVerifiedBossTarget } = require('./bossHunt');

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
    const configured = options.configuredTargets || this.config.monsters?.maps?.[areaKey] || {};
    const targetKeyResolver = options.targetKeyResolver;
    const preferredTargets = Array.isArray(options.preferredTargets)
      ? options.preferredTargets.filter(entry => entry?.monsterKey && entry.enabled !== false)
      : [];
    if (preferredTargets.length > 0) {
      const objectiveConfig = {};
      for (const entry of preferredTargets) {
        objectiveConfig[entry.monsterKey] = {
          name: entry.name || entry.monsterKey,
          enabled: true,
          unlimited: true,
          killCount: 1,
          completedCount: 0,
          targetDamage: Math.max(1, Number(entry.targetDamage) || 1),
          minimumHp: Math.max(0, Number(entry.minimumHp) || 0),
          priority: Math.max(0, Number(entry.priority) || 0),
        };
      }
      const lowestPriority = Math.min(...preferredTargets.map(entry => Math.max(0, Number(entry.priority) || 0)));
      const cursorKey = `${areaKey}:objective:${lowestPriority}`;
      const selected = selectGateMonster(monsters, objectiveConfig, nowEpoch, {
        afterMonsterKey: this.roundRobinCursor.get(cursorKey) || '',
        targetKeyResolver,
      });
      if (selected) this.roundRobinCursor.set(cursorKey, selected.monsterKey);
      return selected;
    }
    const preferredMonsterKey = String(options.preferredMonsterKey || '');
    if (preferredMonsterKey) {
      const base = configured[preferredMonsterKey] || {};
      if (!(Number(options.targetDamage) > 0)) {
        return selectGateMonster(monsters, { [preferredMonsterKey]: base }, nowEpoch, { targetKeyResolver });
      }
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
      }, nowEpoch, { targetKeyResolver });
    }
    const lowestPriority = Object.values(configured)
      .filter(settings => settings?.enabled === true
        && settings.targetDamage > 0
        && (settings.unlimited === true || Number(settings.dungeonKillCount) > 0 || settings.completedCount < settings.killCount))
      .reduce((lowest, settings) => Math.min(lowest, Number(settings.priority) || 0), Infinity);
    const cursorKey = `${areaKey}:${Number.isFinite(lowestPriority) ? lowestPriority : 0}`;
    return selectGateMonster(monsters, configured, nowEpoch, {
      afterMonsterKey: this.roundRobinCursor.get(cursorKey) || '',
      targetKeyResolver,
    });
  }

  selectBossTarget(areaSnapshots = [], nowEpoch) {
    const candidates = [];
    for (const snapshot of areaSnapshots) {
      const areaKey = String(snapshot?.areaKey || '');
      const configured = this.config.bossHunt?.targets?.[areaKey] || {};
      const verified = (Array.isArray(snapshot?.monsters) ? snapshot.monsters : [])
        .filter(isVerifiedBossTarget);
      const selected = this.selectTarget(areaKey, verified, nowEpoch, {
        configuredTargets: configured,
        targetKeyResolver: bossTargetKey,
      });
      if (selected) candidates.push({ ...selected, areaKey, policyNamespace: 'boss_hunt' });
    }
    candidates.sort((left, right) =>
      (Number(left.targetSettings?.priority) || 0) - (Number(right.targetSettings?.priority) || 0)
      || left.name.localeCompare(right.name)
      || left.areaKey.localeCompare(right.areaKey));
    if (candidates.length === 0) return null;
    const firstPriority = Number(candidates[0].targetSettings?.priority) || 0;
    const priorityGroup = candidates.filter(candidate => (Number(candidate.targetSettings?.priority) || 0) === firstPriority);
    const cursorKey = `boss_hunt:${firstPriority}`;
    const identities = priorityGroup.map(candidate => `${candidate.areaKey}:${candidate.monsterKey}`);
    const previousIndex = identities.indexOf(this.roundRobinCursor.get(cursorKey) || '');
    const selected = priorityGroup[previousIndex >= 0 ? (previousIndex + 1) % priorityGroup.length : 0];
    this.roundRobinCursor.set(cursorKey, `${selected.areaKey}:${selected.monsterKey}`);
    return selected;
  }

  getSettings(target) {
    if (!target?.areaKey || !target?.monsterKey) return null;
    if (target.policyNamespace === 'boss_hunt') {
      return this.config.bossHunt?.targets?.[target.areaKey]?.[target.configKey || target.monsterKey] || null;
    }
    return this.config.monsters?.maps?.[target.areaKey]?.[target.monsterKey] || null;
  }

  isAllowed(target, battle, general) {
    const settings = this.getSettings(target);
    const currentHp = battle?.monsterHp ?? target?.hp;
    const dungeonInstanceId = String(target?.instanceId || target?.battleRef?.instanceId || '');
    const perDungeonLimit = Math.max(0, Number(settings?.dungeonKillCount) || 0);
    const hasRemainingTarget = settings?.unlimited === true
      || (target?.isDungeon === true && dungeonInstanceId && perDungeonLimit > 0
        ? Number(settings?.completedByDungeon?.[dungeonInstanceId] || 0) < perDungeonLimit
        : Number(settings?.completedCount || 0) < Number(settings?.killCount || 0));
    if (target?.policyNamespace === 'boss_hunt') {
      return Boolean(
        general?.module === 'boss_hunt'
        && settings?.enabled
        && settings.targetDamage > 0
        && (settings.unlimited === true || settings.completedCount < settings.killCount)
        && Number.isFinite(Number(currentHp))
        && currentHp >= settings.minimumHp
      );
    }
    const selectedAreas = general?.module === 'event'
        ? new Set([general.eventMap || general.map].filter(Boolean))
        : new Set([general?.map].filter(Boolean));
    return Boolean(
      target &&
      ['gates', 'dungeons', 'event'].includes(general?.module) &&
      selectedAreas.has(target.areaKey) &&
      settings?.enabled &&
      settings.targetDamage > 0 &&
      hasRemainingTarget &&
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
    const completedCount = settings.unlimited === true || Number(settings.dungeonKillCount) > 0
      ? Math.min(1000000, (settings.completedCount || 0) + 1)
      : Math.min(settings.killCount, (settings.completedCount || 0) + 1);
    const cursorKey = `${target.areaKey}:${Number(settings.priority) || 0}`;
    const dungeonInstanceId = String(target.instanceId || target.battleRef?.instanceId || '');
    const completedByDungeon = { ...(settings.completedByDungeon || {}) };
    if (target.isDungeon === true && dungeonInstanceId) {
      completedByDungeon[dungeonInstanceId] = Math.min(1000000, (Number(completedByDungeon[dungeonInstanceId]) || 0) + 1);
    }
    this.roundRobinCursor.set(cursorKey, target.monsterKey);
    const configKey = target.configKey || target.monsterKey;
    const patch = target.policyNamespace === 'boss_hunt'
      ? { bossHunt: { targets: { [target.areaKey]: { [configKey]: { completedCount, completedInstanceIds } } } } }
      : { monsters: { maps: { [target.areaKey]: { [target.monsterKey]: { completedCount, completedInstanceIds, completedByDungeon: Object.fromEntries(Object.entries(completedByDungeon).slice(-100)) } } } } };
    if (this.configManager) this.configManager.update(patch);
    this.config = deepMerge(this.config, patch);
    return { config: this.config, completedCount, duplicate: false };
  }
}

module.exports = { TargetLedger };
