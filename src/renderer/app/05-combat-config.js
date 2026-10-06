async function saveEquipmentConfig() {
  const equipment = {};
  Object.entries(EQUIPMENT_SELECTS).forEach(([groupName, group]) => {
    equipment[groupName] = {};
    Object.entries(group).forEach(([context, select]) => {
      equipment[groupName][context] = select?.value || 'default';
    });
  });
  const result = await updateCanonicalConfig({ equipment });
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not save Equipment configuration');
  }
}

async function saveAttackStrategy() {
  const combat = {
      allowAbilities: Boolean(chkAllowClassAbilities?.checked),
      allowedAbilityIds: [...allowedCombatAbilityIds],
      abilityPolicies: combatAbilityPolicies,
      attackStrategy: {
        mode: selectAttackMode?.value || 'fixed',
        fixedMultiplier: Number(selectFixedAttack?.value) || 1,
        maxMultiplier: Number(selectMaxAttack?.value) || 200,
        overshootPercent: Math.min(500, Math.max(0, nonNegativeInputValue(inputAttackOvershoot))),
        failSafeEnabled: Boolean(chkAdaptiveFailSafe?.checked),
        failSafePercent: Math.min(100, Math.max(0, nonNegativeInputValue(inputAdaptiveFailSafePercent))),
        requireTargetStamina: Boolean(chkAdaptiveRequireTargetStamina?.checked),
        nukeEnabled: Boolean(chkAdaptiveNuke?.checked),
        nukeAttack: selectAdaptiveNukeAttack?.value || configuredNukeAttack || 'auto',
        nukeAllowAbilities: Boolean(chkAdaptiveNukeAbilities?.checked),
      },
    };
  const result = await trackConfigSave(window.botAPI.updateCombatStrategy(combat));
  if (result?.success) markConfigDirty();
  if (!result?.success) appendLog('ERROR', result?.error || 'Could not save Attack Strategy');
}

function updateAttackModuleRows() {
  const adaptive = selectAttackMode?.value === 'adaptive';
  if (rowFixedAttack) rowFixedAttack.style.display = adaptive ? 'none' : 'flex';
  if (rowAdaptiveMax) rowAdaptiveMax.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveOvershoot) rowAdaptiveOvershoot.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveFailSafe) rowAdaptiveFailSafe.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveRequireTargetStamina) rowAdaptiveRequireTargetStamina.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveNuke) rowAdaptiveNuke.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveNukeAttack) rowAdaptiveNukeAttack.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveNukeAbilities) rowAdaptiveNukeAbilities.style.display = adaptive ? 'flex' : 'none';
  if (rowAdaptiveFailSafePercent) {
    rowAdaptiveFailSafePercent.style.display = adaptive ? 'flex' : 'none';
    const enabled = adaptive && chkAdaptiveFailSafe?.checked === true;
    rowAdaptiveFailSafePercent.classList.toggle('module-setting-disabled', !enabled);
    rowAdaptiveFailSafePercent.setAttribute('aria-disabled', String(!enabled));
    if (inputAdaptiveFailSafePercent) inputAdaptiveFailSafePercent.disabled = !enabled;
  }
}

function formatCombatValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '-';
}

function renderCombatPlayerStats(stats = latestStats) {
  if (combatPlayerAttack) combatPlayerAttack.textContent = formatCombatValue(stats?.attack);
  if (combatPlayerDefense) combatPlayerDefense.textContent = formatCombatValue(stats?.defense);
}

function selectedSetLabel(select) {
  return select?.selectedOptions?.[0]?.textContent || 'Selected set';
}

function closeLoadoutInfo() {
  if (modalLoadoutInfo) modalLoadoutInfo.style.display = 'none';
}

function loadoutInfoEmpty(message) {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = message;
  loadoutInfoContent?.replaceChildren(empty);
}

async function showLoadoutInfo(kind) {
  const requestToken = accountRequestToken();
  const isGear = kind === 'gear';
  const select = isGear ? selectGearPve : selectPetsPve;
  const label = selectedSetLabel(select);
  if (loadoutInfoTitle) loadoutInfoTitle.textContent = `${label} ${isGear ? 'Gear' : 'Pets'}`;
  if (loadoutInfoSummary) loadoutInfoSummary.textContent = '';
  if (modalLoadoutInfo) modalLoadoutInfo.style.display = 'flex';
  let items;
  let totals;
  const selectedValue = select?.value || 'default';
  if (selectedValue === 'default') {
    if (!activeCombatLoadout) await refreshCombatData(true);
    if (!isCurrentAccountRequest(requestToken)) return;
    items = isGear ? activeCombatLoadout?.gear : activeCombatLoadout?.pets;
    totals = isGear ? activeCombatLoadout?.totals?.gear : activeCombatLoadout?.totals?.pets;
  } else {
    const setNumber = Number(String(selectedValue).replace(/^quick_set_/, ''));
    loadoutInfoEmpty(`Reading ${label}…`);
    const result = await window.botAPI.getSavedLoadoutSet({
      kind: isGear ? 'gear' : 'pets',
      setNumber,
      context: 'attack',
    });
    if (!isCurrentAccountRequest(requestToken)) return;
    if (!result?.success) {
      loadoutInfoEmpty(result?.error || `${label} could not be read.`);
      return;
    }
    items = result.savedSet?.items;
    totals = result.savedSet?.totals;
  }
  if (loadoutInfoSummary) {
    loadoutInfoSummary.textContent = `ATK ${formatCombatValue(totals?.attack)} · DEF ${formatCombatValue(totals?.defense)}`;
  }
  if (!Array.isArray(items) || items.length === 0) {
    loadoutInfoEmpty(activeAccount ? 'No active items were found.' : 'Log in to read the active set.');
    return;
  }
  const table = document.createElement('div');
  table.className = 'loadout-info-table';
  const header = document.createElement('div');
  header.className = 'loadout-info-row loadout-info-header';
  for (const labelText of [isGear ? 'Gear' : 'Pet', 'ATK', 'DEF', 'Ability']) {
    const cell = document.createElement('span');
    cell.textContent = labelText;
    header.appendChild(cell);
  }
  table.appendChild(header);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'loadout-info-row';
    for (const value of [item.name || '-', formatCombatValue(item.attack), formatCombatValue(item.defense), item.ability || '—']) {
      const cell = document.createElement('span');
      cell.textContent = value;
      cell.title = value;
      row.appendChild(cell);
    }
    table.appendChild(row);
  }
  loadoutInfoContent?.replaceChildren(table);
}

function renderUnlockedAbilities(data) {
  if (!combatUnlockedAbilities) return;
  populateNukeAttackOptions(data);
  const table = document.createElement('div');
  table.className = 'combat-ability-table';
  const header = document.createElement('div');
  header.className = 'combat-ability-table-row combat-ability-table-header';
  for (const [label, title] of [
    ['Ability', 'Ability name read from the class Skill Tree.'], ['Info', 'Open the effect description read from the game page.'],
    ['MP', 'Mana consumed by one use.'], ['ST', 'Stamina consumed by one use.'], ['Type', 'Attack deals damage; Buff prepares your next actions; Debuff affects the enemy; Passive is never executed.'],
    ['Max', 'Maximum uses against each concrete enemy. Zero means unlimited.'], ['First', 'Successful damaging attacks to wait before the first use against each enemy.'],
    ['Reuse', 'Successful damaging attacks to wait before using this ability again.'],
    ['Min ST', 'Buff/Debuff only: minimum Stamina multiplier of the next damaging attack.'],
    ['Allow', 'Allow this owned ability globally. The monster row must also allow abilities.'],
  ]) {
    const cell = document.createElement('span'); cell.textContent = label; cell.title = title; header.append(cell);
  }
  table.append(header);
  let rowCount = 0;
  const appendInfoButton = (title, body) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'monster-stats-help combat-ability-info'; button.append(createLucideIcon('circle-help'));
    button.title = `View ${title} description`;
    button.addEventListener('click', () => showInfoDialog({ title, body: body || 'No description was provided by the skill tree.' }));
    return button;
  };
  if (data?.classPassive) {
    const row = document.createElement('div'); row.className = 'combat-ability-table-row combat-ability-passive';
    const name = document.createElement('span'); name.textContent = `${data.className} passive`;
    const role = document.createElement('span'); role.textContent = 'Passive';
    row.append(name, appendInfoButton(`${data.className} passive`, data.classPassive), document.createTextNode('—'), document.createTextNode('—'), role,
      document.createTextNode('—'), document.createTextNode('—'), document.createTextNode('—'), document.createTextNode('—'), document.createTextNode('—'));
    table.append(row); rowCount += 1;
  }
  for (const skill of data?.unlockedSkills || []) {
    const description = Array.isArray(skill.effects) && skill.effects.length > 0
      ? skill.effects.join('\n')
      : (Number(skill.flatStaminaDamage) > 0 ? `Flat Stamina damage: ${formatNumber(skill.flatStaminaDamage)}` : 'No effect description was provided.');
    const row = document.createElement('div');
    row.className = `combat-ability-table-row${skill.passive ? ' combat-ability-passive' : ''}`;
    const name = document.createElement('span'); name.className = 'combat-ability-name'; name.textContent = skill.name;
    const info = appendInfoButton(skill.name, description);
    const mana = document.createElement('span'); mana.textContent = String(skill.manaCost || 0);
    const stamina = document.createElement('span'); stamina.textContent = String(skill.staminaCost || 0);
    if (skill.passive) {
      const role = document.createElement('span'); role.textContent = 'Passive';
      row.append(name, info, mana, stamina, role, document.createTextNode('—'), document.createTextNode('—'), document.createTextNode('—'), document.createTextNode('—'), document.createTextNode('—'));
      table.append(row); rowCount += 1;
      continue;
    }
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tree-checkbox combat-ability-checkbox';
    checkbox.checked = allowedCombatAbilityIds.has(skill.id);
    checkbox.disabled = chkAllowClassAbilities?.checked !== true;
    checkbox.setAttribute('aria-label', `Allow ${skill.name}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) allowedCombatAbilityIds.add(skill.id);
      else allowedCombatAbilityIds.delete(skill.id);
      saveAttackStrategy();
    });
    const savedPolicy = combatAbilityPolicies[String(skill.id)] || { role: 'select', maxUses: 0, initialWaitTurns: 0, reapplyTurns: 1, minimumNextAttackStamina: 0 };
    const role = document.createElement('select');
    role.className = 'tree-select combat-ability-role';
    for (const [value, label] of [['select', 'Select'], ['attack', 'Attack'], ['buff', 'Buff'], ['debuff', 'Debuff'], ['passive', 'Passive']]) {
      role.append(new Option(label, value));
    }
    role.value = savedPolicy.role || 'select';
    role.disabled = chkAllowClassAbilities?.checked !== true;
    role.title = 'Choose how the scheduler treats this ability.';
    const makePolicyInput = (value, min, label) => {
      const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.max = '1000000';
      input.value = String(value); input.className = 'tree-input-sm combat-ability-number'; input.setAttribute('aria-label', `${skill.name} ${label}`);
      return input;
    };
    const maxUses = makePolicyInput(savedPolicy.maxUses ?? 0, 0, 'maximum uses');
    maxUses.title = '0 means unlimited uses for each enemy.';
    const initialWait = makePolicyInput(savedPolicy.initialWaitTurns ?? 0, 0, 'initial wait attacks');
    initialWait.max = '1000'; initialWait.title = 'Successful damaging attacks to wait before the first use on each enemy.';
    const repeatWait = makePolicyInput(savedPolicy.reapplyTurns ?? (role.value === 'debuff' ? 3 : 1), 1, 'repeat wait attacks');
    repeatWait.max = '1000'; repeatWait.title = 'Successful damaging attacks to wait before this ability can be used again.';
    const minimumNextAttack = document.createElement('select');
    minimumNextAttack.className = 'tree-select combat-ability-minimum';
    minimumNextAttack.setAttribute('aria-label', `${skill.name} minimum next attack Stamina`);
    for (const multiplier of [1, 10, 50, 100, 200, 1000]) minimumNextAttack.append(new Option(`x${multiplier}`, String(multiplier)));
    minimumNextAttack.value = String([1, 10, 50, 100, 200, 1000].includes(Number(savedPolicy.minimumNextAttackStamina))
      ? Number(savedPolicy.minimumNextAttackStamina) : 1);
    minimumNextAttack.title = 'Buff/Debuff only: use this support ability when the next damaging attack costs at least this much ST.';
    const updatePolicyAvailability = () => {
      const disabled = chkAllowClassAbilities?.checked !== true || ['select', 'passive'].includes(role.value);
      checkbox.disabled = disabled;
      for (const input of [maxUses, initialWait, repeatWait]) input.disabled = disabled;
      minimumNextAttack.disabled = disabled || role.value === 'attack';
      if (['select', 'passive'].includes(role.value)) checkbox.checked = false;
    };
    const savePolicy = () => {
      combatAbilityPolicies[String(skill.id)] = {
        role: role.value,
        maxUses: Math.max(0, Math.trunc(Number(maxUses.value) || 0)),
        initialWaitTurns: Math.max(0, Math.trunc(Number(initialWait.value) || 0)),
        reapplyTurns: Math.max(1, Math.trunc(Number(repeatWait.value) || 1)),
        minimumNextAttackStamina: ['buff', 'debuff'].includes(role.value)
          ? Math.max(1, Math.trunc(Number(minimumNextAttack.value) || 1))
          : 0,
      };
      saveAttackStrategy();
    };
    role.addEventListener('change', () => {
      if (['select', 'passive'].includes(role.value)) allowedCombatAbilityIds.delete(skill.id);
      updatePolicyAvailability();
      populateNukeAttackOptions(activeClassSkills);
      savePolicy();
    });
    for (const [input, minimum] of [[maxUses, 0], [initialWait, 0], [repeatWait, 1], [minimumNextAttack, 1]]) {
      input.addEventListener('change', () => {
        input.value = String(Math.max(minimum, Math.trunc(Number(input.value) || minimum)));
        savePolicy();
      });
    }
    updatePolicyAvailability();
    row.append(name, info, mana, stamina, role, maxUses, initialWait, repeatWait, minimumNextAttack, checkbox);
    table.append(row); rowCount += 1;
  }
  if (rowCount > 0) {
    combatUnlockedAbilities.replaceChildren(table);
    enhanceNumberInputs(table);
    refreshLucideIcons(combatUnlockedAbilities);
    return;
  }
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = 'No class abilities found.';
  combatUnlockedAbilities.replaceChildren(empty);
}

function populateNukeAttackOptions(data) {
  if (!selectAdaptiveNukeAttack) return;
  const selected = configuredNukeAttack || selectAdaptiveNukeAttack.value || 'auto';
  const options = [
    ['auto', 'Auto'],
    ['normal:1', 'x1'], ['normal:10', 'x10'], ['normal:50', 'x50'],
    ['normal:100', 'x100'], ['normal:200', 'x200'], ['normal:1000', 'x1000'],
  ];
  for (const skill of data?.unlockedSkills || []) {
    const role = combatAbilityPolicies[String(skill.id)]?.role || (skill.passive ? 'passive' : 'attack');
    if (skill.passive || role !== 'attack' || !Number.isInteger(Number(skill.id))) continue;
    options.push([`ability:${skill.id}`, `${skill.name} (ability)`]);
  }
  selectAdaptiveNukeAttack.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  if (options.some(([value]) => value === selected)) selectAdaptiveNukeAttack.value = selected;
  else selectAdaptiveNukeAttack.value = 'auto';
}

async function refreshClassSkills(force = false) {
  if (!activeAccount) return;
  const requestToken = accountRequestToken();
  if (!force && activeClassSkills) {
    renderUnlockedAbilities(activeClassSkills);
    return;
  }
  try {
    const result = await window.botAPI.getClassSkills(force);
    if (!isCurrentAccountRequest(requestToken)) return;
    if (!result?.success) {
      if (combatUnlockedAbilities) combatUnlockedAbilities.textContent = result?.error || 'Class skills could not be read';
      return;
    }
    activeClassSkills = result.skillTree;
    renderUnlockedAbilities(activeClassSkills);
  } catch (error) {
    if (!isCurrentAccountRequest(requestToken)) return;
    if (combatUnlockedAbilities) combatUnlockedAbilities.textContent = error.message || 'Class skills could not be read';
  }
}

async function refreshAttackStrategyStatus(force = false) {
  if (!activeAccount) return;
  const requestToken = accountRequestToken();
  try {
    const result = await window.botAPI.getAttackStrategyStatus(force);
    if (!isCurrentAccountRequest(requestToken)) return;
    if (!result?.success) throw new Error(result?.error || 'Active loadout could not be read');
    const loadout = result.loadout || {};
    activeCombatLoadout = loadout;
    const gearTotals = loadout.totals?.gear || {};
    const petTotals = loadout.totals?.pets || {};
    if (combatGearAttack) combatGearAttack.textContent = formatCombatValue(gearTotals.attack);
    if (combatGearDefense) combatGearDefense.textContent = formatCombatValue(gearTotals.defense);
    if (combatPetAttack) combatPetAttack.textContent = formatCombatValue(petTotals.attack);
    if (combatPetDefense) combatPetDefense.textContent = formatCombatValue(petTotals.defense);
    renderCombatPlayerStats();
  } catch (error) {
    appendLog('WARN', error.message || 'Active loadout could not be read');
  }
}

async function refreshCombatData(force = false) {
  if (!activeAccount) return;
  const requestToken = accountRequestToken();
  if (btnRefreshAttackStrategy) btnRefreshAttackStrategy.disabled = true;
  try {
    await Promise.all([refreshAttackStrategyStatus(force), refreshClassSkills(force)]);
  } finally {
    if (isCurrentAccountRequest(requestToken)) {
      if (btnRefreshAttackStrategy) btnRefreshAttackStrategy.disabled = false;
      refreshLucideIcons();
    }
  }
}

function loadHomeConfiguration(config) {
  const requestedModule = config.general?.module || 'idle';
  const supportedModule = selectGeneralModule
    && [...selectGeneralModule.options].some(option => option.value === requestedModule)
    ? requestedModule
    : 'idle';
  if (selectGeneralModule) selectGeneralModule.value = supportedModule;
  updateGeneralMaps(
    config.general?.primaryGateMap
      || (supportedModule === 'gates' ? config.general?.map : null)
      || null,
    config.general?.dungeonMap || null,
    config.general?.gateMap || null,
    config.general?.eventMap || null,
  );
  if (supportedModule !== requestedModule) {
    updateCanonicalConfig({ general: { module: 'idle', map: null } })
      .then(result => {
        if (!result?.success) appendLog('ERROR', result?.error || 'Could not normalize unsupported Module');
      });
  }
  loadProgressionProfileConfiguration(config);
  const stamina = config.resources?.stamina || {};
  const health = config.resources?.health || {};
  const mana = config.resources?.mana || {};
  lootingConfig = config.looting || { maps: {} };
  monsterConfig = config.monsters || { maps: {} };
  autoFarmConfig = config.autoFarm || { maps: {}, settings: {} };
  adventureQuestConfig = config.adventureQuests || { quests: {}, drafts: {} };
  battlePassConfig = config.battlePass || { enabled: false, areaKey: 'grakthar_3', lootIfAchievable: false, safeCheck: false, targets: {} };
  bossHuntConfig = config.bossHunt || { targets: {} };
  loadBattlePassPolicy();
  renderAdventureQuests(latestAdventureQuestState);
  areaCatalogConfig = config.areaCatalog || { custom: [], hidden: [] };
  const autoArea = [...EVENT_MAPS].some(([key]) => key === autoFarmConfig.areaKey) ? 'event' : 'gate';
  if (autoFarmTargetAreaTypeSelect) autoFarmTargetAreaTypeSelect.value = autoArea;
  replaceMapOptions(autoFarmTargetAreaSelect, autoArea === 'event' ? EVENT_MAPS : GATE_MAPS, autoFarmConfig.areaKey);
  const autoSettings = autoFarmConfig.settings || {};
  if (inputAutoFarmTotal) inputAutoFarmTotal.value = autoSettings.totalMonsters ?? 0;
  if (inputAutoFarmHpPots) inputAutoFarmHpPots.value = autoSettings.hpPotionLimit ?? 0;
  if (inputAutoFarmSmallPots) inputAutoFarmSmallPots.value = autoSettings.staminaPotionLimits?.small ?? 0;
  if (inputAutoFarmLargePots) inputAutoFarmLargePots.value = autoSettings.staminaPotionLimits?.large ?? 0;
  if (inputAutoFarmFullPots) inputAutoFarmFullPots.value = autoSettings.staminaPotionLimits?.full ?? 0;
  if (inputAutoFarmAdventurePots) inputAutoFarmAdventurePots.value = autoSettings.staminaPotionLimits?.adventure ?? 0;
  if (selectAutoFarmPotionPriority) selectAutoFarmPotionPriority.value = String(autoSettings.priorityItemId ?? '0');
  if (chkAutoFarmLootLevel) chkAutoFarmLootLevel.checked = autoSettings.autoLootToLevel === true;
  if (inputAutoFarmExpLeft) inputAutoFarmExpLeft.value = autoSettings.expLeftPercent ?? 100;
  if (inputKeepStaminaMin) inputKeepStaminaMin.value = stamina.keepMin ?? 0;
  if (inputKeepStaminaMax) inputKeepStaminaMax.value = stamina.keepMax ?? 0;
  if (inputStopStaminaBelow) inputStopStaminaBelow.value = stamina.stopBelow ?? 0;
  if (chkAllowStaminaPots) chkAllowStaminaPots.checked = stamina.allowPotions === true;
  if (selectStaminaPotionPriority) selectStaminaPotionPriority.value = stamina.priority || 'small';
  if (inputSmallStaminaPotLimit) inputSmallStaminaPotLimit.value = stamina.potionLimits?.small ?? 0;
  if (inputLargeStaminaPotLimit) inputLargeStaminaPotLimit.value = stamina.potionLimits?.large ?? 0;
  if (inputFullStaminaPotLimit) inputFullStaminaPotLimit.value = stamina.potionLimits?.full ?? 0;
  if (inputAdventureStaminaPotLimit) inputAdventureStaminaPotLimit.value = stamina.potionLimits?.adventure ?? 0;
  if (inputSleepHealthBelow) inputSleepHealthBelow.value = health.sleepBelow ?? 0;
  if (inputMaxDeaths) inputMaxDeaths.value = health.maxDeaths ?? 0;
  if (chkUseHealingPotions) chkUseHealingPotions.checked = health.usePotions === true;
  if (inputMaxHealingPotions) inputMaxHealingPotions.value = health.maxPotions ?? 0;
  if (chkBuyHealthPotion) chkBuyHealthPotion.checked = health.buyPotionIfNeeded === true;
  if (inputMaxHealthPotionPurchases) inputMaxHealthPotionPurchases.value = health.maxPurchases ?? 0;
  if (healthPotsPurchasedCount) healthPotsPurchasedCount.textContent = String(health.purchasedCount ?? 0);
  if (chkAllowManaPotions) chkAllowManaPotions.checked = mana.allowPotions === true;
  if (selectManaPotionPriority) selectManaPotionPriority.value = mana.priority || 'small';
  if (inputSmallManaPotLimit) inputSmallManaPotLimit.value = mana.potionLimits?.small ?? 0;
  if (inputLargeManaPotLimit) inputLargeManaPotLimit.value = mana.potionLimits?.large ?? 0;
  if (inputKeepManaMin) inputKeepManaMin.value = mana.keepMin ?? 0;
  if (inputKeepManaMax) inputKeepManaMax.value = mana.keepMax ?? 200;
  if (chkBuyManaPotion) chkBuyManaPotion.checked = mana.buyPotionIfNeeded === true;
  if (inputMaxManaPotionPurchases) inputMaxManaPotionPurchases.value = mana.maxPurchases ?? 0;
  if (manaPotsPurchasedCount) manaPotsPurchasedCount.textContent = String(mana.purchasedCount ?? 0);
  updatePotionPolicyControls();
  Object.entries(EQUIPMENT_SELECTS).forEach(([groupName, group]) => {
    Object.entries(group).forEach(([context, select]) => {
      if (select) select.value = config.equipment?.[groupName]?.[context] || 'default';
    });
  });
  const attackStrategy = config.combat?.attackStrategy || {};
  if (selectAttackMode) selectAttackMode.value = attackStrategy.mode || 'fixed';
  if (selectFixedAttack) selectFixedAttack.value = String(attackStrategy.fixedMultiplier || 1);
  if (selectMaxAttack) selectMaxAttack.value = String(attackStrategy.maxMultiplier || 200);
  if (inputAttackOvershoot) inputAttackOvershoot.value = attackStrategy.overshootPercent ?? 10;
  if (chkAdaptiveFailSafe) chkAdaptiveFailSafe.checked = attackStrategy.failSafeEnabled === true;
  if (inputAdaptiveFailSafePercent) inputAdaptiveFailSafePercent.value = attackStrategy.failSafePercent ?? 80;
  if (chkAdaptiveRequireTargetStamina) chkAdaptiveRequireTargetStamina.checked = attackStrategy.requireTargetStamina === true;
  if (chkAdaptiveNuke) chkAdaptiveNuke.checked = attackStrategy.nukeEnabled === true;
  configuredNukeAttack = attackStrategy.nukeAttack || 'auto';
  populateNukeAttackOptions(activeClassSkills);
  if (chkAdaptiveNukeAbilities) chkAdaptiveNukeAbilities.checked = attackStrategy.nukeAllowAbilities === true;
  if (chkAllowClassAbilities) chkAllowClassAbilities.checked = config.combat?.allowAbilities === true;
  allowedCombatAbilityIds = new Set(config.combat?.allowedAbilityIds || []);
  combatAbilityPolicies = config.combat?.abilityPolicies || {};
  if (activeClassSkills) renderUnlockedAbilities(activeClassSkills);
  const cubePvp = config.cubePvp || {};
  cubePvpTargetConfig = cubePvp;
  if (chkCubePvpEnabled) chkCubePvpEnabled.checked = cubePvp.enabled === true;
  if (selectCubePvpMode) selectCubePvpMode.value = 'server_ai';
  if (inputCubePvpRecheck) inputCubePvpRecheck.value = cubePvp.recheckMinutes ?? 5;
  renderCubePvpStatus?.(latestCubePvpStatus);
  refreshCubePvpStatus?.().catch(() => null);
  if (activeAccount && supportedModule === 'dungeons'
    && config.general?.dungeonMap === 'polyhedral_crucible') {
    refreshCubePvpTargets?.(true).catch(error => {
      appendLog('WARN', `Cube PvP could not be refreshed: ${error.message}`);
    });
  }
  updateAttackModuleRows();
}

function loadSchedulerConfiguration(config) {
  const attackIntervals = config.scheduler?.attackIntervals || {};
  if (inputGateMinDelaySeconds) inputGateMinDelaySeconds.value = ((attackIntervals.gate?.minDelay || 1050) / 1000).toFixed(2);
  if (inputGateMaxDelaySeconds) inputGateMaxDelaySeconds.value = ((attackIntervals.gate?.maxDelay || 1200) / 1000).toFixed(2);
  if (inputDungeonMinDelaySeconds) inputDungeonMinDelaySeconds.value = ((attackIntervals.dungeon?.minDelay || 1000) / 1000).toFixed(2);
  if (inputDungeonMaxDelaySeconds) inputDungeonMaxDelaySeconds.value = ((attackIntervals.dungeon?.maxDelay || 1200) / 1000).toFixed(2);
  if (inputLootScanIntervalMinutes) inputLootScanIntervalMinutes.value = Math.max(1, Number(config.scheduler?.lootScanIntervalMinutes) || 1);
  if (inputTargetScanIntervalSeconds) inputTargetScanIntervalSeconds.value = Math.max(1, Number(config.scheduler?.targetScanIntervalSeconds) || 1);
  savedDryRun = config.safety?.dryRun !== false;
  if (chkDryRun) chkDryRun.checked = savedDryRun;
  renderBotModeState();
}

if (btnSaveConfig) {
  btnSaveConfig.addEventListener('click', async () => {
    await flushPendingConfigSaves();
    btnSaveConfig.disabled = true;
    try {
      const result = await window.botAPI.exportConfig();
      if (result?.success) appendLog('INFO', `Saved configuration preset: ${result.fileName}`);
      else if (!result?.canceled) appendLog('ERROR', result?.error || 'Could not save configuration preset');
    } finally {
      btnSaveConfig.disabled = false;
    }
  });
}

if (btnLoadConfig) {
  btnLoadConfig.addEventListener('click', async () => {
    await flushPendingConfigSaves();
    btnLoadConfig.disabled = true;
    try {
      const result = await window.botAPI.importConfig();
      if (!result?.success) {
        if (!result?.canceled) appendLog('ERROR', result?.error || 'Could not load configuration preset');
        return;
      }
      monsterAreaCache.clear();
      lootAreaCache.clear();
      await refreshMonsterCatalog(false);
      loadHomeConfiguration(result.config);
      loadSchedulerConfiguration(result.config);
      markConfigDirty();
      appendLog('INFO', `Loaded configuration preset: ${result.fileName}`);
      if (currentTab === 'npcConfig') await loadMonsterWorkspace(true);
      if (currentTab === 'lootConfig') await loadLootWorkspace(true);
    } finally {
      btnLoadConfig.disabled = false;
      refreshLucideIcons();
    }
  });
}

btnExportAccountData?.addEventListener('click', async () => {
  const result = await window.botAPI.exportAccountData();
  if (result?.success) appendLog('INFO', `Exported account data: ${result.fileName}`);
  else if (!result?.canceled) appendLog('ERROR', result?.error || 'Account export failed');
});

btnRestoreAccountData?.addEventListener('click', async () => {
  const result = await window.botAPI.restoreAccountData();
  if (!result?.success) {
    if (!result?.canceled) appendLog('ERROR', result?.error || 'Account restore failed');
    return;
  }
  loadHomeConfiguration(result.config);
  loadSchedulerConfiguration(result.config);
  appendLog('INFO', `Restored account data from ${result.fileName}; pre-restore snapshot: ${result.snapshotFile}`);
});

populateEquipmentSetOptions();
populateProgressionSourceLists();
enhanceNumberInputs();
for (const control of [
  chkProgressionLootLeveling,
  chkProgressionLootDungeons,
  chkProgressionLootEvents,
  chkProgressionLootGates,
  chkProgressionChapterFallback,
  chkProgressionDrainBeforePots,
]) {
  if (control) control.addEventListener('change', saveProgressionSettings);
}
updateProgressionControls();
for (const control of [
  inputKeepStaminaMin, inputKeepStaminaMax, inputStopStaminaBelow, chkAllowStaminaPots,
  selectStaminaPotionPriority,
  inputSmallStaminaPotLimit, inputLargeStaminaPotLimit, inputFullStaminaPotLimit, inputAdventureStaminaPotLimit,
  inputSleepHealthBelow, inputMaxDeaths,
  chkUseHealingPotions, inputMaxHealingPotions, chkBuyHealthPotion, inputMaxHealthPotionPurchases,
  chkAllowManaPotions, selectManaPotionPriority, inputSmallManaPotLimit, inputLargeManaPotLimit,
  inputKeepManaMin, inputKeepManaMax, chkBuyManaPotion, inputMaxManaPotionPurchases,
]) {
  if (control) control.addEventListener('change', saveResourcePolicy);
}
chkAllowStaminaPots?.addEventListener('change', updatePotionPolicyControls);
chkAllowManaPotions?.addEventListener('change', updatePotionPolicyControls);
chkUseHealingPotions?.addEventListener('change', updatePotionPolicyControls);
updatePotionPolicyControls();
async function resetPurchaseCounter(type) {
  const result = await updateCanonicalConfig({ resources: { [type]: { purchasedCount: 0 } } });
  if (!result?.success) {
    appendLog('ERROR', result?.error || `Could not reset ${type} purchase counter`);
    return;
  }
  const counter = type === 'health' ? healthPotsPurchasedCount : manaPotsPurchasedCount;
  if (counter) counter.textContent = '0';
}
if (btnResetHealthPurchases) btnResetHealthPurchases.addEventListener('click', () => resetPurchaseCounter('health'));
if (btnResetManaPurchases) btnResetManaPurchases.addEventListener('click', () => resetPurchaseCounter('mana'));
Object.values(EQUIPMENT_SELECTS).flatMap(group => Object.values(group)).forEach(select => {
  if (select) select.addEventListener('change', saveEquipmentConfig);
});
if (selectAttackMode) {
  selectAttackMode.addEventListener('change', () => {
    updateAttackModuleRows();
    saveAttackStrategy();
  });
}
for (const control of [selectFixedAttack, selectMaxAttack, inputAttackOvershoot]) {
  if (control) control.addEventListener('change', saveAttackStrategy);
}
if (chkAllowClassAbilities) {
  chkAllowClassAbilities.addEventListener('change', () => {
    if (activeClassSkills) renderUnlockedAbilities(activeClassSkills);
    saveAttackStrategy();
  });
}
if (chkAdaptiveFailSafe) {
  chkAdaptiveFailSafe.addEventListener('change', () => {
    updateAttackModuleRows();
    saveAttackStrategy();
  });
}
if (inputAdaptiveFailSafePercent) inputAdaptiveFailSafePercent.addEventListener('change', saveAttackStrategy);
if (chkAdaptiveRequireTargetStamina) chkAdaptiveRequireTargetStamina.addEventListener('change', saveAttackStrategy);
if (chkAdaptiveNuke) {
  chkAdaptiveNuke.addEventListener('change', () => {
    updateAttackModuleRows();
    saveAttackStrategy();
  });
}
if (selectAdaptiveNukeAttack) selectAdaptiveNukeAttack.addEventListener('change', () => {
  configuredNukeAttack = selectAdaptiveNukeAttack.value || 'auto';
  saveAttackStrategy();
});
if (chkAdaptiveNukeAbilities) chkAdaptiveNukeAbilities.addEventListener('change', saveAttackStrategy);
if (btnRefreshAttackStrategy) btnRefreshAttackStrategy.addEventListener('click', () => refreshCombatData(true));
if (btnGearSetInfo) btnGearSetInfo.addEventListener('click', () => showLoadoutInfo('gear'));
if (btnPetSetInfo) btnPetSetInfo.addEventListener('click', () => showLoadoutInfo('pets'));
if (btnCloseLoadoutInfo) btnCloseLoadoutInfo.addEventListener('click', closeLoadoutInfo);
if (modalLoadoutInfo) {
  modalLoadoutInfo.addEventListener('click', event => {
    if (event.target === modalLoadoutInfo) closeLoadoutInfo();
  });
}
updateAttackModuleRows();
