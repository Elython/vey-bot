const fs = require('fs');
const path = require('path');
const { MONSTER_AREAS, MONSTER_AREA_KEYS, getMonsterArea, monsterTypeKey } = require('./monsterCatalog');
const { getDataDir } = require('../main/paths');

const PROGRESSION_GATE_AREAS = new Set(MONSTER_AREAS.filter(area => area.type === 'gate').map(area => area.key));
const PROGRESSION_EVENT_AREAS = new Set(MONSTER_AREAS.filter(area => area.type === 'event').map(area => area.key));
const PROGRESSION_DUNGEON_AREAS = new Set(MONSTER_AREAS.filter(area => area.type === 'dungeon').map(area => area.key));

const DEFAULT_CONFIG = Object.freeze({
  general: {
    module: 'idle',
    map: null,
    primaryGateMap: 'grakthar_1',
    dungeonMap: 'shadowbridge_warrens',
    gateMap: 'grakthar_1',
    eventMap: 'event_black_crown_ascends',
  },
  gates: {
    targetGate: 3,
    targetWave: 'latest',
    targetPriority: 'joined_first',
  },
  combat: {
    preferredSkill: 'slash',
    allowAbilities: false,
    allowedAbilityIds: [],
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
      spendInRed: false,
      overflowArea: null,
      overflowMonster: '',
      overflowMode: 'target_damage',
      overflowAmount: 0,
      overflowBackupArea: null,
      overflowBackupMonster: '',
      keepMin: 0,
      keepMax: 0,
      stopBelow: 0,
      allowPotions: false,
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
      allowAbilities: false,
      allowPotions: false,
      potionLimits: { small: 0, large: 0 },
      stopBelow: 0,
      buyPotionIfNeeded: false,
      maxPurchases: 0,
      purchasedCount: 0,
    },
  },
  progression: {
    enabled: false,
    useLootForLeveling: false,
    allowChapterFallback: false,
    allowTargetPotionFallback: false,
    lootSources: {
      gates: { enabled: false, areas: [] },
      events: { enabled: false, areas: [] },
      dungeons: { enabled: false, areas: [] },
    },
  },
  energyFarming: {
    enabled: true,
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
      dungeon: { minDelay: 1050, maxDelay: 1200 },
    },
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

function validateConfig(input = {}) {
  const inputHealth = input?.resources?.health;
  const inputMana = input?.resources?.mana;
  const config = deepMerge(DEFAULT_CONFIG, input);
  const quickSetSelections = new Set([
    'default',
    ...Array.from({ length: 10 }, (_, index) => `quick_set_${index + 1}`),
  ]);
  const staminaPotionSelections = new Set(['none', 'small', 'large', 'full', 'adventure']);

  const generalModules = new Set(['gates', 'dungeons', 'gates_dungeons', 'event', 'pvp', 'idle']);
  if (!config.general || typeof config.general !== 'object' || Array.isArray(config.general)) {
    config.general = clone(DEFAULT_CONFIG.general);
  }
  if (!generalModules.has(config.general?.module)) config.general.module = DEFAULT_CONFIG.general.module;
  const selectedArea = typeof config.general?.map === 'string' && MONSTER_AREA_KEYS.has(config.general.map)
    ? config.general.map
    : null;
  const selectedAreaType = getMonsterArea(selectedArea)?.type;
  const isStandardGate = areaKey => {
    const area = getMonsterArea(areaKey);
    return area?.type === 'gate' && !area.eventId;
  };
  const isEventGate = areaKey => {
    const area = getMonsterArea(areaKey);
    return area?.type === 'event' && Number.isInteger(area.eventId);
  };
  const legacyGateMap = typeof input.general?.gateMap === 'string' && isStandardGate(input.general.gateMap)
    ? input.general.gateMap
    : null;
  const requestedPrimaryGateMap = typeof input.general?.primaryGateMap === 'string'
    && isStandardGate(input.general.primaryGateMap)
    ? input.general.primaryGateMap
    : (selectedAreaType === 'gate' && isStandardGate(selectedArea) ? selectedArea : legacyGateMap || DEFAULT_CONFIG.general.primaryGateMap);
  const requestedGateMap = legacyGateMap || requestedPrimaryGateMap;
  const requestedDungeonMap = typeof input.general?.dungeonMap === 'string' && getMonsterArea(input.general.dungeonMap)?.type === 'dungeon'
    ? input.general.dungeonMap
    : (selectedAreaType === 'dungeon' ? selectedArea : DEFAULT_CONFIG.general.dungeonMap);
  const requestedEventMap = typeof input.general?.eventMap === 'string' && isEventGate(input.general.eventMap)
    ? input.general.eventMap
    : (isEventGate(selectedArea) ? selectedArea : DEFAULT_CONFIG.general.eventMap);
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
  config.combat.staminaReserve = Math.trunc(clampNumber(config.combat.staminaReserve, 50, 0, 1000000));
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
    if (!MONSTER_AREA_KEYS.has(areaKey) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
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
  config.progression.enabled = hasExplicitProgression
    ? config.progression.enabled === true
    : legacyProgressionEnabled;
  config.progression.useLootForLeveling = hasExplicitProgression
    ? config.progression.useLootForLeveling === true
    : legacyProgressionEnabled;
  config.progression.allowChapterFallback = config.progression.allowChapterFallback === true;
  config.progression.allowTargetPotionFallback = config.progression.allowTargetPotionFallback === true;
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
    if (module === 'gates_dungeons') {
      legacyDungeonAreas = [config.general.dungeonMap];
      legacyGateAreas = [config.general.gateMap];
    }
  }
  const gateAreas = hasExplicitLootSources
    ? normalizeAreas(configuredSourceGroups.gates?.areas, PROGRESSION_GATE_AREAS)
    : normalizeAreas(legacyGateAreas, PROGRESSION_GATE_AREAS);
  // Earlier builds saved Event selections inside the Gate source group.
  const embeddedEventAreas = hasExplicitLootSources
    ? normalizeAreas(configuredSourceGroups.gates?.areas, PROGRESSION_EVENT_AREAS)
    : [];
  const eventAreas = hasExplicitLootSources
    ? normalizeAreas([
      ...(Array.isArray(configuredSourceGroups.events?.areas) ? configuredSourceGroups.events.areas : []),
      ...embeddedEventAreas,
    ], PROGRESSION_EVENT_AREAS)
    : normalizeAreas(legacyEventAreas, PROGRESSION_EVENT_AREAS);
  const dungeonAreas = hasExplicitLootSources
    ? normalizeAreas(configuredSourceGroups.dungeons?.areas, PROGRESSION_DUNGEON_AREAS)
    : normalizeAreas(legacyDungeonAreas, PROGRESSION_DUNGEON_AREAS);
  config.progression.lootSources = {
    gates: {
      enabled: hasExplicitLootSources
        ? configuredSourceGroups.gates?.enabled === true
        : gateAreas.length > 0,
      areas: gateAreas,
    },
    events: {
      enabled: hasExplicitLootSources
        ? (configuredSourceGroups.events?.enabled === true
          || (configuredSourceGroups.gates?.enabled === true && embeddedEventAreas.length > 0))
        : eventAreas.length > 0,
      areas: eventAreas,
    },
    dungeons: {
      enabled: hasExplicitLootSources
        ? configuredSourceGroups.dungeons?.enabled === true
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
    if (!MONSTER_AREA_KEYS.has(areaKey) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
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
  const inputStamina = input?.resources?.stamina || {};
  stamina.spendInRed = stamina.spendInRed === true;
  const legacyOverflowArea = typeof inputStamina.redGate === 'string' ? inputStamina.redGate : null;
  const legacyOverflowMonster = inputStamina.redMonster;
  const legacyOverflowAmount = inputStamina.redTargetDamage;
  stamina.overflowArea = typeof stamina.overflowArea === 'string' && MONSTER_AREA_KEYS.has(stamina.overflowArea)
    ? stamina.overflowArea
    : (legacyOverflowArea && MONSTER_AREA_KEYS.has(legacyOverflowArea) ? legacyOverflowArea : null);
  stamina.overflowMonster = monsterTypeKey(stamina.overflowMonster || legacyOverflowMonster);
  stamina.overflowMode = ['target_damage', 'spend_stamina'].includes(stamina.overflowMode)
    ? stamina.overflowMode
    : DEFAULT_CONFIG.resources.stamina.overflowMode;
  stamina.overflowAmount = Math.trunc(clampNumber(
    inputStamina.overflowAmount !== undefined ? stamina.overflowAmount : legacyOverflowAmount,
    0,
    0,
    Number.MAX_SAFE_INTEGER
  ));
  stamina.overflowBackupArea = typeof stamina.overflowBackupArea === 'string' && MONSTER_AREA_KEYS.has(stamina.overflowBackupArea)
    ? stamina.overflowBackupArea
    : null;
  stamina.overflowBackupMonster = monsterTypeKey(stamina.overflowBackupMonster);
  delete stamina.redGate;
  delete stamina.redMonster;
  delete stamina.redTargetDamage;
  stamina.keepMin = Math.trunc(clampNumber(stamina.keepMin, 0, 0, 100));
  stamina.keepMax = Math.trunc(clampNumber(stamina.keepMax, 0, stamina.keepMin, 100));
  stamina.stopBelow = Math.trunc(clampNumber(stamina.stopBelow, 0, 0, 100));
  stamina.allowPotions = stamina.allowPotions === true;
  if (!stamina.potionLimits || typeof stamina.potionLimits !== 'object' || Array.isArray(stamina.potionLimits)) {
    stamina.potionLimits = clone(DEFAULT_CONFIG.resources.stamina.potionLimits);
  }
  for (const potionType of ['small', 'large', 'full', 'adventure']) {
    stamina.potionLimits[potionType] = Math.trunc(clampNumber(stamina.potionLimits[potionType], 0, 0, 1000000));
  }

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
  mana.allowAbilities = mana.allowAbilities === true;
  mana.allowPotions = mana.allowPotions === true || ['small', 'large'].includes(inputMana?.potion);
  if (!mana.potionLimits || typeof mana.potionLimits !== 'object' || Array.isArray(mana.potionLimits)) {
    mana.potionLimits = clone(DEFAULT_CONFIG.resources.mana.potionLimits);
  }
  for (const potionType of ['small', 'large']) {
    mana.potionLimits[potionType] = Math.trunc(clampNumber(mana.potionLimits[potionType], 0, 0, 1000000));
  }
  mana.stopBelow = Math.trunc(clampNumber(mana.stopBelow, 0, 0, 100));
  mana.buyPotionIfNeeded = mana.buyPotionIfNeeded === true;
  if (inputMana?.maxPurchases === undefined && Number(inputMana?.maxSpendGold) > 0) {
    mana.maxPurchases = Math.floor(Number(inputMana.maxSpendGold) / 60000);
  }
  mana.maxPurchases = Math.trunc(clampNumber(mana.maxPurchases, 0, 0, 1000000));
  mana.purchasedCount = Math.trunc(clampNumber(mana.purchasedCount, 0, 0, 1000000));
  delete mana.potion;
  delete mana.maxSpendGold;
  delete mana.spentGold;
  delete mana.keepMin;
  delete mana.keepMax;

  config.energyFarming.enabled = config.energyFarming.enabled !== false;
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
  const suppliedActionInterval = config.scheduler.attackIntervals.gate
    && typeof config.scheduler.attackIntervals.gate === 'object'
    && !Array.isArray(config.scheduler.attackIntervals.gate)
    ? config.scheduler.attackIntervals.gate
    : config.scheduler.attackIntervals.dungeon;
  const actionInterval = suppliedActionInterval && typeof suppliedActionInterval === 'object' && !Array.isArray(suppliedActionInterval)
    ? suppliedActionInterval
    : DEFAULT_CONFIG.scheduler.attackIntervals.gate;
  const actionMinDelay = Math.trunc(clampNumber(
    actionInterval.minDelay,
    1050,
    1050,
    60000
  ));
  const actionMaxDelay = Math.trunc(clampNumber(
    actionInterval.maxDelay,
    1200,
    actionMinDelay,
    120000
  ));
  config.scheduler.attackIntervals = {
    gate: { minDelay: actionMinDelay, maxDelay: actionMaxDelay },
    dungeon: { minDelay: actionMinDelay, maxDelay: actionMaxDelay },
  };
  config.safety.dryRun = config.safety.dryRun !== false;
  config.safety.maxConsecutiveErrors = Math.trunc(clampNumber(config.safety.maxConsecutiveErrors, 5, 1, 100));

  return config;
}

class ConfigManager {
  constructor(configPath = path.join(getDataDir(), 'bot_config.json')) {
    this.configPath = configPath;
    this.config = validateConfig(this._read());
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

  update(patch) {
    this.config = validateConfig(deepMerge(this.config, patch));
    this.save();
    return this.getConfig();
  }

  replace(config) {
    this.config = validateConfig(config);
    this.save();
    return this.getConfig();
  }

  save() {
    const directory = path.dirname(this.configPath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.configPath);
  }
}

module.exports = { ConfigManager, DEFAULT_CONFIG, deepMerge, validateConfig };
