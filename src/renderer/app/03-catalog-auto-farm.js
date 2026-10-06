function applyMonsterCatalog(areas = []) {
  monsterCatalog = Array.isArray(areas) ? areas : [];
  const options = type => monsterCatalog
    .filter(area => area.type === type && area.hidden !== true)
    .map(area => [area.key, area.label]);
  GATE_MAPS = options('gate');
  DUNGEON_MAPS = options('dungeon');
  EVENT_MAPS = options('event');
  populateProgressionSourceLists();
}

async function refreshMonsterCatalog(includeHidden = false) {
  const areas = await window.botAPI.getMonsterCatalog(includeHidden);
  if (!includeHidden) applyMonsterCatalog(areas);
  return Array.isArray(areas) ? areas : [];
}

function populateProgressionSourceList(container, areas) {
  if (!container) return;
  container.replaceChildren();
  for (const [areaKey, label] of areas) {
    const option = document.createElement('label');
    option.className = 'progression-source-option';
    const text = document.createElement('span');
    text.textContent = label;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tree-checkbox progression-source-checkbox';
    checkbox.dataset.areaKey = areaKey;
    checkbox.addEventListener('change', saveProgressionSettings);
    option.append(text, checkbox);
    container.append(option);
  }
}

function populateProgressionSourceLists() {
  populateProgressionSourceList(progressionDungeonSourceList, DUNGEON_MAPS);
  populateProgressionSourceList(progressionEventSourceList, EVENT_MAPS);
  populateProgressionSourceList(progressionGateSourceList, GATE_MAPS);
}

function selectedProgressionAreas(container) {
  return [...(container?.querySelectorAll('.progression-source-checkbox:checked') || [])]
    .map(checkbox => checkbox.dataset.areaKey)
    .filter(Boolean);
}

function loadProgressionAreaSelection(container, selectedAreas) {
  const selected = new Set(Array.isArray(selectedAreas) ? selectedAreas : []);
  for (const checkbox of container?.querySelectorAll('.progression-source-checkbox') || []) {
    checkbox.checked = selected.has(checkbox.dataset.areaKey);
  }
}

function updateProgressionSourceCount(container, output) {
  if (!output) return;
  const selected = selectedProgressionAreas(container).length;
  output.textContent = `${selected} selected`;
}
const MODULE_DESCRIPTIONS = {
  idle: {
    title: 'Idle module',
    body: 'Does not start automated combat or chapter actions. Account authentication, resource statistics, and background synchronization remain available.',
  },
  gates: {
    title: 'Gates module',
    body: 'Scans the selected Gate and considers only enabled Targets. Lower priority numbers run first, Minimum HP filters instances, configured quick sets are applied before combat, and target-authorized Stamina potions obey the global permission and per-type limits.',
  },
  dungeons: {
    title: 'Dungeons module',
    body: 'Finds the selected Dungeon through its verified server routes and considers only enabled live Targets. Shadowbridge and Castle follow the locations emitted by the Guild Dungeons index; Cube follows its verified PvE locations 11–14. It never invents room numbers.',
  },
  event: {
    title: 'Event module',
    body: 'Runs The Black Crown Ascends from its fixed Event wave. It uses the same Target, Combat, Health, pacing, and normal battle rules as Gates.',
  },
  boss_hunt: {
    title: 'Boss Hunt module',
    body: 'Considers enabled Boss Hunt rows across every accessible Gate and Event. Its settings and completion counters are independent from Targets, Battle Pass, and Adventurer Quests.',
  },
  auto_farm: {
    title: 'Auto Farm module',
    body: 'Synchronizes the selected Gate or Event targets with the game server Auto Farm and then enables it. Normal Combat, Health, Mana, Stamina, Looting, and Progression decisions are suspended until this module is stopped or changed.',
  },
  battle_pass: {
    title: 'Battle Pass module',
    body: 'Reads the two daily Battle Pass counters, spends Stamina through normal combat, and attacks the configured Lizard target until the loot counter completes. Server Auto Farm is never counted and reward claiming remains manual.',
  },
  adventure_quests: {
    title: 'Adv Quests module',
    body: 'Reads the current Adventurer Guild quest, follows the saved quest classification and target policy, claims qualifying loot when required, and turns in a verified completed quest. Lower priority numbers are accepted first.',
  },
};
const ATTACK_MODULE_DESCRIPTIONS = {
  fixed: {
    title: 'Fixed attack module',
    body: 'Uses the selected multiplier as the normal-hit fallback. An explicitly allowed class ability may replace it when its learned x1-based estimate fits the remaining target and its Mana/Stamina policy passes. Normal multiplier limits do not authorize class abilities.',
  },
  adaptive: {
    title: 'Adaptive attack module',
    body: 'Learns x1 damage for the current player stats, monster, Gear, and Pets, then compares permitted attacks under the target and resource rules. Nuke enemy works in Gates, Events, or Dungeons: it can use a selected finishing hit, or Auto can choose the smallest permitted hit that reaches the remaining contribution when shared monster HP is too low. If none can reach it, that transient monster is skipped. Exact server-reported total damage still decides completion.',
  },
};

function enhanceNumberInput(input) {
  if (!input || input.dataset.customStepper === 'true') return;
  input.dataset.customStepper = 'true';
  const wrapper = document.createElement('span');
  wrapper.className = 'number-stepper';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  for (const direction of [1, -1]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `number-stepper-btn ${direction > 0 ? 'number-stepper-up' : 'number-stepper-down'}`;
    button.append(createLucideIcon(direction > 0 ? 'plus' : 'minus'));
    button.tabIndex = -1;
    button.setAttribute('aria-label', `${direction > 0 ? 'Increase' : 'Decrease'} ${input.getAttribute('aria-label') || 'value'}`);
    button.addEventListener('click', () => {
      if (direction > 0) input.stepUp(); else input.stepDown();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    wrapper.appendChild(button);
    refreshLucideIcons(button);
  }
}

function enhanceNumberInputs(root = document) {
  root.querySelectorAll('input[type="number"]').forEach(enhanceNumberInput);
}

function showInfoDialog(description) {
  if (!modalModuleInfo) return;
  if (moduleInfoTitle) moduleInfoTitle.textContent = description.title;
  if (moduleInfoBody) moduleInfoBody.textContent = description.body;
  modalModuleInfo.style.display = 'flex';
}

const PAGE_HELP = Object.freeze({
  setup: {
    title: 'Bot Setup guide',
    body: 'Module chooses the activity Veybot runs. Gate, Dungeon, or Event chooses where that module works. Progression config selects the resource and leveling policy.\n\nStamina controls when ordinary combat may continue. Health controls healing, death limits, and optional potion buying. Mana controls when class abilities may restore Mana. A Max Deaths value of 0 means unlimited.',
  },
  combat: {
    title: 'Combat guide',
    body: 'Fixed always requests the selected normal hit when it is affordable. Adaptive learns damage from server results and chooses a permitted hit for the remaining target.\n\nAllowed target overshoot is how far an Adaptive estimate may exceed the remaining target damage. Force x1 near target overrides that choice after Target progress reached is met. For example, 80% means all later normal hits are x1.\n\nClass abilities remain unused until you classify each one as Attack, Buff, Debuff, or Passive and explicitly allow it.',
  },
  progression: {
    title: 'Progression guide',
    body: 'Progression decides whether to bank loot for a level, farm Chapters, use an allowed Stamina potion, or wait. Loot is claimed only when verified eligible rewards can produce a level. Veybot always drains usable Stamina before claiming that level-up loot.\n\nSource lists decide which Dungeons, Events, and Gates may contribute loot. Chapter fallback and potion limits are separate fallback permissions.',
  },
  chapters: {
    title: 'Chapter farming guide',
    body: 'Manual posts the requested number of chapter reactions immediately. Automatic only permits Progression to use Chapters as a fallback; Allow Chapter fallback must also be enabled in Progression.\n\nAdd a manga using its title page URL, then Refresh after new chapters are published. Safety limits stop a manual run before Max Stamina, the configured farm target, or an hourly refill window. Each confirmed reaction restores 2 Stamina and is recorded once for the current 12-hour reward cycle.',
  },
});

function addPageHelpTooltips(root, descriptions = {}) {
  if (!root) return;
  for (const row of root.querySelectorAll('.form-tree-row')) {
    const label = row.querySelector('.form-tree-label')?.textContent?.replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const control = row.querySelector('input, select, button');
    row.title = descriptions[control?.id]
      || `${label}: configure how this page behaves. Disabled rows do not apply to the selected module or parent option.`;
  }
}

function showTabGuideOnce(tab, accountName) {
  const page = { botSetup: 'setup', combat: 'combat', energyFarm: 'progression' }[tab];
  const identity = String(accountName || '').trim();
  if (!page || !identity || !modalModuleInfo) return;
  const key = `veybot:onboarding:${encodeURIComponent(identity)}:${page}:v2`;
  if (localStorage.getItem(key) === 'seen') return;
  localStorage.setItem(key, 'seen');
  showInfoDialog(PAGE_HELP[page]);
}

btnBotSetupPageInfo?.addEventListener('click', () => showInfoDialog(PAGE_HELP.setup));
btnCombatPageInfo?.addEventListener('click', () => showInfoDialog(PAGE_HELP.combat));
btnProgressionPageInfo?.addEventListener('click', () => showInfoDialog(PAGE_HELP.progression));
btnChaptersPageInfo?.addEventListener('click', () => showInfoDialog(PAGE_HELP.chapters));

addPageHelpTooltips(document.getElementById('subviewHomeGeneral'), {
  selectGeneralModule: 'Choose the activity Veybot should run. Settings unrelated to that module stay visible but disabled.',
  selectGeneralMap: 'Choose the Gate for ordinary Gate combat. Switching modules preserves your last Gate choice.',
  selectGeneralDungeonMap: 'Choose the Dungeon whose configured targets may be attacked.',
  selectGeneralEventMap: 'Choose an Event added through Settings → Gates. Event routes use event and wave identifiers.',
  inputKeepStaminaMin: 'Ordinary combat preserves this percentage of maximum Stamina. Progression can spend below it when an allowed refill is available.',
  inputKeepStaminaMax: 'Upper percentage of the base Stamina range.',
  inputStopStaminaBelow: 'Stop automation when Stamina falls below this percentage. A value of 0 disables this hard stop.',
  inputSleepHealthBelow: 'At or below this HP percentage, heal before attacking again. Allowed Healing Potions take priority over timed healing.',
  inputMaxDeaths: 'Stop after this many verified combat deaths. Use 0 for unlimited deaths.',
  chkUseHealingPotions: 'Allow a verified Healing Potion before timed healing when HP reaches the healing threshold.',
  inputMaxHealingPotions: 'Maximum Healing Potions Veybot may use during this run.',
  inputSmallManaPotLimit: 'Maximum Small Mana Potions Veybot may consume during this run.',
  inputLargeManaPotLimit: 'Maximum Large Mana Potions Veybot may consume during this run.',
  chkBuyHealthPotion: 'Allow buying a Healing Potion when needed, within the configured purchase count.',
  inputMaxHealthPotionPurchases: 'Maximum Healing Potions Veybot may purchase. A confirmed purchase increases the counter.',
  chkAllowManaPotions: 'Allow Mana potions to refill from the minimum Mana setting toward the maximum.',
  selectManaPotionPriority: 'Try this Mana potion first, then another allowed potion if needed.',
  inputKeepManaMin: 'Begin Mana restoration at this value. Values use increments of 20 Mana.',
  inputKeepManaMax: 'Stop restoring Mana at this value. Small Mana potions may be consumed in batches of up to 10.',
  chkBuyManaPotion: 'Allow buying Small Mana Potions when needed, within the configured purchase count.',
  inputMaxManaPotionPurchases: 'Maximum Mana Potions Veybot may purchase. A confirmed purchase increases the counter.',
});
addPageHelpTooltips(document.getElementById('subviewHomeEquipment'), {
  inputAttackOvershoot: 'Adaptive mode may exceed the remaining target damage by at most this percentage when choosing a normal hit.',
  chkAdaptiveFailSafe: 'Force normal attacks to x1 after the configured target-progress threshold is reached.',
  inputAdaptiveFailSafePercent: 'The target contribution percentage at which Force x1 begins. This only applies when Force x1 near target is enabled.',
  selectAttackModule: 'Fixed uses the selected hit. Adaptive uses learned damage to choose a hit for the remaining target.',
  selectFixedAttack: 'The normal hit requested in Fixed mode, with a smaller affordable hit when needed.',
  selectAdaptiveMaxAttack: 'Largest normal hit Adaptive may choose. Class abilities have separate permissions.',
  chkRequireTargetStamina: 'Wait for an allowed refill if current Stamina cannot reach the target damage. Chapter fallback and potions remain available.',
  chkAllowClassAbilities: 'Allow only abilities you have classified and enabled. Select and Passive are never executed.',
});
addPageHelpTooltips(document.getElementById('subviewStaminaGeneral'));
addPageHelpTooltips(document.getElementById('subviewChaptersFarm'), {
  selectFarmModule: 'Manual runs only when you press Start. Automatic allows Progression to use Chapters as a fallback when its separate permission is enabled.',
  inputManualChapterCount: 'Number of confirmed chapter reactions to post in this manual run.',
  chkStopMaxStamina: 'Stop manual farming when current Stamina reaches the account maximum.',
  inputMaxStaminaFarm: 'Stop manual farming when current farmed-energy progress reaches this value.',
  inputStopHourlyStaminaMin: 'Do not begin another manual reaction this many minutes before the hourly Stamina refill.',
  selectReactionType: 'Reaction sent to each chapter. Random chooses one of the five reactions for every request.',
  inputMangaTarget: 'Use a supported manga title page URL. Veybot reads its real chapter links instead of guessing their route.',
});

if (btnModuleInfo) btnModuleInfo.addEventListener('click', () => {
  showInfoDialog(MODULE_DESCRIPTIONS[selectGeneralModule?.value] || MODULE_DESCRIPTIONS.idle);
});
if (btnAttackModuleInfo) btnAttackModuleInfo.addEventListener('click', () => {
  showInfoDialog(ATTACK_MODULE_DESCRIPTIONS[selectAttackMode?.value] || ATTACK_MODULE_DESCRIPTIONS.fixed);
});
if (btnCloseModuleInfo) btnCloseModuleInfo.addEventListener('click', () => { modalModuleInfo.style.display = 'none'; });
if (modalModuleInfo) {
  modalModuleInfo.addEventListener('click', event => {
    if (event.target === modalModuleInfo) modalModuleInfo.style.display = 'none';
  });
}

function replaceMapOptions(select, maps, preferred = null) {
  if (!select) return;
  const current = select.value;
  select.replaceChildren(...maps.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value || '';
    option.textContent = label;
    return option;
  }));
  const requested = preferred || current;
  if (requested && [...select.options].some(option => option.value === requested)) select.value = requested;
}

function updateGeneralMaps(preferredMap = null, preferredDungeonMap = null, preferredGateMap = null, preferredEventMap = null) {
  const module = selectGeneralModule?.value || 'idle';
  const dungeonOnly = module === 'dungeons';
  const gateOnly = module === 'gates';
  const eventOnly = module === 'event';
  const setModuleAvailability = (row, select, enabled) => {
    if (row) {
      row.style.display = 'flex';
      row.classList.toggle('module-setting-disabled', !enabled);
      row.setAttribute('aria-disabled', String(!enabled));
    }
    if (select) select.disabled = !enabled;
  };
  setModuleAvailability(rowGeneralMap, selectGeneralMap, gateOnly);
  setModuleAvailability(rowGeneralDungeonMap, selectGeneralDungeonMap, dungeonOnly);
  setModuleAvailability(rowGeneralGateMap, selectGeneralGateMap, false);
  setModuleAvailability(rowGeneralEventMap, selectGeneralEventMap, eventOnly);
  replaceMapOptions(selectGeneralMap, GATE_MAPS, preferredMap);
  replaceMapOptions(selectGeneralDungeonMap, DUNGEON_MAPS, preferredDungeonMap);
  replaceMapOptions(selectGeneralGateMap, GATE_MAPS, preferredGateMap);
  replaceMapOptions(selectGeneralEventMap, EVENT_MAPS, preferredEventMap);
  updateAutoFarmIsolationUi();
}

function updateAutoFarmIsolationUi() {
  const isolated = selectGeneralModule?.value === 'auto_farm';
  const progressionProfileRow = selectProgressionProfileSetup?.closest('.form-tree-row');
  progressionProfileRow?.classList.toggle('module-setting-disabled', isolated);
  progressionProfileRow?.setAttribute('aria-disabled', String(isolated));
  if (selectProgressionProfileSetup) selectProgressionProfileSetup.disabled = isolated;
  for (const sectionId of ['sectionGeneralStamina', 'sectionGeneralHealth', 'sectionGeneralMana']) {
    const section = document.getElementById(sectionId);
    if (!section) continue;
    section.classList.toggle('module-setting-disabled', isolated);
    section.setAttribute('aria-disabled', String(isolated));
    for (const control of section.querySelectorAll('input, select, button')) control.disabled = isolated;
  }
  if (subtabStaminaGeneralBtn) subtabStaminaGeneralBtn.disabled = isolated;
  if (subtabProgressionLootBtn) subtabProgressionLootBtn.disabled = isolated;
  if (btnRefreshAvailableLoot) btnRefreshAvailableLoot.disabled = isolated;
  updateProgressionControls();
}

function autoFarmServerTargetsConfig() {
  return Object.fromEntries([...autoFarmServerTargetDrafts.values()].map(target => [String(target.monsterId), {
    monsterName: target.monsterName,
    areaKey: target.areaKey || null,
    enabled: target.enabled === true,
    damageMode: Number(target.damageMode) === 0 ? 0 : 1,
    minDamage: Math.max(0, Math.trunc(Number(target.minDamage) || 0)),
    maxStack: Math.min(250, Math.max(1, Math.trunc(Number(target.maxStack) || 1))),
  }]));
}

function renderAutoFarmProgress(state) {
  if (autoFarmServerState) {
    autoFarmServerState.textContent = state?.enabled === true ? 'Running' : 'Paused';
    autoFarmServerState.classList.toggle('is-running', state?.enabled === true);
  }
  if (!autoFarmProgressGrid) return;
  const settings = state?.settings || {};
  const counters = state?.counters || {};
  const rows = [
    ['Monsters', counters.monsters, settings.totalMonsters],
    ['HP Pots', counters.hpPotions, settings.hpPotionLimit],
    ['Small Stam Pots +20', counters.staminaPotions?.small, settings.staminaPotionLimits?.small],
    ['Large Stam Pots', counters.staminaPotions?.large, settings.staminaPotionLimits?.large],
    ['Full Stam Pots', counters.staminaPotions?.full, settings.staminaPotionLimits?.full],
    ['Adventurer Stam Pots', counters.staminaPotions?.adventure, settings.staminaPotionLimits?.adventure],
  ];
  const fragment = document.createDocumentFragment();
  for (const [label, currentValue, limitValue] of rows) {
    const current = Math.max(0, Math.trunc(Number(currentValue) || 0));
    const limit = Math.max(0, Math.trunc(Number(limitValue) || 0));
    const card = document.createElement('div'); card.className = 'auto-farm-progress-card';
    const heading = document.createElement('div'); heading.className = 'auto-farm-progress-heading';
    const name = document.createElement('span'); name.textContent = label;
    const value = document.createElement('strong'); value.textContent = `${formatNumber(current)} / ${formatNumber(limit)}`;
    const track = document.createElement('div'); track.className = 'auto-farm-progress-track';
    const fill = document.createElement('span'); fill.className = 'auto-farm-progress-fill';
    fill.style.width = limit > 0 ? `${Math.min(100, (current / limit) * 100)}%` : '0%';
    if (limit === 0) card.classList.add('has-zero-limit');
    heading.append(name, value); track.append(fill); card.append(heading, track); fragment.append(card);
  }
  autoFarmProgressGrid.replaceChildren(fragment);
}

function autoFarmNameKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function renderAutoFarmServerTargets(state) {
  if (!autoFarmServerTargetsContent) return;
  autoFarmServerTargetDrafts = new Map((state?.targets || []).map(target => [String(target.targetId), { ...target }]));
  if (autoFarmServerTargetDrafts.size === 0) {
    const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'No server Auto Farm targets have been added yet.';
    autoFarmServerTargetsContent.replaceChildren(empty); return;
  }
  const groups = new Map();
  for (const pair of autoFarmServerTargetDrafts) {
    const areaKey = pair[1].areaKey || 'unknown';
    if (!groups.has(areaKey)) groups.set(areaKey, []);
    groups.get(areaKey).push(pair);
  }
  const fragment = document.createDocumentFragment();
  for (const [areaKey, targets] of groups) {
    const area = monsterCatalog.find(item => item.key === areaKey);
    const group = document.createElement('details');
    group.className = 'auto-farm-target-group';
    group.open = true;
    const summary = document.createElement('summary');
    summary.textContent = area?.label || targets[0]?.[1]?.areaName || 'Unassigned targets';
    group.append(summary);
    const table = document.createElement('div'); table.className = 'auto-farm-server-target-table';
    const header = document.createElement('div'); header.className = 'auto-farm-server-target-row auto-farm-server-target-header';
    for (const [label, title] of [['Monster', 'Server target monster'], ['ID', 'Server monster ID'], ['Damage', 'Minimum damage target'], ['Stack', 'Maximum stack per hit'], ['Enabled', 'Send IS_ENABLED=1 when checked, otherwise 0'], ['', 'Remove target from server Auto Farm']]) {
      const cell = document.createElement('span'); cell.textContent = label; cell.title = title; header.append(cell);
    }
    table.append(header);
    for (const [targetId, target] of targets) {
    const row = document.createElement('div'); row.className = 'auto-farm-server-target-row';
    const name = document.createElement('span'); name.textContent = target.monsterName || `Monster ${target.monsterId}`; name.title = name.textContent;
    const id = document.createElement('span'); id.textContent = target.monsterId;
    const damage = document.createElement('input'); damage.type = 'number'; damage.min = '0'; damage.value = target.minDamage || 0; damage.className = 'tree-input-sm'; damage.title = 'Minimum damage sent with this server target.';
    const stack = document.createElement('input'); stack.type = 'number'; stack.min = '1'; stack.max = '250'; stack.value = target.maxStack || 1; stack.className = 'tree-input-sm'; stack.title = 'Maximum server Auto Farm stack for this target.';
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'tree-checkbox'; enabled.checked = target.enabled === true; enabled.title = 'Checked sends IS_ENABLED=1; unchecked sends IS_ENABLED=0.';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-sm auto-farm-remove-target'; remove.append(createLucideIcon('trash-2')); remove.title = 'Remove this target from server Auto Farm'; remove.setAttribute('aria-label', remove.title);
    const update = () => autoFarmServerTargetDrafts.set(targetId, { ...target, minDamage: nonNegativeInputValue(damage), maxStack: Math.min(250, Math.max(1, nonNegativeInputValue(stack))), enabled: enabled.checked });
    for (const control of [damage, stack, enabled]) control.addEventListener('change', update);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      const result = await window.botAPI.removeAutoFarmTarget(targetId);
      if (!result?.success) {
        appendLog('ERROR', result?.error || `Could not remove ${target.monsterName || 'Auto Farm target'}`);
        remove.disabled = false;
        return;
      }
      autoFarmConfig = (await window.botAPI.getConfig())?.autoFarm || autoFarmConfig;
      renderAutoFarmServerTargets(result.state);
      appendLog('INFO', `Removed ${target.monsterName || 'Auto Farm target'} from server Auto Farm.`);
    });
    row.append(name, id, damage, stack, enabled, remove); table.append(row);
    }
    group.append(table);
    fragment.append(group);
  }
  autoFarmServerTargetsContent.replaceChildren(fragment);
  enhanceNumberInputs(autoFarmServerTargetsContent);
  refreshLucideIcons(autoFarmServerTargetsContent);
}

async function loadAutoFarmServerState(force = false) {
  if (!activeAccount) return;
  const requestToken = accountRequestToken();
  if (autoFarmServerTargetsContent) autoFarmServerTargetsContent.innerHTML = '<div class="empty-state">Reading server Auto Farm targets…</div>';
  const result = await window.botAPI.getAutoFarmState(force === true);
  if (!isCurrentAccountRequest(requestToken)) return;
  if (!result?.success) {
    if (autoFarmServerTargetsContent) autoFarmServerTargetsContent.innerHTML = '<div class="empty-state"></div>';
    if (autoFarmServerTargetsContent?.firstElementChild) autoFarmServerTargetsContent.firstElementChild.textContent = result?.error || 'Auto Farm state is unavailable.';
    if (autoFarmProgressGrid) {
      const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = result?.error || 'Auto Farm progress is unavailable.';
      autoFarmProgressGrid.replaceChildren(empty);
    }
    if (autoFarmServerState) autoFarmServerState.textContent = 'Unavailable';
    return;
  }
  const settings = result.state?.settings || {};
  if (inputAutoFarmTotal) inputAutoFarmTotal.value = settings.totalMonsters ?? 0;
  if (inputAutoFarmHpPots) inputAutoFarmHpPots.value = settings.hpPotionLimit ?? 0;
  if (inputAutoFarmSmallPots) inputAutoFarmSmallPots.value = settings.staminaPotionLimits?.small ?? 0;
  if (inputAutoFarmLargePots) inputAutoFarmLargePots.value = settings.staminaPotionLimits?.large ?? 0;
  if (inputAutoFarmFullPots) inputAutoFarmFullPots.value = settings.staminaPotionLimits?.full ?? 0;
  if (inputAutoFarmAdventurePots) inputAutoFarmAdventurePots.value = settings.staminaPotionLimits?.adventure ?? 0;
  if (selectAutoFarmPotionPriority) selectAutoFarmPotionPriority.value = String(settings.priorityItemId ?? '0');
  if (chkAutoFarmLootLevel) chkAutoFarmLootLevel.checked = settings.autoLootToLevel === true;
  if (inputAutoFarmExpLeft) inputAutoFarmExpLeft.value = settings.expLeftPercent ?? 100;
  renderAutoFarmProgress(result.state);
  renderAutoFarmServerTargets(result.state);
  setAutoFarmSettingsDirty(false);
}

function setAutoFarmSettingsDirty(dirty = true) {
  autoFarmSettingsDirty = dirty === true;
  btnSaveAutoFarm?.classList.toggle('has-pending-changes', autoFarmSettingsDirty);
  if (btnSaveAutoFarm) btnSaveAutoFarm.title = autoFarmSettingsDirty
    ? 'Save changed Auto Farm settings to the server'
    : 'Auto Farm settings match the server';
}

async function saveAutoFarmSettings() {
  if (btnSaveAutoFarm) btnSaveAutoFarm.disabled = true;
  try {
    const serverByName = new Map([...autoFarmServerTargetDrafts.values()].map(target => [autoFarmNameKey(target.monsterName), target]));
    const mapPatches = {};
    for (const [areaKey, entries] of Object.entries(autoFarmConfig.maps || {})) {
      for (const [monsterKey, entry] of Object.entries(entries || {})) {
        const serverTarget = serverByName.get(autoFarmNameKey(entry.name || monsterKey));
        if (!serverTarget) continue;
        mapPatches[areaKey] ||= {};
        mapPatches[areaKey][monsterKey] = {
          enabled: serverTarget.enabled === true,
          targetDamage: Math.max(0, Math.trunc(Number(serverTarget.minDamage) || 0)),
          maxStack: Math.min(250, Math.max(1, Math.trunc(Number(serverTarget.maxStack) || 1))),
        };
      }
    }
    const result = await updateCanonicalConfig({
      autoFarm: {
        settings: {
          totalMonsters: nonNegativeInputValue(inputAutoFarmTotal),
          hpPotionLimit: nonNegativeInputValue(inputAutoFarmHpPots),
          staminaPotionLimits: {
            small: nonNegativeInputValue(inputAutoFarmSmallPots),
            large: nonNegativeInputValue(inputAutoFarmLargePots),
            full: nonNegativeInputValue(inputAutoFarmFullPots),
            adventure: nonNegativeInputValue(inputAutoFarmAdventurePots),
          },
          priorityItemId: selectAutoFarmPotionPriority?.value || '0',
          autoLootToLevel: chkAutoFarmLootLevel?.checked === true,
          expLeftPercent: percentageInputValue(inputAutoFarmExpLeft),
        },
        maps: mapPatches,
        targetPolicies: autoFarmServerTargetsConfig(),
      },
    });
    if (result?.success) {
      autoFarmConfig = result.config?.autoFarm || autoFarmConfig;
      const serverResult = await window.botAPI.saveAutoFarmToServer();
      if (!serverResult?.success) throw new Error(serverResult?.error || 'Server Auto Farm save failed');
      renderAutoFarmServerTargets(serverResult.state);
      setAutoFarmSettingsDirty(false);
      appendLog('INFO', `Auto Farm settings applied to the server (${serverResult.targets} enabled target(s)).`);
    } else appendLog('ERROR', result?.error || 'Could not save Auto Farm settings');
  } catch (error) {
    appendLog('ERROR', `Auto Farm save failed: ${error.message}`);
  } finally {
    if (btnSaveAutoFarm) btnSaveAutoFarm.disabled = false;
  }
}

btnSaveAutoFarm?.addEventListener('click', saveAutoFarmSettings);
btnRefreshAutoFarmServer?.addEventListener('click', () => loadAutoFarmServerState(true));
for (const control of [
  inputAutoFarmTotal, inputAutoFarmHpPots, inputAutoFarmSmallPots, inputAutoFarmLargePots,
  inputAutoFarmFullPots, inputAutoFarmAdventurePots, selectAutoFarmPotionPriority,
  chkAutoFarmLootLevel, inputAutoFarmExpLeft,
]) {
  control?.addEventListener('change', () => setAutoFarmSettingsDirty(true));
  if (control?.matches('input[type="number"]')) control.addEventListener('input', () => setAutoFarmSettingsDirty(true));
}

async function saveGeneralSelection() {
  const module = selectGeneralModule?.value || 'idle';
  const result = await updateCanonicalConfig({
    general: {
      module,
      map: module === 'gates'
        ? selectGeneralMap?.value || null
        : module === 'dungeons'
          ? selectGeneralDungeonMap?.value || null
          : module === 'event'
            ? selectGeneralEventMap?.value || null
            : null,
      primaryGateMap: selectGeneralMap?.value || null,
      dungeonMap: selectGeneralDungeonMap?.value || null,
      gateMap: selectGeneralGateMap?.value || null,
      eventMap: selectGeneralEventMap?.value || null,
    },
  });
  if (!result?.success) appendLog('ERROR', result?.error || 'Could not save Module and Map');
}

if (selectGeneralModule) selectGeneralModule.addEventListener('change', () => {
  updateGeneralMaps(null, selectGeneralDungeonMap?.value || null, selectGeneralGateMap?.value || null, selectGeneralEventMap?.value || null);
  saveGeneralSelection();
});
if (selectGeneralMap) selectGeneralMap.addEventListener('change', saveGeneralSelection);
if (selectGeneralDungeonMap) selectGeneralDungeonMap.addEventListener('change', saveGeneralSelection);
if (selectGeneralGateMap) selectGeneralGateMap.addEventListener('change', saveGeneralSelection);
if (selectGeneralEventMap) selectGeneralEventMap.addEventListener('change', saveGeneralSelection);
updateGeneralMaps();

const EQUIPMENT_SELECTS = {
  gear: { pve: selectGearPve },
  pets: { pve: selectPetsPve },
};
