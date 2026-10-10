const objectiveControlRequests = new WeakMap();
const objectiveMonsterReads = new Map();
let objectiveBoardGeneration = 0;

function objectiveRequest(select) {
  const generation = (objectiveControlRequests.get(select) || 0) + 1;
  objectiveControlRequests.set(select, generation);
  const account = accountRequestToken();
  return () => objectiveControlRequests.get(select) === generation
    && isCurrentAccountRequest(account) && select.isConnected !== false;
}

function readObjectiveMonsters(areaKey, force) {
  const account = accountRequestToken();
  const key = JSON.stringify([account.generation, account.account, areaKey, force === true]);
  if (!objectiveMonsterReads.has(key)) {
    const read = withUiTimeout(window.botAPI.listMonstersForArea(areaKey, force === true), 20000, uiText('Quest monsters'));
    objectiveMonsterReads.set(key, read);
    read.finally(() => { if (objectiveMonsterReads.get(key) === read) objectiveMonsterReads.delete(key); }).catch(() => {});
  }
  return objectiveMonsterReads.get(key);
}

function objectiveAreaOptions(type) {
  return type === 'dungeon' ? DUNGEON_MAPS : type === 'event' ? EVENT_MAPS : GATE_MAPS;
}

function replaceObjectiveOptions(select, entries, preferred = '') {
  if (!select) return;
  const options = entries.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  });
  select.replaceChildren(...options);
  if (preferred && entries.some(([value]) => value === preferred)) select.value = preferred;
}

async function loadObjectiveMonsters(areaKey, select, preferred = '', force = false) {
  if (!select) return;
  const current = objectiveRequest(select);
  delete select.dataset.pending;
  select.replaceChildren(new Option(areaKey ? uiText('Loading…') : uiText('Choose an area'), ''));
  if (!areaKey) return;
  select.dataset.pending = 'true';
  try {
    const result = await readObjectiveMonsters(areaKey, force);
    if (!current()) return;
    if (!result?.success) throw new Error(result?.error || uiText('Monster discovery failed'));
    const entries = (result.monsters || []).map(monster => [monster.key, monster.name]);
    replaceObjectiveOptions(select, entries, preferred);
    if (entries.length === 0) select.replaceChildren(new Option(uiText('No monsters found'), ''));
  } catch (error) {
    if (!current()) return;
    select.replaceChildren(new Option(uiText('Could not load monsters'), ''));
    appendLog('ERROR', `${areaKey}: ${error.message}`);
  } finally {
    if (!current()) return;
    if (preferred) {
      if (![...select.options].some(option => option.value === preferred)) select.add(new Option(preferred + uiText(' (saved)'), preferred));
      select.value = preferred;
    }
    delete select.dataset.pending;
  }
}

function renderBattlePassCounters(state) {
  if (!battlePassCounters) return;
  const objectives = state?.page?.objectives || [];
  battlePassCounters.replaceChildren(...objectives.map(objective => {
    const card = document.createElement('div'); card.className = 'objective-counter-card';
    const label = document.createElement('span'); label.textContent = objective.name || objective.type;
    const value = document.createElement('strong');
    value.textContent = `${formatNumber(objective.current)} / ${formatNumber(objective.required)}`;
    card.classList.toggle('is-complete', objective.completed === true);
    card.append(label, value);
    return card;
  }));
}

async function refreshBattlePass() {
  if (!activeAccount) return;
  setRefreshBusy(btnRefreshBattlePass, true);
  setWorkspaceStatus(battlePassStatus, uiText('Reading Battle Pass…'));
  try {
    const result = await window.botAPI.getBattlePass();
    if (!result?.success) throw new Error(result?.error || uiText('Battle Pass could not be read'));
    latestBattlePassState = result.state;
    renderBattlePassCounters(result.state);
    const page = result.state?.page || {};
    const levelText = Number.isFinite(Number(page.level)) ? ` · level ${Number(page.level).toLocaleString()}` : '';
    setWorkspaceStatus(battlePassStatus, page.completed === true
      ? uiText("Battle Pass complete{0}. Automation will not run it.", levelText)
      : page.active
        ? uiText("Daily objectives refreshed{0}.", levelText)
        : uiText('No active Battle Pass was recognized.'), page.active || page.completed ? 'success' : '');
  } catch (error) {
    setWorkspaceStatus(battlePassStatus, error.message, 'error');
  } finally {
    setRefreshBusy(btnRefreshBattlePass, false);
    refreshLucideIcons();
  }
}

async function loadBattlePassPolicy() {
  if (chkBattlePassEnabled) chkBattlePassEnabled.checked = battlePassConfig.enabled === true;
  if (chkBattlePassLootIfAchievable) chkBattlePassLootIfAchievable.checked = battlePassConfig.lootIfAchievable === true;
  if (chkBattlePassSafeCheck) chkBattlePassSafeCheck.checked = battlePassConfig.safeCheck === true;
  replaceObjectiveOptions(selectBattlePassArea, GATE_MAPS, battlePassConfig.areaKey || 'grakthar_3');
  await renderBattlePassTargets(selectBattlePassArea?.value);
}

function switchBattlePassSubview(name) {
  const targets = name === 'targets';
  subtabBattlePassGeneralBtn?.classList.toggle('active', !targets);
  subtabBattlePassTargetsBtn?.classList.toggle('active', targets);
  if (subviewBattlePassGeneral) subviewBattlePassGeneral.style.display = targets ? 'none' : 'flex';
  if (subviewBattlePassTargets) subviewBattlePassTargets.style.display = targets ? 'flex' : 'none';
  if (targets) renderBattlePassTargets(selectBattlePassArea?.value);
}

async function renderBattlePassTargets(areaKey, force = false) {
  if (!battlePassTargetsContent) return;
  battlePassTargetsContent.innerHTML = ("<div class=\"empty-state\">" + uiText("Loading Battle Pass targets…") + "</div>");
  if (!areaKey) return;
  try {
    const result = await window.botAPI.listMonstersForArea(areaKey);
    if (!result?.success) throw new Error(result?.error || uiText('Monster discovery failed'));
    const configured = battlePassConfig.targets?.[areaKey] || {};
    const monsters = result.monsters || [];
    if (monsters.length === 0) {
      battlePassTargetsContent.innerHTML = ("<div class=\"empty-state\">" + uiText("No monsters were found in this Target Gate.") + "</div>");
      return;
    }
    const header = document.createElement('div');
    header.className = 'objective-target-row objective-target-header';
    for (const label of [uiText('Monster'), uiText('Damage'), uiText('Priority'), uiText('Target')]) {
      const cell = document.createElement('span'); cell.textContent = label; header.append(cell);
    }
    const rows = monsters.map(monster => {
      const policy = configured[monster.key] || {};
      const row = document.createElement('div'); row.className = 'objective-target-row';
      row.dataset.monsterKey = monster.key;
      row.dataset.monsterName = monster.name;
      const name = document.createElement('strong'); name.textContent = monster.name;
      const damage = document.createElement('input'); damage.type = 'number'; damage.min = '300000'; damage.className = 'tree-input-sm'; damage.dataset.field = 'targetDamage'; damage.value = Math.max(300000, Number(policy.targetDamage) || 300000);
      const priority = document.createElement('input'); priority.type = 'number'; priority.min = '0'; priority.className = 'tree-input-sm'; priority.dataset.field = 'priority'; priority.value = Math.max(0, Number(policy.priority) || 0);
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'tree-checkbox'; enabled.dataset.field = 'enabled'; enabled.checked = policy.enabled === true;
      row.append(name, damage, priority, enabled);
      return row;
    });
    battlePassTargetsContent.replaceChildren(header, ...rows);
    enhanceNumberInputs(battlePassTargetsContent);
  } catch (error) {
    battlePassTargetsContent.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function saveBattlePassPatch(patch, button) {
  if (button) button.disabled = true;
  try {
    const result = await updateCanonicalConfig({ battlePass: patch });
    if (!result?.success) throw new Error(result?.error || uiText('Battle Pass settings could not be saved'));
    battlePassConfig = result.config?.battlePass || { ...battlePassConfig, ...patch };
    setWorkspaceStatus(battlePassStatus, uiText('Battle Pass settings saved.'), 'success');
    return true;
  } catch (error) {
    setWorkspaceStatus(battlePassStatus, error.message, 'error');
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveBattlePassGeneral() {
  await saveBattlePassPatch({
    enabled: chkBattlePassEnabled?.checked === true,
    areaKey: selectBattlePassArea?.value || 'grakthar_3',
    lootIfAchievable: chkBattlePassLootIfAchievable?.checked === true,
    safeCheck: chkBattlePassSafeCheck?.checked === true,
  });
}

async function saveBattlePassTargets() {
  const areaKey = selectBattlePassArea?.value || 'grakthar_3';
  const targets = JSON.parse(JSON.stringify(battlePassConfig.targets || {}));
  targets[areaKey] = {};
  for (const row of battlePassTargetsContent?.querySelectorAll('.objective-target-row[data-monster-key]') || []) {
    const targetDamage = Math.max(300000, Math.trunc(Number(row.querySelector('[data-field="targetDamage"]')?.value) || 300000));
    targets[areaKey][row.dataset.monsterKey] = {
      name: row.dataset.monsterName || row.dataset.monsterKey,
      targetDamage,
      priority: Math.max(0, Math.trunc(Number(row.querySelector('[data-field="priority"]')?.value) || 0)),
      enabled: row.querySelector('[data-field="enabled"]')?.checked === true,
    };
  }
  await saveBattlePassPatch({ targets });
}

selectBattlePassArea?.addEventListener('change', async () => {
  await saveBattlePassGeneral();
  await renderBattlePassTargets(selectBattlePassArea.value);
});
[chkBattlePassEnabled, chkBattlePassLootIfAchievable, chkBattlePassSafeCheck]
  .forEach(control => control?.addEventListener('change', saveBattlePassGeneral));
battlePassTargetsContent?.addEventListener('change', event => {
  if (event.target?.matches('[data-field]')) saveBattlePassTargets();
});
subtabBattlePassGeneralBtn?.addEventListener('click', () => switchBattlePassSubview('general'));
subtabBattlePassTargetsBtn?.addEventListener('click', () => switchBattlePassSubview('targets'));
btnRefreshBattlePass?.addEventListener('click', refreshBattlePass);
btnRefreshBattlePassTargets?.addEventListener('click', async () => {
  setRefreshBusy(btnRefreshBattlePassTargets, true);
  try {
    await renderBattlePassTargets(selectBattlePassArea?.value, true);
  } finally {
    setRefreshBusy(btnRefreshBattlePassTargets, false);
  }
});

function normalizedQuestText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function adventureQuestDraftKey(quest = {}) {
  const source = `${normalizedQuestText(quest.title)}\u0000${normalizedQuestText(quest.objective || quest.description)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `quest_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function adventureQuestDisplayText(quest = {}, policyId = null) {
  return String(
    quest.objective
    || quest.description
    || quest.title
    || (Number(policyId) > 0 ? `Quest ${policyId}` : 'Completed quest'),
  ).trim();
}

function adventureQuestPolicyFor(quest = {}) {
  const directId = Number(quest.policyId || quest.id);
  const direct = directId > 0 ? adventureQuestConfig.quests?.[String(directId)] : null;
  if (direct) return { policy: direct, draftKey: null, policyId: String(directId) };
  // Restore settings only for an exact, unambiguous authenticated card identity.
  // An ID-less card stays a draft; never infer a mutation ID from its title.
  const title = normalizedQuestText(quest.title);
  const objective = normalizedQuestText(quest.objective || quest.description);
  const matches = policy => title && objective
    && normalizedQuestText(policy.matchTitle) === title
    && normalizedQuestText(policy.matchObjective) === objective;
  const draftMatches = Object.entries(adventureQuestConfig.drafts || {}).filter(([,policy]) => matches(policy));
  if (draftMatches.length === 1) return { policy: draftMatches[0][1], draftKey: draftMatches[0][0], policyId: directId > 0 ? String(directId) : null };
  if (draftMatches.length > 1) return { policy: {}, draftKey: null, policyId: null };
  if (!(directId > 0)) {
    const known = Object.values(adventureQuestConfig.quests || {}).filter(matches);
    if (known.length === 1) return { policy: known[0], draftKey: adventureQuestDraftKey(quest), policyId: null };
  }
  return { policy: {}, draftKey: null, policyId: null };
}

async function populateQuestRequirement(type, areaKey, monsterKey, select, policy = {}) {
  if (!select) return;
  const current = objectiveRequest(select);
  delete select.dataset.pending;
  if (type === 'kill_loot') {
    select.replaceChildren(new Option(uiText('Not required'), ''));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  if (type === 'ability_use') {
    const abilities = (activeClassSkills?.unlockedSkills || []).filter(skill => skill?.owned === true && skill.passive !== true);
    replaceObjectiveOptions(select, [['', uiText('Choose ability')], ...abilities.map(skill => [String(skill.id), skill.name])], String(policy.abilityId || ''));
    return;
  }
  select.replaceChildren(new Option(uiText('Loading item loot…'), ''));
  if (!areaKey || !monsterKey) {
    select.replaceChildren(new Option(uiText('Choose a monster first'), ''));
    return;
  }
  try {
    select.dataset.pending = 'true';
    const result = await withUiTimeout(window.botAPI.getMonsterStats(areaKey, monsterKey, false), 20000, uiText('Quest item loot'));
    if (!current()) return;
    if (!result?.success) throw new Error(result?.error || uiText('Monster loot is unavailable'));
    const rewards = result.record?.stats?.possibleLoot || [];
    const options = [['', rewards.length ? 'Choose item' : 'No parsed item loot']];
    for (const reward of rewards) {
      const id = String(reward.itemId || reward.id || '');
      const value = id ? `id:${id}` : `name:${reward.name}`;
      options.push([value, reward.name]);
    }
    const preferred = policy.itemId ? `id:${policy.itemId}` : policy.itemName ? `name:${policy.itemName}` : '';
    replaceObjectiveOptions(select, options, preferred);
  } catch (error) {
    if (!current()) return;
    select.replaceChildren(new Option(error.message, ''));
  } finally {
    if (!current()) return;
    const saved = areaKey === policy.areaKey && monsterKey === policy.monsterKey
      ? (policy.itemId ? 'id:'+policy.itemId : policy.itemName ? 'name:'+policy.itemName : '') : '';
    if (saved) {
      if (![...select.options].some(option => option.value === saved)) select.add(new Option(policy.itemName || uiText('Saved item'), saved));
      select.value = saved;
    }
    delete select.dataset.pending;
  }
}

function questPolicyRow(quest, policy = {}, draftKey = null) {
  const row = document.createElement('div'); row.className = 'objective-quest-row';
  row.savedQuestPolicy = policy;
  row.questAccountToken = accountRequestToken();
  const policyId = Number(quest.policyId || quest.id);
  if (policyId > 0) row.dataset.questId = String(policyId);
  row.dataset.questPolicyKey = policyId > 0 ? String(policyId) : (draftKey || adventureQuestDraftKey(quest));
  if (draftKey) row.dataset.migrateDraftKey = draftKey;
  row.dataset.questTitle = quest.title || '';
  row.dataset.questObjective = quest.objective || quest.description || '';
  const title = document.createElement('strong'); title.className = 'objective-quest-name';
  title.textContent = adventureQuestDisplayText(quest, policyId);
  title.title = `${quest.title || (policyId > 0 ? `Quest ${policyId}` : 'Completed quest')} · ${quest.status || 'saved'}`;
  if (quest.cooldownUntil) {
    title.dataset.cooldownUntil = String(quest.cooldownUntil);
    title.dataset.cooldownLabel = title.textContent;
  }
  const addSelect = (name, entries, selected) => {
    const select = document.createElement('select'); select.className = 'tree-select'; select.dataset.field = name;
    replaceObjectiveOptions(select, entries, selected); row.append(select); return select;
  };
  row.append(title);
  const type = addSelect('type', [['kill_loot', uiText('Kill & Loot')], ['item_loot', uiText('Loot items')], ['ability_use', uiText('Use ability')]], policy.type || 'kill_loot');
  const area = getMonsterAreaFromCatalog(policy.areaKey);
  const source = addSelect('source', [['gate', uiText('Gate')], ['event', uiText('Event')], ['dungeon', uiText('Dungeon')]], area?.type || 'gate');
  const areaSelect = addSelect('areaKey', objectiveAreaOptions(source.value), policy.areaKey || '');
  const monster = addSelect('monsterKey', [['', uiText('Choose monster')]], policy.monsterKey || '');
  const addInput = (field, value, titleText, min = 0) => {
    const input = document.createElement('input'); input.className = 'tree-input-sm'; input.type = 'number'; input.min = String(min);
    input.dataset.field = field; input.value = value ?? 0; input.title = uiText(titleText); input.setAttribute('aria-label', input.title); row.append(input); return input;
  };
  addInput('targetDamage', policy.targetDamage || 1, 'Target damage', 1);
  addInput('requiredCount', policy.requiredCount || 1, 'Required count', 1);
  const requirement = addSelect('requirement', [['', uiText('Not required')]], '');
  addInput('priority', policy.priority || 0, 'Priority', 0);
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'tree-checkbox'; enabled.dataset.field = 'enabled'; enabled.checked = policy.enabled === true;
  enabled.title = uiText('Allow this quest'); enabled.setAttribute('aria-label', uiText('Allow this quest')); row.append(enabled);
  const refreshRequirement = () => populateQuestRequirement(type.value, areaSelect.value, monster.value, requirement, policy);
  type.addEventListener('change', async event => { event.stopPropagation(); await refreshRequirement(); queueAdventureQuestSave(row); });
  source.addEventListener('change', async event => {
    event.stopPropagation();
    replaceObjectiveOptions(areaSelect, objectiveAreaOptions(source.value));
    await loadObjectiveMonsters(areaSelect.value, monster);
    await refreshRequirement();
    queueAdventureQuestSave(row);
  });
  areaSelect.addEventListener('change', async event => { event.stopPropagation(); await loadObjectiveMonsters(areaSelect.value, monster); await refreshRequirement(); queueAdventureQuestSave(row); });
  monster.addEventListener('change', async event => { event.stopPropagation(); await refreshRequirement(); queueAdventureQuestSave(row); });
  row.addEventListener('change', () => queueAdventureQuestSave(row));
  loadObjectiveMonsters(areaSelect.value, monster, policy.monsterKey || '').then(refreshRequirement);
  updateObjectiveCooldowns(row);
  return row;
}

function getMonsterAreaFromCatalog(areaKey) {
  return monsterCatalog.find(area => area.key === areaKey) || null;
}

function renderAdventureQuests(state) {
  if (!adventureQuestList) return;
  const serverQuests = (state?.page?.quests || []).map(quest => ({ ...quest }));
  // The authenticated board is authoritative. Imported configuration may
  // contain policies for another account's board; never synthesize those stale
  // quests into this account's list.
  const rows = serverQuests;
  if (rows.length === 0) {
    adventureQuestList.innerHTML = ("<div class=\"empty-state\">" + uiText("No quest cards were exposed by the current page.") + "</div>");
    return;
  }
  const header = document.createElement('div');
  header.className = 'objective-quest-row objective-quest-header';
  for (const label of [uiText('Quest objective'), uiText('Type'), uiText('Where'), uiText('Area'), uiText('Mob'), uiText('Target damage'), uiText('Required count'), uiText('Item / ability'), uiText('Priority'), uiText('On')]) {
    const cell = document.createElement('span'); cell.textContent = label; header.append(cell);
  }
  adventureQuestList.replaceChildren(header, ...rows.map(quest => {
    const matched = quest.savedDraftKey
      ? { policy: adventureQuestConfig.drafts?.[quest.savedDraftKey] || {}, draftKey: quest.savedDraftKey, policyId: null }
      : adventureQuestPolicyFor(quest);
    if (matched.policyId && !(Number(quest.id) > 0)) quest.policyId = Number(matched.policyId);
    return questPolicyRow(quest, matched.policy, matched.draftKey);
  }));
  enhanceNumberInputs(adventureQuestList);
  updateObjectiveCooldowns(adventureQuestList);
}

function objectiveCooldownLabel(epochSeconds) {
  const remaining = Math.max(0, (Number(epochSeconds) * 1000) - Date.now());
  if (remaining <= 0) return 'available on next refresh';
  const totalMinutes = Math.ceil(remaining / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes}m left`;
}

function updateObjectiveCooldowns(root = adventureQuestList) {
  for (const element of root?.querySelectorAll?.('[data-cooldown-until]') || []) {
    const prefix = element.dataset.cooldownLabel;
    element.textContent = prefix
      ? `${prefix} · ${objectiveCooldownLabel(element.dataset.cooldownUntil)}`
      : uiText("cooldown · {0}", objectiveCooldownLabel(element.dataset.cooldownUntil));
  }
}

async function refreshAdventureQuests() {
  if (!activeAccount) return;
  const token = accountRequestToken();
  const generation = ++objectiveBoardGeneration;
  const current = () => isCurrentAccountRequest(token) && generation === objectiveBoardGeneration;
  setRefreshBusy(btnRefreshAdventureQuests, true);
  setWorkspaceStatus(adventureQuestStatus, uiText('Reading Adventurer Guild…'));
  try {
    const result = await window.botAPI.getAdventurerQuests();
    if (!current()) return;
    if (!result?.success) throw new Error(result?.error || uiText('Adventurer quests could not be read'));
    latestAdventureQuestState = result.state;
    renderAdventureQuests(result.state);
    const count = result.state?.page?.quests?.length || 0;
    setWorkspaceStatus(adventureQuestStatus, uiText("{0} quest card{1} read · {2}", count, count === 1 ? '' : 's', result.state.status.replaceAll('_', ' ')), 'success');
  } catch (error) {
    if (current()) setWorkspaceStatus(adventureQuestStatus, error.message, 'error');
  } finally {
    if (!current()) return;
    setRefreshBusy(btnRefreshAdventureQuests, false);
    refreshLucideIcons();
  }
}

btnRefreshAdventureQuests?.addEventListener('click', refreshAdventureQuests);
let adventureQuestSaveTimer = null;
let pendingAdventureQuestPatch = null;
let pendingAdventureQuestAccount = null;

function queueAdventureQuestSave(row) {
  if (row?.isConnected === false || (row?.questAccountToken && !isCurrentAccountRequest(row.questAccountToken))) return;
  pendingAdventureQuestAccount = accountRequestToken();
  if (row?.dataset) row.dataset.questDirty = "true";
  pendingAdventureQuestPatch = collectAdventureQuestSettings();
  adventureQuestConfig = pendingAdventureQuestPatch;
  clearTimeout(adventureQuestSaveTimer);
  adventureQuestSaveTimer = setTimeout(saveAdventureQuestSettings, 120);
}

function collectAdventureQuestSettings() {
    const quests = { ...(adventureQuestConfig.quests || {}) };
    const drafts = { ...(adventureQuestConfig.drafts || {}) };
    for (const row of adventureQuestList?.querySelectorAll('.objective-quest-row[data-quest-policy-key]') || []) {
      if (row.dataset.questDirty !== 'true') continue;
      const id = row.dataset.questId;
      const policyKey = row.dataset.questPolicyKey;
      if (!id && !policyKey) continue;
      const field = name => row.querySelector(`[data-field="${name}"]`);
      const type = field('type')?.value || 'kill_loot';
      const previous = (id ? quests[id] : drafts[policyKey]) || row.savedQuestPolicy || {};
      const savedRequirement = type === 'ability_use' ? String(previous.abilityId || '') : previous.itemId ? 'id:'+previous.itemId : previous.itemName ? 'name:'+previous.itemName : '';
      const requirementValue = field('requirement')?.dataset.pending === 'true' ? savedRequirement : field('requirement')?.value || '';
      const itemId = requirementValue.startsWith('id:') ? requirementValue.slice(3) : '';
      const itemName = requirementValue.startsWith('name:') ? requirementValue.slice(5) : '';
      const abilityId = type === 'ability_use' ? Math.max(0, Math.trunc(Number(requirementValue) || 0)) : 0;
      const policy = {
        enabled: field('enabled')?.checked === true,
        type,
        areaKey: field('areaKey')?.value || null,
        monsterKey: field('monsterKey')?.dataset.pending === 'true' ? previous.monsterKey || '' : field('monsterKey')?.value || '',
        targetDamage: Math.max(1, Math.trunc(Number(field('targetDamage')?.value) || 1)),
        requiredCount: Math.max(1, Math.trunc(Number(field('requiredCount')?.value) || 1)),
        itemId: type === 'item_loot' ? itemId : '',
        itemName: type === 'item_loot' ? itemName : '',
        abilityId,
        priority: Math.max(0, Math.trunc(Number(field('priority')?.value) || 0)),
        matchTitle: row.dataset.questTitle || '',
        matchObjective: row.dataset.questObjective || '',
      };
      if (id) {
        quests[id] = policy;
        if (row.dataset.migrateDraftKey) delete drafts[row.dataset.migrateDraftKey];
      } else {
        drafts[policyKey] = {
          ...policy,
          matchTitle: policy.matchTitle || 'Saved quest',
          matchObjective: policy.matchObjective,
        };
      }
    }
    return { quests, drafts };
}

async function saveAdventureQuestSettings() {
  const token = pendingAdventureQuestAccount || accountRequestToken();
  if (!isCurrentAccountRequest(token)) return;
  try {
    const { quests, drafts } = pendingAdventureQuestPatch || collectAdventureQuestSettings();
    pendingAdventureQuestPatch = null;
    const result = await updateCanonicalConfig({ adventureQuests: { quests, drafts } });
    if (!isCurrentAccountRequest(token)) return;
    if (!result?.success) throw new Error(result?.error || uiText('Quest settings could not be saved'));
    adventureQuestConfig = result.config?.adventureQuests || { quests, drafts };
    setWorkspaceStatus(adventureQuestStatus, uiText('Adventurer Quest settings saved.'), 'success');
  } catch (error) {
    if (isCurrentAccountRequest(token)) setWorkspaceStatus(adventureQuestStatus, error.message, 'error');
  }
}

function resetObjectiveWorkspace() {
  objectiveBoardGeneration++;
  objectiveMonsterReads.clear();
  clearTimeout(adventureQuestSaveTimer);
  pendingAdventureQuestPatch = null;
  pendingAdventureQuestAccount = null;
}

setInterval(() => updateObjectiveCooldowns(), 30000);
