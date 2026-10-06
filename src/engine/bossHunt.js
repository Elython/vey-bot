const { getMonsterArea, monsterTypeKey } = require('./monsterCatalog');

function bossTargetKey(monster = {}) {
  const base = monsterTypeKey(monster.monsterKey || monster.key || monster.name);
  if (!base) return '';
  const phase = Math.max(0, Math.trunc(Number(monster.phase) || 0));
  return phase > 0 ? `${base}__phase_${phase}` : base;
}

function isVerifiedBossTarget(monster = {}) {
  return Number(monster.phase) > 0
    || (monster.boss === true && Boolean(monster.bossEvidence));
}

function configuredBossAreas(config = {}) {
  const targets = config.bossHunt?.targets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return [];
  return Object.entries(targets).flatMap(([areaKey, entries]) => {
    const area = getMonsterArea(areaKey);
    if (!area || !['gate', 'event'].includes(area.type)
      || !entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
    const enabled = Object.values(entries).some(entry => entry?.enabled === true
      && Number(entry.targetDamage) > 0
      && (entry.unlimited === true || Number(entry.completedCount) < Number(entry.killCount)));
    return enabled ? [{ ...area }] : [];
  });
}

module.exports = {
  bossTargetKey,
  configuredBossAreas,
  isVerifiedBossTarget,
};
