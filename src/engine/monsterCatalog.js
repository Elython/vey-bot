const MONSTER_AREAS = Object.freeze([
  { key: 'grakthar_1', label: 'Grakthar 1', type: 'gate', gateId: 3, wave: 3, supportsAutoFarm: false },
  { key: 'grakthar_2', label: 'Grakthar 2', type: 'gate', gateId: 3, wave: 5 },
  { key: 'grakthar_3', label: 'Grakthar 3', type: 'gate', gateId: 3, wave: 8 },
  { key: 'olympus_1', label: 'Olympus 1', type: 'gate', gateId: 5, wave: 9 },
  { key: 'olympus_hermes', label: 'Olympus Hermes', type: 'gate', gateId: 5, wave: 10 },
  { key: 'olympus_artemis', label: 'Olympus Artemis', type: 'gate', gateId: 5, wave: 11 },
  { key: 'olympus_poseidon', label: 'Olympus Poseidon', type: 'gate', gateId: 5, wave: 12 },
  { key: 'olympus_ares', label: 'Olympus Ares', type: 'gate', gateId: 5, wave: 13 },
  { key: 'olympus_apollo', label: 'Olympus Apollo', type: 'gate', gateId: 5, wave: 14 },
  { key: 'olympus_athena', label: 'Olympus Athena', type: 'gate', gateId: 5, wave: 15 },
  { key: 'olympus_hera', label: 'Olympus Hera', type: 'gate', gateId: 5, wave: 16 },
  { key: 'olympus_zeus', label: 'Olympus Zeus', type: 'gate', gateId: 5, wave: 17 },
  { key: 'event_black_crown_ascends', label: 'The Black Crown Ascends', type: 'event', eventId: 11, wave: 115 },
  { key: 'castle_fallen_prince', label: 'Castle of the Fallen Prince', type: 'dungeon' },
  { key: 'shadowbridge_warrens', label: 'Shadowbridge Warrens', type: 'dungeon' },
  { key: 'polyhedral_crucible', label: 'The Polyhedral Crucible', type: 'dungeon' },
]);

const MONSTER_AREA_KEYS = new Set(MONSTER_AREAS.map(area => area.key));
let customMonsterAreas = [];
let hiddenMonsterAreaKeys = new Set();

function configureMonsterAreas(areaCatalog = {}) {
  customMonsterAreas = (Array.isArray(areaCatalog.custom) ? areaCatalog.custom : [])
    .map(area => ({ ...area, custom: true }))
    .filter(area => area.key && area.label && ['gate', 'event'].includes(area.type));
  hiddenMonsterAreaKeys = new Set(Array.isArray(areaCatalog.hidden) ? areaCatalog.hidden.map(String) : []);
}

function listMonsterAreas(options = {}) {
  const includeHidden = options?.includeHidden === true;
  const areas = [...MONSTER_AREAS.map(area => ({ ...area, custom: false })), ...customMonsterAreas]
    .map(area => ({ ...area, hidden: hiddenMonsterAreaKeys.has(area.key) }));
  if (includeHidden) return areas;
  return areas.filter(area => !area.hidden).map(({ hidden, custom, ...area }) => area);
}

function getMonsterArea(key) {
  const area = [...MONSTER_AREAS, ...customMonsterAreas].find(candidate => candidate.key === key);
  if (!area) return null;
  const { custom, ...record } = area;
  return { ...record };
}

function supportsAutoFarm(areaOrKey) {
  const area = typeof areaOrKey === 'string' ? getMonsterArea(areaOrKey) : areaOrKey;
  return Boolean(area && ['gate', 'event'].includes(area.type) && area.supportsAutoFarm !== false);
}

function monsterTypeKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function selectGateMonster(monsters, configuredTypes, nowEpoch = Math.floor(Date.now() / 1000), options = {}) {
  const candidates = [];
  for (const monster of Array.isArray(monsters) ? monsters : []) {
    const key = monsterTypeKey(monster.name);
    const settings = configuredTypes?.[key];
    if (!settings?.enabled) continue;
    const concreteId = String(
      monster.id
      || monster.battleId
      || monster.dgmid
      || monster.battleRef?.dgmid
      || '',
    );
    if (concreteId && (settings.completedInstanceIds || []).map(String).includes(concreteId)) continue;
    if (!Number.isFinite(Number(monster.hp))) continue;
    if (monster.attackable === false) continue;
    if (settings.unlimited !== true && (settings.killCount || 0) <= (settings.completedCount || 0)) continue;
    if ((settings.targetDamage || 0) <= 0 || (monster.userDmg || 0) >= settings.targetDamage) continue;
    if ((monster.hp ?? 0) < (settings.minimumHp || 0)) continue;
    if (monster.dead || monster.hp === 0) continue;
    if (monster.expire && monster.expire <= nowEpoch) continue;
    if (monster.capNotReached === false) continue;
    candidates.push({ ...monster, monsterKey: key, targetSettings: { ...settings } });
  }

  candidates.sort((left, right) =>
    (left.targetSettings.priority || 0) - (right.targetSettings.priority || 0) ||
    left.name.localeCompare(right.name) ||
    (right.userDmg || 0) - (left.userDmg || 0) ||
    String(left.id || '').localeCompare(String(right.id || ''))
  );
  if (candidates.length === 0) return null;
  const firstPriority = Number(candidates[0].targetSettings.priority) || 0;
  const priorityGroup = candidates.filter(candidate => (Number(candidate.targetSettings.priority) || 0) === firstPriority);
  const orderedTypes = [...new Set(priorityGroup.map(candidate => candidate.monsterKey))];
  const previousType = String(options.afterMonsterKey || '');
  const previousIndex = orderedTypes.indexOf(previousType);
  const nextType = previousIndex >= 0
    ? orderedTypes[(previousIndex + 1) % orderedTypes.length]
    : orderedTypes[0];
  return priorityGroup.find(candidate => candidate.monsterKey === nextType) || priorityGroup[0] || null;
}

module.exports = {
  MONSTER_AREAS,
  MONSTER_AREA_KEYS,
  configureMonsterAreas,
  listMonsterAreas,
  getMonsterArea,
  supportsAutoFarm,
  monsterTypeKey,
  selectGateMonster,
};
