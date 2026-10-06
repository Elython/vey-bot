const { listMonsterAreas } = require('./monsterCatalog');

function hasEnabledEntry(entries) {
  return Boolean(entries && typeof entries === 'object' && !Array.isArray(entries)
    && Object.values(entries).some(entry => entry?.enabled === true));
}

function deriveDiscoveryDemand(config = {}, { areas = null } = {}) {
  const catalog = (Array.isArray(areas) ? areas : listMonsterAreas())
    .filter(area => area?.key && area.hidden !== true);
  const known = new Map(catalog.map(area => [area.key, area]));
  const reasons = new Map();
  const demand = (areaKey, reason) => {
    if (!known.has(areaKey)) return;
    if (!reasons.has(areaKey)) reasons.set(areaKey, new Set());
    reasons.get(areaKey).add(reason);
  };

  for (const [areaKey, entries] of Object.entries(config.looting?.maps || {})) {
    if (hasEnabledEntry(entries)) demand(areaKey, 'looting');
  }

  if (config.progression?.useLootForLeveling === true) {
    for (const groupName of ['dungeons', 'events', 'gates']) {
      const group = config.progression?.lootSources?.[groupName];
      if (group?.enabled !== true) continue;
      for (const areaKey of Array.isArray(group.areas) ? group.areas : []) {
        demand(areaKey, 'progression');
      }
    }
  }

  if (config.general?.module === 'battle_pass') {
    const areaKey = config.battlePass?.areaKey;
    const configuredTargets = config.battlePass?.targets?.[areaKey];
    if (hasEnabledEntry(configuredTargets)) demand(areaKey, 'battle_pass');
  }

  if (config.general?.module === 'adventure_quests') {
    for (const policy of Object.values(config.adventureQuests?.quests || {})) {
      if (policy?.enabled !== true || !['kill_loot', 'item_loot'].includes(policy.type)) continue;
      demand(policy.areaKey, 'adventure_quest');
    }
  }

  if (config.general?.module === 'boss_hunt') {
    for (const [areaKey, entries] of Object.entries(config.bossHunt?.targets || {})) {
      if (hasEnabledEntry(entries)) demand(areaKey, 'boss_hunt');
    }
  }

  return catalog
    .filter(area => reasons.has(area.key))
    .map(area => ({ ...area, demandReasons: [...reasons.get(area.key)].sort() }));
}

module.exports = {
  deriveDiscoveryDemand,
  hasEnabledEntry,
};
