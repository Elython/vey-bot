const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MONSTER_AREAS, configureMonsterAreas, listMonsterAreas, getMonsterArea, supportsAutoFarm, monsterTypeKey } = require('./monsterCatalog');
const { CUBE_PVP_NODES } = require('./cubeCatalog');
const { getDataDir } = require('../main/dataPaths');

const DEFAULT_CONFIG = Object.freeze({
  general: {
    module: 'idle',
    map: null,
    primaryGateMap: 'grakthar_1',
    dungeonMap: 'shadowbridge_warrens',
    gateMap: 'grakthar_1',
    eventMap: 'event_black_crown_ascends',
  },
  areaCatalog: { custom: [], hidden: [] },
  gates: {
    targetGate: 3,
    targetWave: 'latest',
    targetPriority: 'joined_first',
  },
  combat: {
    preferredSkill: 'slash',
    allowAbilities: false,
    allowedAbilityIds: [],
    abilityPolicies: {},
    staminaReserve: 50,
    attackDelayMs: { min: 600, max: 1200 },
    attackStrategy: {
      mode: 'fixed',
      fixedMultiplier: 1,
      maxMultiplier: 200,
      overshootPercent: 10,
      failSafeEnabled: false,
      failSafePercent: 80,
      requireTargetStamina: false,
      nukeEnabled: false,
      nukeAttack: 'auto',
      nukeAllowAbilities: false,
    },
  },
  cubePvp: {
    enabled: false,
    mode: 'server_ai',
    recheckMinutes: 5,
    nodes: Object.fromEntries(CUBE_PVP_NODES.map(node => [String(node.id), { enabled: false, matches: {} }])),
  },
  adventureQuests: {
    quests: {},
    drafts: {},
  },
  battlePass: {
    enabled: false,
    areaKey: 'grakthar_3',
    lootIfAchievable: false,
    safeCheck: false,
    targets: {},
  },
  autoFarm: {
    areaKey: 'grakthar_2',
    settings: {
      totalMonsters: 0,
      hpPotionLimit: 0,
      staminaPotionLimits: { small: 0, large: 0, full: 0, adventure: 0 },
      priorityItemId: '0',
      autoLootToLevel: false,
      expLeftPercent: 100,
    },
    maps: {},
    targetPolicies: {},
  },
  healing: {
    mode: 'potion_first',
    hpThresholdPercent: 30,
  },
  looting: {
    module: 'none',
    autoLoot: true,
    lootDelay: { min: 300, max: 800 },
    maps: {},
  },
  equipment: {
    gear: {
      pve: 'default',
      pvpAttack: 'default',
      pvpDefense: 'default',
    },
    pets: {
      pve: 'default',
      pvpAttack: 'default',
      pvpDefense: 'default',
    },
  },
  monsters: {
    maps: {},
  },
  resources: {
    stamina: {
      keepMin: 0,
      keepMax: 0,
      stopBelow: 0,
      allowPotions: false,
      priority: 'small',
      potionLimits: { small: 0, large: 0, full: 0, adventure: 0 },
    },
    health: {
      sleepBelow: 0,
      maxDeaths: 0,
      usePotions: false,
      maxPotions: 0,
      buyPotionIfNeeded: false,
      maxPurchases: 0,
      purchasedCount: 0,
    },
    mana: {
      allowPotions: false,
      priority: 'small',
      potionLimits: { small: 0, large: 0 },
      keepMin: 0,
      keepMax: 200,
      buyPotionIfNeeded: false,
      maxPurchases: 0,
      purchasedCount: 0,
    },
  },
  progression: {
    enabled: true,
    useLootForLeveling: false,
    allowChapterFallback: false,
    drainBeforePots: true,
    lootSources: {
      gates: { enabled: false, areas: [] },
      events: { enabled: false, areas: [] },
      dungeons: { enabled: false, areas: [] },
    },
  },
  progressionProfiles: {
    activeId: 'default',
    profiles: {},
  },
  energyFarming: {
    enabled: false,
    farmWhenStaminaBelow: 100,
    reactionType: 'random',
    maxPerSession: 500,
  },
  scheduler: {
    minDelay: 600,
    maxDelay: 1200,
    minActionsPerSecond: 0.8,
    maxActionsPerSecond: 1.6,
    jitterRatio: 0.25,
    attackIntervals: {
      gate: { minDelay: 1050, maxDelay: 1200 },
      dungeon: { minDelay: 1000, maxDelay: 1200 },
    },
    lootScanIntervalMinutes: 1,
    targetScanIntervalSeconds: 1,
  },
  safety: {
    dryRun: true,
    maxConsecutiveErrors: 5,
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, patch) {
  const result = clone(base);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return result;

  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function progressionProfileStamina(stamina = {}) {
  return {
    allowPotions: stamina.allowPotions === true,
    priority: ['small', 'large', 'full', 'adventure'].includes(stamina.priority) ? stamina.priority : 'small',
    potionLimits: Object.fromEntries(['small', 'large', 'full', 'adventure'].map(type => [
      type,
      Math.trunc(clampNumber(stamina.potionLimits?.[type], 0, 0, 1000000)),
    ])),
  };
}

function normalizedProgressionProfileName(value, fallback = 'Progression profile') {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return normalized || fallback;
}

function validateConfig(input = {}) {
  const inputHealth = input?.resources?.health;
  const inputMana = input?.resources?.mana;
  const config = deepMerge(DEFAULT_CONFIG, input);
  const customAreas = [];
  const customKeys = new Set();
  for (const area of (Array.isArray(config.areaCatalog?.custom) ? config.areaCatalog.custom : []).slice(0, 100)) {
    if (!area || typeof area !== 'object' || Array.isArray(area)) continue;
    const key = typeof area.key === 'string' ? area.key.trim() : '';
    const label = typeof area.label === 'string' ? area.label.trim().slice(0, 100) : '';
    const type = area.type === 'event' ? 'event' : area.type === 'gate' ? 'gate' : null;
    const routeId = Math.trunc(clampNumber(type === 'event' ? area.eventId : area.gateId, 0, 1, 1000000));
    const wave = Math.trunc(clampNumber(area.wave, 0, 1, 1000000));
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key) || !label || !type || routeId < 1 || wave < 1 || customKeys.has(key)) continue;
    customKeys.add(key);
    customAreas.push({ key, label, type, ...(type === 'event' ? { eventId: routeId } : { gateId: routeId }), wave });
  }
  const knownAreaKeys = new Set([...MONSTER_AREAS.map(area => area.key), ...customAreas.map(area => area.key)]);
  config.areaCatalog = {
    custom: customAreas,
    hidden: [...new Set((Array.isArray(config.areaCatalog?.hidden) ? config.areaCatalog.hidden : [])
      .map(String)
      .filter(key => knownAreaKeys.has(key)))].slice(0, 200),
  };
  configureMonsterAreas(config.areaCatalog);
  const visibleAreas = listMonsterAreas();
  const visibleAreaKeys = new Set(visibleAreas.map(area => area.key));
  const progressionGateAreas = new Set(visibleAreas.filter(area => area.type === 'gate').map(area => area.key));
  const progressionEventAreas = new Set(visibleAreas.filter(area => area.type === 'event').map(area => area.key));
  const progressionDungeonAreas = new Set(visibleAreas.filter(area => area.type === 'dungeon').map(area => area.key));
  const autoFarmAreas = visibleAreas.filter(supportsAutoFarm);
  const autoFarmAreaKeys = new Set(autoFarmAreas.map(area => area.key));
  const quickSetSelections = new Set([
    'default',
    ...Array.from({ length: 10 }, (_, index) => `quick_set_${index + 1}`),
  ]);
  const staminaPotionSelections = new Set(['none', 'auto', 'small', 'large', 'full', 'adventure']);

  const generalModules = new Set([
    'gates', 'dungeons', 'event', 'auto_farm', 'pvp', 'battle_pass', 'adventure_quests', 'idle',
  ]);
  if (!config.general || typeof config.general !== 'object' || Array.isArray(config.general)) {
    config.general = clone(DEFAULT_CONFIG.general);
  }
  if (config.general?.module === 'gates_dungeons') config.general.module = 'dungeons';
  if (!generalModules.has(config.general?.module)) config.general.module = DEFAULT_CONFIG.general.module;
  const selectedArea = typeof config.general?.map === 'string' && visibleAreaKeys.has(config.general.map)
    ? config.general.map
    : null;
  const selectedAreaType = getMonsterArea(selectedArea)?.type;
  const isStandardGate = areaKey => {
    const area = getMonsterArea(areaKey);
    return visibleAreaKeys.has(areaKey) && area?.type === 'gate' && !area.eventId;
  };
  const isEventGate = areaKey => {
    const area = getMonsterArea(areaKey);
    return visibleAreaKeys.has(areaKey) && area?.type === 'event' && Number.isInteger(area.eventId);
  };
  const legacyGateMap = typeof input.general?.gateMap === 'string' && isStandardGate(input.general.gateMap)
    ? input.general.gateMap
    : null;
  const fallbackGateMap = isStandardGate(DEFAULT_CONFIG.general.primaryGateMap)
    ? DEFAULT_CONFIG.general.primaryGateMap : visibleAreas.find(area => area.type === 'gate')?.key || null;
  const fallbackDungeonMap = visibleAreaKeys.has(DEFAULT_CONFIG.general.dungeonMap)
    ? DEFAULT_CONFIG.general.dungeonMap : visibleAreas.find(area => area.type === 'dungeon')?.key || null;
  const fallbackEventMap = isEventGate(DEFAULT_CONFIG.general.eventMap)
    ? DEFAULT_CONFIG.general.eventMap : visibleAreas.find(area => area.type === 'event')?.key || null;
  const requestedPrimaryGateMap = typeof input.general?.primaryGateMap === 'string'
    && isStandardGate(input.general.primaryGateMap)
    ? input.general.primaryGateMap
    : (selectedAreaType === 'gate' && isStandardGate(selectedArea) ? selectedArea : legacyGateMap || fallbackGateMap);
  const requestedGateMap = legacyGateMap || requestedPrimaryGateMap;
  const requestedDungeonMap = typeof input.general?.dungeonMap === 'string' && visibleAreaKeys.has(input.general.dungeonMap) && getMonsterArea(input.general.dungeonMap)?.type === 'dungeon'
    ? input.general.dungeonMap
    : (selectedAreaType === 'dungeon' ? selectedArea : fallbackDungeonMap);
  const requestedEventMap = typeof input.general?.eventMap === 'string' && isEventGate(input.general.eventMap)
    ? input.general.eventMap
    : (isEventGate(selectedArea) ? selectedArea : fallbackEventMap);
  config.general.gateMap = requestedGateMap;
  config.general.primaryGateMap = requestedPrimaryGateMap;
  config.general.dungeonMap = requestedDungeonMap;
  config.general.eventMap = requestedEventMap;
  config.general.map = config.general.module === 'gates'
    ? requestedPrimaryGateMap
    : config.general.module === 'dungeons'
      ? requestedDungeonMap
      : config.general.module === 'event'
        ? requestedEventMap
        : null;

  config.gates.targetGate = Math.trunc(clampNumber(config.gates.targetGate, 3, 1, 100000));
  if (config.gates.targetWave !== 'latest') {
    config.gates.targetWave = Math.trunc(clampNumber(config.gates.targetWave, 1, 1, 100000));
  }
  if (!['joined_first', 'lowest_hp', 'highest_hp'].includes(config.gates.targetPriority)) {
    config.gates.targetPriority = DEFAULT_CONFIG.gates.targetPriority;
  }

  if (!['slash', 'power_slash', 'max_damage'].includes(config.combat.preferredSkill)) {
    config.combat.preferredSkill = DEFAULT_CONFIG.combat.preferredSkill;
  }
  // Migrate the short-lived selector to the explicit class-ability permission.
  if (['configured', 'adaptive'].includes(config.combat.abilityUsage)) {
    config.combat.allowAbilities = true;
  }
  config.combat.allowAbilities = config.combat.allowAbilities === true;
  delete config.combat.abilityUsage;
  config.combat.allowedAbilityIds = [...new Set(
    (Array.isArray(config.combat.allowedAbilityIds) ? config.combat.allowedAbilityIds : [])
      .map(value => Math.trunc(Number(value)))
      .filter(value => Number.isInteger(value) && value > 0)
  )].slice(0, 100);
  const abilityPolicies = config.combat.abilityPolicies && typeof config.combat.abilityPolicies === 'object'
    && !Array.isArray(config.combat.abilityPolicies) ? config.combat.abilityPolicies : {};
  config.combat.abilityPolicies = {};
  for (const [rawId, policy] of Object.entries(abilityPolicies).slice(0, 100)) {
    if (!/^\d{1,12}$/.test(rawId) || !policy || typeof policy !== 'object' || Array.isArray(policy)) continue;
    const role = ['attack', 'buff', 'debuff', 'passive'].includes(policy.role) ? policy.role : 'attack';
    config.combat.abilityPolicies[rawId] = {
      role,
      maxUses: Math.trunc(clampNumber(policy.maxUses, 0, 0, 1000000)),
      initialWaitTurns: Math.trunc(clampNumber(policy.initialWaitTurns, 0, 0, 1000)),
      reapplyTurns: Math.trunc(clampNumber(policy.reapplyTurns, role === 'buff' ? 1 : 3, 1, 1000)),
      minimumNextAttackStamina: Math.trunc(clampNumber(policy.minimumNextAttackStamina, 0, 0, 1000000)),
    };
  }
  config.combat.staminaReserve = Math.trunc(clampNumber(config.combat.staminaReserve, 50, 0, 1000000));

  if (!config.cubePvp || typeof config.cubePvp !== 'object' || Array.isArray(config.cubePvp)) {
    config.cubePvp = clone(DEFAULT_CONFIG.cubePvp);
  }
  config.cubePvp.enabled = config.cubePvp.enabled === true;
  config.cubePvp.mode = config.cubePvp.mode === 'server_ai' ? 'server_ai' : 'server_ai';
  config.cubePvp.recheckMinutes = Math.trunc(clampNumber(config.cubePvp.recheckMinutes, 5, 1, 60));
  const nodePolicies = config.cubePvp.nodes && typeof config.cubePvp.nodes === 'object' && !Array.isArray(config.cubePvp.nodes)
    ? config.cubePvp.nodes : {};
  config.cubePvp.nodes = {};
  for (const node of CUBE_PVP_NODES) {
    const policy = nodePolicies[String(node.id)] && typeof nodePolicies[String(node.id)] === 'object'
      ? nodePolicies[String(node.id)] : {};
    const matches = policy.matches && typeof policy.matches === 'object' && !Array.isArray(policy.matches)
      ? policy.matches : {};
    const normalizedMatches = {};
    for (let matchNo = 1; matchNo <= node.maximumMatches; matchNo += 1) {
      const match = matches[String(matchNo)];
      if (!match || typeof match !== 'object' || Array.isArray(match)) continue;
      normalizedMatches[String(matchNo)] = {
        enabled: match.enabled !== false,
        priority: Math.trunc(clampNumber(match.priority, 0, 0, 1000000)),
      };
    }
    config.cubePvp.nodes[String(node.id)] = {
      enabled: policy.enabled === true,
      matches: normalizedMatches,
    };
  }
  delete config.cubePvp.commitment;

  if (!config.adventureQuests || typeof config.adventureQuests !== 'object' || Array.isArray(config.adventureQuests)) {
    config.adventureQuests = clone(DEFAULT_CONFIG.adventureQuests);
  }
  const questPolicies = config.adventureQuests.quests && typeof config.adventureQuests.quests === 'object'
    && !Array.isArray(config.adventureQuests.quests) ? config.adventureQuests.quests : {};
  const questDrafts = config.adventureQuests.drafts && typeof config.adventureQuests.drafts === 'object'
    && !Array.isArray(config.adventureQuests.drafts) ? config.adventureQuests.drafts : {};
  const normalizeQuestPolicy = policy => {
    const areaKey = visibleAreaKeys.has(String(policy.areaKey || '')) ? String(policy.areaKey) : null;
    const type = ['kill_loot', 'item_loot', 'ability_use'].includes(policy.type) ? policy.type : 'kill_loot';
    const normalized = {
      enabled: policy.enabled === true,
      type,
      areaKey,
      monsterKey: String(policy.monsterKey || '').trim().slice(0, 160),
      targetDamage: Math.trunc(clampNumber(policy.targetDamage, 1, 1, Number.MAX_SAFE_INTEGER)),
      requiredCount: Math.trunc(clampNumber(policy.requiredCount, 1, 1, 1000000)),
      itemId: /^\d{1,30}$/.test(String(policy.itemId || '')) ? String(policy.itemId) : '',
      itemName: String(policy.itemName || '').trim().slice(0, 160),
      abilityId: Math.trunc(clampNumber(policy.abilityId, 0, 0, 1000000)),
      priority: Math.trunc(clampNumber(policy.priority, 0, 0, 1000000)),
    };
    const matchTitle = String(policy.matchTitle || '').trim().slice(0, 200);
    if (matchTitle) {
      normalized.matchTitle = matchTitle;
      normalized.matchObjective = String(policy.matchObjective || '').trim().slice(0, 500);
    }
    return normalized;
  };
  config.adventureQuests.quests = {};
  for (const [rawId, policy] of Object.entries(questPolicies).slice(0, 200)) {
    if (!/^\d{1,12}$/.test(rawId) || !policy || typeof policy !== 'object' || Array.isArray(policy)) continue;
    config.adventureQuests.quests[rawId] = normalizeQuestPolicy(policy);
  }
  config.adventureQuests.drafts = {};
  for (const [draftKey, policy] of Object.entries(questDrafts).slice(0, 200)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(draftKey) || !policy || typeof policy !== 'object' || Array.isArray(policy)) continue;
    const matchTitle = String(policy.matchTitle || '').trim().slice(0, 200);
    if (!matchTitle) continue;
    config.adventureQuests.drafts[draftKey] = {
      ...normalizeQuestPolicy(policy),
      matchTitle,
      matchObjective: String(policy.matchObjective || '').trim().slice(0, 500),
    };
  }

  if (!config.battlePass || typeof config.battlePass !== 'object' || Array.isArray(config.battlePass)) {
    config.battlePass = clone(DEFAULT_CONFIG.battlePass);
  }
  const battlePassArea = getMonsterArea(config.battlePass.areaKey);
  const supportedBattlePassAreas = new Set(['grakthar_2', 'grakthar_3']);
  const selectedBattlePassArea = battlePassArea?.type === 'gate' && supportedBattlePassAreas.has(battlePassArea.key)
    ? battlePassArea.key : DEFAULT_CONFIG.battlePass.areaKey;
  const configuredBattlePassTargets = config.battlePass.targets && typeof config.battlePass.targets === 'object'
    && !Array.isArray(config.battlePass.targets) ? config.battlePass.targets : {};
  const battlePassTargets = {};
  for (const areaKey of supportedBattlePassAreas) {
    const source = configuredBattlePassTargets[areaKey] && typeof configuredBattlePassTargets[areaKey] === 'object'
      && !Array.isArray(configuredBattlePassTargets[areaKey]) ? configuredBattlePassTargets[areaKey] : {};
    const entries = {};
    for (const [rawMonsterKey, entry] of Object.entries(source).slice(0, 100)) {
      const monsterKey = monsterTypeKey(rawMonsterKey);
      if (!monsterKey || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      entries[monsterKey] = {
        name: String(entry.name || rawMonsterKey).trim().slice(0, 160),
        targetDamage: Math.trunc(clampNumber(entry.targetDamage, 300000, 300000, Number.MAX_SAFE_INTEGER)),
        priority: Math.trunc(clampNumber(entry.priority, 0, 0, 1000000)),
        enabled: entry.enabled === true,
      };
    }
    if (Object.keys(entries).length > 0) battlePassTargets[areaKey] = entries;
  }
  const legacyBattlePassMonster = monsterTypeKey(config.battlePass.monsterKey);
  if (legacyBattlePassMonster && !battlePassTargets[selectedBattlePassArea]?.[legacyBattlePassMonster]) {
    battlePassTargets[selectedBattlePassArea] ||= {};
    battlePassTargets[selectedBattlePassArea][legacyBattlePassMonster] = {
      name: String(config.battlePass.monsterKey || legacyBattlePassMonster).trim().slice(0, 160),
      targetDamage: Math.trunc(clampNumber(config.battlePass.targetDamage, 300000, 300000, Number.MAX_SAFE_INTEGER)),
      priority: Math.trunc(clampNumber(config.battlePass.priority, 0, 0, 1000000)),
      enabled: true,
    };
  }
  config.battlePass = {
    enabled: config.battlePass.enabled === true,
    areaKey: selectedBattlePassArea,
    lootIfAchievable: config.battlePass.lootIfAchievable === true,
    safeCheck: config.battlePass.safeCheck === true,
    targets: battlePassTargets,
  };
  config.combat.attackDelayMs.min = Math.trunc(clampNumber(config.combat.attackDelayMs.min, 600, 500, 60000));
  config.combat.attackDelayMs.max = Math.trunc(clampNumber(
    config.combat.attackDelayMs.max,
    1200,
    config.combat.attackDelayMs.min,
    120000
  ));
  if (!config.combat.attackStrategy || typeof config.combat.attackStrategy !== 'object' || Array.isArray(config.combat.attackStrategy)) {
    config.combat.attackStrategy = clone(DEFAULT_CONFIG.combat.attackStrategy);
  }
  const attackMultipliers = new Set([1, 10, 50, 100, 200, 1000]);
  if (!['fixed', 'adaptive'].includes(config.combat.attackStrategy.mode)) {
    config.combat.attackStrategy.mode = DEFAULT_CONFIG.combat.attackStrategy.mode;
  }
  const fixedMultiplier = Number(config.combat.attackStrategy.fixedMultiplier);
  config.combat.attackStrategy.fixedMultiplier = attackMultipliers.has(fixedMultiplier)
    ? fixedMultiplier
    : DEFAULT_CONFIG.combat.attackStrategy.fixedMultiplier;
  const maxMultiplier = Number(config.combat.attackStrategy.maxMultiplier);
  config.combat.attackStrategy.maxMultiplier = attackMultipliers.has(maxMultiplier)
    ? maxMultiplier
    : DEFAULT_CONFIG.combat.attackStrategy.maxMultiplier;
  config.combat.attackStrategy.overshootPercent = Math.trunc(clampNumber(
    config.combat.attackStrategy.overshootPercent,
    DEFAULT_CONFIG.combat.attackStrategy.overshootPercent,
    0,
    500
  ));
  config.combat.attackStrategy.failSafeEnabled = config.combat.attackStrategy.failSafeEnabled === true;
  config.combat.attackStrategy.failSafePercent = Math.trunc(clampNumber(
    config.combat.attackStrategy.failSafePercent,
    DEFAULT_CONFIG.combat.attackStrategy.failSafePercent,
    0,
    100
  ));
  config.combat.attackStrategy.requireTargetStamina = config.combat.attackStrategy.requireTargetStamina === true;
  config.combat.attackStrategy.nukeEnabled = config.combat.attackStrategy.nukeEnabled === true;
  const nukeAttack = String(config.combat.attackStrategy.nukeAttack || 'auto');
  config.combat.attackStrategy.nukeAttack = nukeAttack === 'auto' || /^normal:(?:1|10|50|100|200|1000)$/.test(nukeAttack)
    || /^ability:\d{1,12}$/.test(nukeAttack)
    ? nukeAttack
    : DEFAULT_CONFIG.combat.attackStrategy.nukeAttack;
  config.combat.attackStrategy.nukeAllowAbilities = config.combat.attackStrategy.nukeAllowAbilities === true;

  if (!config.autoFarm || typeof config.autoFarm !== 'object' || Array.isArray(config.autoFarm)) {
    config.autoFarm = clone(DEFAULT_CONFIG.autoFarm);
  }
  const autoFarmArea = getMonsterArea(config.autoFarm.areaKey);
  config.autoFarm.areaKey = autoFarmArea && autoFarmAreaKeys.has(config.autoFarm.areaKey)
    ? config.autoFarm.areaKey
    : autoFarmAreas[0]?.key || null;
  if (!config.autoFarm.settings || typeof config.autoFarm.settings !== 'object' || Array.isArray(config.autoFarm.settings)) {
    config.autoFarm.settings = clone(DEFAULT_CONFIG.autoFarm.settings);
  }
  const autoSettings = config.autoFarm.settings;
  autoSettings.totalMonsters = Math.trunc(clampNumber(autoSettings.totalMonsters, 0, 0, Number.MAX_SAFE_INTEGER));
  autoSettings.hpPotionLimit = Math.trunc(clampNumber(autoSettings.hpPotionLimit, 0, 0, 1000000));
  if (!autoSettings.staminaPotionLimits || typeof autoSettings.staminaPotionLimits !== 'object' || Array.isArray(autoSettings.staminaPotionLimits)) {
    autoSettings.staminaPotionLimits = clone(DEFAULT_CONFIG.autoFarm.settings.staminaPotionLimits);
  }
  for (const type of ['small', 'large', 'full', 'adventure']) {
    autoSettings.staminaPotionLimits[type] = Math.trunc(clampNumber(autoSettings.staminaPotionLimits[type], 0, 0, 1000000));
  }
  const priorityId = String(autoSettings.priorityItemId ?? '0');
  autoSettings.priorityItemId = new Set(['0', '30', '251', '35', '359']).has(priorityId) ? priorityId : '0';
  autoSettings.autoLootToLevel = autoSettings.autoLootToLevel === true;
  autoSettings.expLeftPercent = Math.trunc(clampNumber(autoSettings.expLeftPercent, 100, 0, 100));
  const autoMaps = config.autoFarm.maps && typeof config.autoFarm.maps === 'object' && !Array.isArray(config.autoFarm.maps)
    ? config.autoFarm.maps : {};
  config.autoFarm.maps = {};
  for (const [areaKey, entries] of Object.entries(autoMaps)) {
    const area = getMonsterArea(areaKey);
    if (!area || !autoFarmAreaKeys.has(areaKey) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    const normalized = {};
    for (const [monsterKey, entry] of Object.entries(entries).slice(0, 200)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(monsterKey) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 100) : '';
      if (!name) continue;
      normalized[monsterKey] = {
        name,
        monsterId: /^\d{1,30}$/.test(String(entry.monsterId || '')) ? String(entry.monsterId) : null,
        targetDamage: Math.trunc(clampNumber(entry.targetDamage, 0, 0, Number.MAX_SAFE_INTEGER)),
        maxStack: Math.trunc(clampNumber(entry.maxStack, 1, 1, 250)),
        enabled: entry.enabled === true,
      };
    }
    config.autoFarm.maps[areaKey] = normalized;
  }
  const stablePolicies = config.autoFarm.targetPolicies && typeof config.autoFarm.targetPolicies === 'object'
    && !Array.isArray(config.autoFarm.targetPolicies) ? config.autoFarm.targetPolicies : {};
  const legacyServerTargets = input?.autoFarm?.serverTargets && typeof input.autoFarm.serverTargets === 'object'
    && !Array.isArray(input.autoFarm.serverTargets) ? input.autoFarm.serverTargets : {};
  const policiesByMonsterId = new Map();
  for (const [monsterId, entry] of Object.entries(stablePolicies).slice(0, 500)) {
    if (!/^\d{1,30}$/.test(monsterId) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    policiesByMonsterId.set(monsterId, entry);
  }
  for (const entry of Object.values(legacyServerTargets).slice(0, 500)) {
    const monsterId = String(entry?.monsterId || '');
    if (!/^\d{1,30}$/.test(monsterId) || policiesByMonsterId.has(monsterId)
      || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    policiesByMonsterId.set(monsterId, entry);
  }
  const mapMonsterIds = new Set(Object.values(config.autoFarm.maps).flatMap(entries => (
    Object.values(entries || {}).map(entry => String(entry?.monsterId || '')).filter(value => /^\d{1,30}$/.test(value))
  )));
  config.autoFarm.targetPolicies = {};
  for (const [monsterId, entry] of [...policiesByMonsterId].slice(0, 500)) {
    if (mapMonsterIds.has(monsterId)) continue;
    config.autoFarm.targetPolicies[monsterId] = {
      monsterName: typeof entry.monsterName === 'string' ? entry.monsterName.trim().slice(0, 100) : '',
      areaKey: (() => {
        const area = getMonsterArea(entry.areaKey);
        return area && autoFarmAreaKeys.has(entry.areaKey) ? entry.areaKey : null;
      })(),
      enabled: entry.enabled === true,
      damageMode: Number(entry.damageMode) === 0 ? 0 : 1,
      minDamage: Math.trunc(clampNumber(entry.minDamage, 0, 0, Number.MAX_SAFE_INTEGER)),
      maxStack: Math.trunc(clampNumber(entry.maxStack, 1, 1, 250)),
    };
  }
  delete config.autoFarm.serverTargets;

  if (!['potion_first', 'timed_first', 'potion_only', 'timed_only'].includes(config.healing.mode)) {
    config.healing.mode = DEFAULT_CONFIG.healing.mode;
  }
  config.healing.hpThresholdPercent = clampNumber(config.healing.hpThresholdPercent, 30, 1, 100);
  if (!['none', 'dungeons', 'gates', 'dungeons_gates'].includes(config.looting.module)) {
    config.looting.module = DEFAULT_CONFIG.looting.module;
  }
  config.looting.autoLoot = config.looting.autoLoot !== false;
  config.looting.lootDelay.min = Math.trunc(clampNumber(config.looting.lootDelay.min, 300, 100, 60000));
  config.looting.lootDelay.max = Math.trunc(clampNumber(
    config.looting.lootDelay.max,
    800,
    config.looting.lootDelay.min,
    120000
  ));
  const validatedLootMaps = {};
  const inputLootMaps = config.looting.maps && typeof config.looting.maps === 'object' && !Array.isArray(config.looting.maps)
    ? config.looting.maps
    : {};
  for (const [areaKey, entries] of Object.entries(inputLootMaps)) {
    if (!visibleAreaKeys.has(areaKey) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    const validatedEntries = {};
    for (const [monsterKey, entry] of Object.entries(entries).slice(0, 200)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(monsterKey) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 100) : '';
      if (!name) continue;
      validatedEntries[monsterKey] = {
        name,
        priority: Math.trunc(clampNumber(entry.priority, 0, 0, 1000000)),
        maxLooting: Math.trunc(clampNumber(entry.maxLooting, 0, 0, 1000000)),
        unlimited: entry.unlimited === true,
        lootedCount: Math.trunc(clampNumber(entry.lootedCount, 0, 0, 1000000)),
        lootedInstanceIds: [...new Set(
          (Array.isArray(entry.lootedInstanceIds) ? entry.lootedInstanceIds : [])
            .map(value => String(value))
            .filter(value => /^\d{1,30}$/.test(value))
        )].slice(-2000),
        enabled: entry.enabled === true,
      };
    }
    validatedLootMaps[areaKey] = validatedEntries;
  }
  config.looting.maps = validatedLootMaps;

  const hasExplicitProgression = input?.progression
    && typeof input.progression === 'object'
    && !Array.isArray(input.progression);
  const legacyProgressionEnabled = !hasExplicitProgression
    && ['dungeons', 'gates', 'dungeons_gates'].includes(input?.looting?.module);
  if (!config.progression || typeof config.progression !== 'object' || Array.isArray(config.progression)) {
    config.progression = clone(DEFAULT_CONFIG.progression);
  }
  config.progression.enabled = true;
  config.progression.useLootForLeveling = hasExplicitProgression
    ? config.progression.useLootForLeveling === true
    : legacyProgressionEnabled;
  config.progression.allowChapterFallback = config.progression.allowChapterFallback === true;
  config.progression.drainBeforePots = config.progression.drainBeforePots !== false;
  delete config.progression.allowTargetPotionFallback;
  const hasExplicitLootSources = hasExplicitProgression
    && input.progression.lootSources
    && typeof input.progression.lootSources === 'object'
    && !Array.isArray(input.progression.lootSources);
  const configuredSourceGroups = config.progression.lootSources
    && typeof config.progression.lootSources === 'object'
    && !Array.isArray(config.progression.lootSources)
    ? config.progression.lootSources
    : {};
  const normalizeAreas = (areas, allowed) => [...new Set(
    (Array.isArray(areas) ? areas : []).filter(areaKey => allowed.has(areaKey)),
  )];
  let legacyGateAreas = [];
  let legacyEventAreas = [];
  let legacyDungeonAreas = [];
  if (!hasExplicitLootSources && config.progression.useLootForLeveling) {
    const module = config.general?.module;
    if (module === 'gates') legacyGateAreas = [config.general.primaryGateMap || config.general.map];
    if (module === 'event') legacyEventAreas = [config.general.eventMap || config.general.map];
    if (module === 'dungeons') legacyDungeonAreas = [config.general.dungeonMap || config.general.map];
  }
  const gateAreas = hasExplicitLootSources
    ? normalizeAreas(configuredSourceGroups.gates?.areas, progressionGateAreas)
    : normalizeAreas(legacyGateAreas, progressionGateAreas);
  // Earlier builds saved Event selections inside the Gate source group.
  const embeddedEventAreas = hasExplicitLootSources
    ? normalizeAreas(configuredSourceGroups.gates?.areas, progressionEventAreas)
    : [];
  const eventAreas = hasExplicitLootSources
    ? normalizeAreas([
      ...(Array.isArray(configuredSourceGroups.events?.areas) ? configuredSourceGroups.events.areas : []),
      ...embeddedEventAreas,
    ], progressionEventAreas)
    : normalizeAreas(legacyEventAreas, progressionEventAreas);
  const dungeonAreas = hasExplicitLootSources
    ? normalizeAreas(configuredSourceGroups.dungeons?.areas, progressionDungeonAreas)
    : normalizeAreas(legacyDungeonAreas, progressionDungeonAreas);
  config.progression.lootSources = {
    gates: {
      enabled: hasExplicitLootSources
        ? configuredSourceGroups.gates?.enabled === true && gateAreas.length > 0
        : gateAreas.length > 0,
      areas: gateAreas,
    },
    events: {
      enabled: hasExplicitLootSources
        ? (configuredSourceGroups.events?.enabled === true
          || (configuredSourceGroups.gates?.enabled === true && embeddedEventAreas.length > 0)) && eventAreas.length > 0
        : eventAreas.length > 0,
      areas: eventAreas,
    },
    dungeons: {
      enabled: hasExplicitLootSources
        ? configuredSourceGroups.dungeons?.enabled === true && dungeonAreas.length > 0
        : dungeonAreas.length > 0,
      areas: dungeonAreas,
    },
  };

  for (const groupName of ['gear', 'pets']) {
    for (const context of ['pve', 'pvpAttack', 'pvpDefense']) {
      if (!quickSetSelections.has(config.equipment[groupName][context])) {
        config.equipment[groupName][context] = DEFAULT_CONFIG.equipment[groupName][context];
      }
    }
  }

  const validatedMonsterMaps = {};
  const inputMonsterMaps = config.monsters && typeof config.monsters === 'object' &&
    config.monsters.maps && typeof config.monsters.maps === 'object' && !Array.isArray(config.monsters.maps)
    ? config.monsters.maps
    : {};
  for (const [areaKey, entries] of Object.entries(inputMonsterMaps)) {
    if (!visibleAreaKeys.has(areaKey) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    const validatedEntries = {};
    for (const [monsterKey, entry] of Object.entries(entries).slice(0, 200)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(monsterKey) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 100) : '';
      if (!name) continue;
      validatedEntries[monsterKey] = {
        name,
        targetDamage: Math.trunc(clampNumber(entry.targetDamage, 0, 0, Number.MAX_SAFE_INTEGER)),
        killCount: Math.trunc(clampNumber(entry.killCount, 0, 0, 1000000)),
        unlimited: entry.unlimited === true,
        priority: Math.trunc(clampNumber(entry.priority, 0, 0, 1000000)),
        minimumHp: Math.trunc(clampNumber(entry.minimumHp, 0, 0, Number.MAX_SAFE_INTEGER)),
        completedCount: Math.trunc(clampNumber(entry.completedCount, 0, 0, 1000000)),
        completedInstanceIds: [...new Set(
          (Array.isArray(entry.completedInstanceIds) ? entry.completedInstanceIds : [])
            .map(value => String(value))
            .filter(value => /^\d{1,30}$/.test(value))
        )].slice(-2000),
        gearSet: quickSetSelections.has(entry.gearSet) ? entry.gearSet : 'default',
        petSet: quickSetSelections.has(entry.petSet) ? entry.petSet : 'default',
        staminaPotion: staminaPotionSelections.has(entry.staminaPotion) ? entry.staminaPotion : 'none',
        allowAbilities: entry.allowAbilities === true,
        enabled: entry.enabled === true,
      };
    }
    validatedMonsterMaps[areaKey] = validatedEntries;
  }
  config.monsters = { maps: validatedMonsterMaps };

  if (!config.resources || typeof config.resources !== 'object' || Array.isArray(config.resources)) {
    config.resources = clone(DEFAULT_CONFIG.resources);
  }
  for (const section of ['stamina', 'health', 'mana']) {
    if (!config.resources[section] || typeof config.resources[section] !== 'object' || Array.isArray(config.resources[section])) {
      config.resources[section] = clone(DEFAULT_CONFIG.resources[section]);
    }
  }
  const stamina = config.resources.stamina;
  // The former overflow router was removed.  It duplicated Module/Target
  // selection and produced surprising cross-area behavior.  Old presets are
  // accepted, but the obsolete keys are deliberately discarded.
  delete stamina.spendInRed;
  delete stamina.overflowArea;
  delete stamina.overflowMonster;
  delete stamina.overflowMode;
  delete stamina.overflowAmount;
  delete stamina.overflowBackupArea;
  delete stamina.overflowBackupMonster;
  delete stamina.overflowBackupMode;
  delete stamina.overflowBackupAmount;
  delete stamina.redGate;
  delete stamina.redMonster;
  delete stamina.redTargetDamage;
  stamina.keepMin = Math.trunc(clampNumber(stamina.keepMin, 0, 0, 100));
  stamina.keepMax = Math.trunc(clampNumber(stamina.keepMax, 0, stamina.keepMin, 100));
  stamina.stopBelow = Math.trunc(clampNumber(stamina.stopBelow, 0, 0, 100));
  stamina.allowPotions = stamina.allowPotions === true;
  stamina.priority = ['small', 'large', 'full', 'adventure'].includes(stamina.priority) ? stamina.priority : 'small';
  if (!stamina.potionLimits || typeof stamina.potionLimits !== 'object' || Array.isArray(stamina.potionLimits)) {
    stamina.potionLimits = clone(DEFAULT_CONFIG.resources.stamina.potionLimits);
  }
  for (const potionType of ['small', 'large', 'full', 'adventure']) {
    stamina.potionLimits[potionType] = Math.trunc(clampNumber(stamina.potionLimits[potionType], 0, 0, 1000000));
  }

  const normalizeProfileProgression = candidate => {
    const policy = deepMerge(DEFAULT_CONFIG.progression, candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate : {});
    policy.enabled = true;
    policy.useLootForLeveling = policy.useLootForLeveling === true;
    policy.allowChapterFallback = policy.allowChapterFallback === true;
    policy.drainBeforePots = policy.drainBeforePots !== false;
    delete policy.allowTargetPotionFallback;
    const groups = policy.lootSources && typeof policy.lootSources === 'object' && !Array.isArray(policy.lootSources)
      ? policy.lootSources : {};
    const normalizeGroup = (group, allowed) => {
      const areas = [...new Set((Array.isArray(group?.areas) ? group.areas : []).filter(areaKey => allowed.has(areaKey)))];
      return { enabled: group?.enabled === true && areas.length > 0, areas };
    };
    policy.lootSources = {
      gates: normalizeGroup(groups.gates, progressionGateAreas),
      events: normalizeGroup(groups.events, progressionEventAreas),
      dungeons: normalizeGroup(groups.dungeons, progressionDungeonAreas),
    };
    return policy;
  };
  const hasExplicitProgressionProfiles = input?.progressionProfiles
    && typeof input.progressionProfiles === 'object'
    && !Array.isArray(input.progressionProfiles)
    && input.progressionProfiles.profiles
    && typeof input.progressionProfiles.profiles === 'object'
    && !Array.isArray(input.progressionProfiles.profiles);
  const fallbackProfile = {
    id: 'default',
    name: 'Default',
    progression: normalizeProfileProgression(config.progression),
    stamina: progressionProfileStamina(stamina),
  };
  const requestedProfiles = hasExplicitProgressionProfiles ? input.progressionProfiles.profiles : {};
  const profiles = {};
  for (const [profileId, rawProfile] of Object.entries(requestedProfiles).slice(0, 50)) {
    if (!/^(?:default|profile_[a-z0-9-]{1,64})$/.test(profileId)
      || !rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue;
    profiles[profileId] = {
      id: profileId,
      name: profileId === 'default'
        ? 'Default'
        : normalizedProgressionProfileName(rawProfile.name),
      progression: normalizeProfileProgression(rawProfile.progression),
      stamina: progressionProfileStamina(rawProfile.stamina),
    };
  }
  if (!profiles.default) profiles.default = fallbackProfile;
  const requestedActiveId = String(input.progressionProfiles?.activeId || 'default');
  const activeId = Object.hasOwn(profiles, requestedActiveId) ? requestedActiveId : 'default';
  config.progressionProfiles = { activeId, profiles };
  const activeProfile = profiles[activeId];
  config.progression = clone(activeProfile.progression);
  Object.assign(stamina, clone(activeProfile.stamina));

  const health = config.resources.health;
  health.sleepBelow = Math.trunc(clampNumber(health.sleepBelow, 0, 0, 100));
  health.maxDeaths = Math.trunc(clampNumber(health.maxDeaths, 0, 0, 1000000));
  health.usePotions = health.usePotions === true;
  health.maxPotions = Math.trunc(clampNumber(health.maxPotions, 0, 0, 1000000));
  health.buyPotionIfNeeded = health.buyPotionIfNeeded === true;
  if (inputHealth?.maxPurchases === undefined && Number(inputHealth?.maxSpendGold) > 0) {
    health.maxPurchases = Math.floor(Number(inputHealth.maxSpendGold) / 30000);
  }
  health.maxPurchases = Math.trunc(clampNumber(health.maxPurchases, 0, 0, 1000000));
  health.purchasedCount = Math.trunc(clampNumber(health.purchasedCount, 0, 0, 1000000));
  delete health.maxSpendGold;
  delete health.spentGold;
  delete health.keepMin;
  delete health.keepMax;

  const mana = config.resources.mana;
  delete mana.allowAbilities;
  mana.allowPotions = mana.allowPotions === true || ['small', 'large'].includes(inputMana?.potion);
  mana.priority = ['small', 'large'].includes(mana.priority) ? mana.priority : 'small';
  if (!mana.potionLimits || typeof mana.potionLimits !== 'object' || Array.isArray(mana.potionLimits)) {
    mana.potionLimits = clone(DEFAULT_CONFIG.resources.mana.potionLimits);
  }
  for (const potionType of ['small', 'large']) {
    mana.potionLimits[potionType] = Math.trunc(clampNumber(mana.potionLimits[potionType], 0, 0, 1000000));
  }
  const legacyManaMinimum = inputMana?.keepMin === undefined && inputMana?.stopBelow !== undefined
    ? Math.max(0, Math.trunc(Number(inputMana.stopBelow) || 0))
    : inputMana?.keepMin;
  mana.keepMin = Math.floor(clampNumber(legacyManaMinimum, 0, 0, 1000000) / 20) * 20;
  mana.keepMax = Math.floor(clampNumber(inputMana?.keepMax, 200, mana.keepMin, 1000000) / 20) * 20;
  delete mana.stopBelow;
  mana.buyPotionIfNeeded = mana.buyPotionIfNeeded === true;
  if (inputMana?.maxPurchases === undefined && Number(inputMana?.maxSpendGold) > 0) {
    mana.maxPurchases = Math.floor(Number(inputMana.maxSpendGold) / 60000);
  }
  mana.maxPurchases = Math.trunc(clampNumber(mana.maxPurchases, 0, 0, 1000000));
  mana.purchasedCount = Math.trunc(clampNumber(mana.purchasedCount, 0, 0, 1000000));
  delete mana.potion;
  delete mana.maxSpendGold;
  delete mana.spentGold;

  config.energyFarming.enabled = config.energyFarming.enabled === true;
  config.energyFarming.farmWhenStaminaBelow = Math.trunc(clampNumber(
    config.energyFarming.farmWhenStaminaBelow,
    100,
    0,
    1000000
  ));
  config.energyFarming.maxPerSession = Math.trunc(clampNumber(config.energyFarming.maxPerSession, 500, 1, 1000));
  if (!['1', '2', '3', '4', '5', 'random'].includes(String(config.energyFarming.reactionType).toLowerCase())) {
    config.energyFarming.reactionType = 'random';
  } else {
    config.energyFarming.reactionType = String(config.energyFarming.reactionType).toLowerCase();
  }

  config.scheduler.minDelay = Math.trunc(clampNumber(config.scheduler.minDelay, 600, 100, 60000));
  config.scheduler.maxDelay = Math.trunc(clampNumber(
    config.scheduler.maxDelay,
    1200,
    config.scheduler.minDelay,
    120000
  ));
  config.scheduler.jitterRatio = clampNumber(config.scheduler.jitterRatio, 0.25, 0.05, 0.5);
  config.scheduler.minActionsPerSecond = clampNumber(
    config.scheduler.minActionsPerSecond,
    1000 / config.scheduler.maxDelay,
    0.01,
    10
  );
  config.scheduler.maxActionsPerSecond = clampNumber(
    config.scheduler.maxActionsPerSecond,
    1000 / config.scheduler.minDelay,
    config.scheduler.minActionsPerSecond,
    10
  );
  if (!config.scheduler.attackIntervals || typeof config.scheduler.attackIntervals !== 'object' || Array.isArray(config.scheduler.attackIntervals)) {
    config.scheduler.attackIntervals = clone(DEFAULT_CONFIG.scheduler.attackIntervals);
  }
  for (const kind of ['gate', 'dungeon']) {
    if (!config.scheduler.attackIntervals[kind] || typeof config.scheduler.attackIntervals[kind] !== 'object' || Array.isArray(config.scheduler.attackIntervals[kind])) {
      config.scheduler.attackIntervals[kind] = clone(DEFAULT_CONFIG.scheduler.attackIntervals[kind]);
    }
  }
  config.scheduler.attackIntervals.gate.minDelay = Math.trunc(clampNumber(
    config.scheduler.attackIntervals.gate.minDelay,
    1050,
    1050,
    60000
  ));
  config.scheduler.attackIntervals.gate.maxDelay = Math.trunc(clampNumber(
    config.scheduler.attackIntervals.gate.maxDelay,
    1200,
    config.scheduler.attackIntervals.gate.minDelay,
    120000
  ));
  config.scheduler.attackIntervals.dungeon.minDelay = Math.trunc(clampNumber(
    config.scheduler.attackIntervals.dungeon.minDelay,
    1000,
    1000,
    60000
  ));
  config.scheduler.attackIntervals.dungeon.maxDelay = Math.trunc(clampNumber(
    config.scheduler.attackIntervals.dungeon.maxDelay,
    1200,
    config.scheduler.attackIntervals.dungeon.minDelay,
    120000
  ));
  config.scheduler.lootScanIntervalMinutes = Math.trunc(clampNumber(
    config.scheduler.lootScanIntervalMinutes,
    DEFAULT_CONFIG.scheduler.lootScanIntervalMinutes,
    1,
    1440
  ));
  config.scheduler.targetScanIntervalSeconds = clampNumber(
    config.scheduler.targetScanIntervalSeconds,
    DEFAULT_CONFIG.scheduler.targetScanIntervalSeconds,
    1,
    3600
  );
  config.safety.dryRun = config.safety.dryRun !== false;
  config.safety.maxConsecutiveErrors = Math.trunc(clampNumber(config.safety.maxConsecutiveErrors, 5, 1, 100));

  return config;
}

class ConfigManager {
  constructor(configPath = path.join(getDataDir(), 'bot_config.json'), options = {}) {
    this.configPath = configPath;
    this.accountDatabase = options.accountDatabase || null;
    this.activeAccount = null;
    this.legacyConfig = validateConfig(this._read());
    this.config = this.accountDatabase ? validateConfig({}) : clone(this.legacyConfig);
  }

  _read() {
    try {
      if (!fs.existsSync(this.configPath)) return {};
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to load bot configuration: ${error.message}`);
    }
  }

  getConfig() {
    return clone(this.config);
  }

  setActiveAccount(accountIdentity) {
    const normalized = String(
      accountIdentity && typeof accountIdentity === 'object'
        ? accountIdentity.accountKey
        : accountIdentity || '',
    ).trim();
    this.activeAccount = normalized || null;
    if (!this.accountDatabase || !this.activeAccount) {
      this.config = this.accountDatabase ? validateConfig({}) : clone(this.legacyConfig);
      return this.getConfig();
    }

    let stored = this.accountDatabase.getAccountConfig(this.activeAccount);
    if (!stored) {
      stored = this.accountDatabase.claimLegacyConfig(this.activeAccount, this.legacyConfig) || {};
      this.config = validateConfig(stored);
      this.accountDatabase.setAccountConfig(this.activeAccount, this.config);
    } else {
      this.config = validateConfig(stored);
    }
    return this.getConfig();
  }

  purgeAccount(accountIdentity) {
    const normalized = String(
      accountIdentity && typeof accountIdentity === 'object'
        ? accountIdentity.accountKey
        : accountIdentity || '',
    ).trim();
    if (!this.accountDatabase || !normalized) return false;
    const removed = this.accountDatabase.clearAccountConfig(normalized);
    if (this.activeAccount === normalized) this.config = validateConfig({});
    return removed;
  }

  update(patch) {
    const next = deepMerge(this.config, patch);
    const activeId = this.config.progressionProfiles?.activeId || 'default';
    const activeProfile = next.progressionProfiles?.profiles?.[activeId];
    if (activeProfile && patch?.progression && typeof patch.progression === 'object' && !Array.isArray(patch.progression)) {
      activeProfile.progression = deepMerge(activeProfile.progression || {}, patch.progression);
    }
    const staminaPatch = patch?.resources?.stamina;
    if (activeProfile && staminaPatch && typeof staminaPatch === 'object' && !Array.isArray(staminaPatch)) {
      const profilePatch = {};
      for (const field of ['allowPotions', 'priority', 'potionLimits']) {
        if (Object.hasOwn(staminaPatch, field)) profilePatch[field] = staminaPatch[field];
      }
      activeProfile.stamina = deepMerge(activeProfile.stamina || {}, profilePatch);
    }
    this.config = validateConfig(next);
    this.save();
    return this.getConfig();
  }

  createProgressionProfile(name) {
    const profiles = this.config.progressionProfiles?.profiles || {};
    if (Object.keys(profiles).length >= 50) {
      throw new Error('A maximum of 50 Progression profiles is supported');
    }
    const id = `profile_${crypto.randomUUID()}`;
    const next = clone(this.config);
    next.progressionProfiles.profiles[id] = {
      id,
      name: normalizedProgressionProfileName(name),
      progression: clone(DEFAULT_CONFIG.progression),
      stamina: progressionProfileStamina(DEFAULT_CONFIG.resources.stamina),
    };
    next.progressionProfiles.activeId = id;
    this.config = validateConfig(next);
    this.save();
    return this.getConfig();
  }

  renameProgressionProfile(profileId, name) {
    if (profileId === 'default') throw new Error('The Default Progression profile cannot be renamed');
    const next = clone(this.config);
    const profile = next.progressionProfiles?.profiles?.[profileId];
    if (!profile) throw new Error('Progression profile was not found');
    profile.name = normalizedProgressionProfileName(name);
    this.config = validateConfig(next);
    this.save();
    return this.getConfig();
  }

  deleteProgressionProfile(profileId) {
    if (profileId === 'default') throw new Error('The Default Progression profile cannot be deleted');
    const next = clone(this.config);
    if (!next.progressionProfiles?.profiles?.[profileId]) throw new Error('Progression profile was not found');
    delete next.progressionProfiles.profiles[profileId];
    if (next.progressionProfiles.activeId === profileId) next.progressionProfiles.activeId = 'default';
    this.config = validateConfig(next);
    this.save();
    return this.getConfig();
  }

  selectProgressionProfile(profileId) {
    if (!this.config.progressionProfiles?.profiles?.[profileId]) throw new Error('Progression profile was not found');
    const next = clone(this.config);
    next.progressionProfiles.activeId = profileId;
    this.config = validateConfig(next);
    this.save();
    return this.getConfig();
  }

  replace(config) {
    this.config = validateConfig(config);
    this.save();
    return this.getConfig();
  }

  save() {
    if (this.accountDatabase) {
      if (this.activeAccount) this.accountDatabase.setAccountConfig(this.activeAccount, this.config);
      return;
    }
    const directory = path.dirname(this.configPath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.configPath);
  }
}

module.exports = { ConfigManager, DEFAULT_CONFIG, deepMerge, validateConfig };
