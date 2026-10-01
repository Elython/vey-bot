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

async function loadObjectiveMonsters(areaKey, select, preferred = '') {
  if (!select) return;
  select.replaceChildren(new Option(areaKey ? 'Loading…' : 'Choose an area', ''));
  if (!areaKey) return;
  try {
    const result = await window.botAPI.listMonstersForArea(areaKey);
    if (!result?.success) throw new Error(result?.error || 'Monster discovery failed');
    const entries = (result.monsters || []).map(monster => [monster.key, monster.name]);
    replaceObjectiveOptions(select, entries, preferred);
    if (entries.length === 0) select.replaceChildren(new Option('No monsters found', ''));
  } catch (error) {
    select.replaceChildren(new Option('Could not load monsters', ''));
    appendLog('ERROR', `${areaKey}: ${error.message}`);
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
  setWorkspaceStatus(battlePassStatus, 'Reading Battle Pass…');
  try {
    const result = await window.botAPI.getBattlePass();
    if (!result?.success) throw new Error(result?.error || 'Battle Pass could not be read');
    latestBattlePassState = result.state;
    renderBattlePassCounters(result.state);
    setWorkspaceStatus(battlePassStatus, result.state?.page?.active
      ? 'Daily objectives refreshed.'
      : 'No active Battle Pass was recognized.', result.state?.page?.active ? 'success' : '');
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
  const battlePassAreas = GATE_MAPS.filter(([key]) => ['grakthar_2', 'grakthar_3'].includes(key));
  replaceObjectiveOptions(selectBattlePassArea, battlePassAreas, battlePassConfig.areaKey || 'grakthar_3');
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

async function renderBattlePassTargets(areaKey) {
  if (!battlePassTargetsContent) return;
  battlePassTargetsContent.innerHTML = '<div class="empty-state">Loading Battle Pass targets…</div>';
  if (!areaKey) return;
  try {
    const result = await window.botAPI.listMonstersForArea(areaKey);
    if (!result?.success) throw new Error(result?.error || 'Monster discovery failed');
    const configured = battlePassConfig.targets?.[areaKey] || {};
    const monsters = result.monsters || [];
    if (monsters.length === 0) {
      battlePassTargetsContent.innerHTML = '<div class="empty-state">No monsters were found in this Target Gate.</div>';
      return;
    }
    const header = document.createElement('div');
    header.className = 'objective-target-row objective-target-header';
    for (const label of ['Monster', 'Damage', 'Priority', 'Target']) {
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
    if (!result?.success) throw new Error(result?.error || 'Battle Pass settings could not be saved');
    battlePassConfig = result.config?.battlePass || { ...battlePassConfig, ...patch };
    setWorkspaceStatus(battlePassStatus, 'Battle Pass settings saved.', 'success');
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
  const title = normalizedQuestText(quest.title);
  const remembered = Object.entries(adventureQuestConfig.quests || {})
    .find(([, candidate]) => normalizedQuestText(candidate?.matchTitle) === title);
  if (remembered) return { policy: remembered[1], draftKey: null, policyId: remembered[0] };
  const draft = Object.entries(adventureQuestConfig.drafts || {})
    .find(([, candidate]) => normalizedQuestText(candidate?.matchTitle) === title);
  return draft ? { policy: draft[1], draftKey: draft[0], policyId: null } : { policy: {}, draftKey: null, policyId: null };
}

async function populateQuestRequirement(type, areaKey, monsterKey, select, policy = {}) {
  if (!select) return;
  if (type === 'kill_loot') {
    select.replaceChildren(new Option('Not required', ''));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  if (type === 'ability_use') {
    const abilities = (activeClassSkills?.unlockedSkills || []).filter(skill => skill?.owned === true && skill.passive !== true);
    replaceObjectiveOptions(select, [['', 'Choose ability'], ...abilities.map(skill => [String(skill.id), skill.name])], String(policy.abilityId || ''));
    return;
  }
  select.replaceChildren(new Option('Loading item loot…', ''));
  if (!areaKey || !monsterKey) {
    select.replaceChildren(new Option('Choose a monster first', ''));
    return;
  }
  try {
    const result = await window.botAPI.getMonsterStats(areaKey, monsterKey, false);
    if (!result?.success) throw new Error(result?.error || 'Monster loot is unavailable');
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
    select.replaceChildren(new Option(error.message, ''));
  }
}

function questPolicyRow(quest, policy = {}, draftKey = null) {
  const row = document.createElement('div'); row.className = 'objective-quest-row';
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
  const type = addSelect('type', [['kill_loot', 'Kill & Loot'], ['item_loot', 'Loot items'], ['ability_use', 'Use ability']], policy.type || 'kill_loot');
  const area = getMonsterAreaFromCatalog(policy.areaKey);
  const source = addSelect('source', [['gate', 'Gate'], ['event', 'Event'], ['dungeon', 'Dungeon']], area?.type || 'gate');
  const areaSelect = addSelect('areaKey', objectiveAreaOptions(source.value), policy.areaKey || '');
  const monster = addSelect('monsterKey', [['', 'Choose monster']], policy.monsterKey || '');
  const addInput = (field, value, titleText, min = 0) => {
    const input = document.createElement('input'); input.className = 'tree-input-sm'; input.type = 'number'; input.min = String(min);
    input.dataset.field = field; input.value = value ?? 0; input.title = titleText; input.setAttribute('aria-label', titleText); row.append(input); return input;
  };
  addInput('targetDamage', policy.targetDamage || 1, 'Target damage', 1);
  addInput('requiredCount', policy.requiredCount || 1, 'Required count', 1);
  const requirement = addSelect('requirement', [['', 'Not required']], '');
  addInput('priority', policy.priority || 0, 'Priority', 0);
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'tree-checkbox'; enabled.dataset.field = 'enabled'; enabled.checked = policy.enabled === true;
  enabled.title = 'Allow this quest'; enabled.setAttribute('aria-label', 'Allow this quest'); row.append(enabled);
  const refreshRequirement = () => populateQuestRequirement(type.value, areaSelect.value, monster.value, requirement, policy);
  type.addEventListener('change', async event => { event.stopPropagation(); await refreshRequirement(); queueAdventureQuestSave(); });
  source.addEventListener('change', async event => {
    event.stopPropagation();
    replaceObjectiveOptions(areaSelect, objectiveAreaOptions(source.value));
    await loadObjectiveMonsters(areaSelect.value, monster);
    await refreshRequirement();
    queueAdventureQuestSave();
  });
  areaSelect.addEventListener('change', async event => { event.stopPropagation(); await loadObjectiveMonsters(areaSelect.value, monster); await refreshRequirement(); queueAdventureQuestSave(); });
  monster.addEventListener('change', async event => { event.stopPropagation(); await refreshRequirement(); queueAdventureQuestSave(); });
  row.addEventListener('change', () => queueAdventureQuestSave());
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
  const configuredIds = Object.keys(adventureQuestConfig.quests || {}).sort((left, right) => Number(left) - Number(right));
  const representedIds = new Set(serverQuests.filter(quest => Number(quest.id) > 0).map(quest => String(quest.id)));
  const unmatchedIds = configuredIds.filter(id => !representedIds.has(id));
  for (const quest of serverQuests.filter(candidate => !(Number(candidate.id) > 0))) {
    const title = normalizedQuestText(quest.title);
    const rememberedId = unmatchedIds.find(id => normalizedQuestText(adventureQuestConfig.quests?.[id]?.matchTitle) === title);
    if (!rememberedId) continue;
    quest.policyId = Number(rememberedId);
    representedIds.add(rememberedId);
    unmatchedIds.splice(unmatchedIds.indexOf(rememberedId), 1);
  }
  const unresolvedServer = serverQuests.filter(quest => !(Number(quest.id) > 0) && !(Number(quest.policyId) > 0));
  if (unresolvedServer.length > 0 && unresolvedServer.length === unmatchedIds.length) {
    unresolvedServer.forEach((quest, index) => {
      quest.policyId = Number(unmatchedIds[index]);
      representedIds.add(unmatchedIds[index]);
    });
    unmatchedIds.length = 0;
  }
  const rows = [...serverQuests];
  for (const id of configuredIds) {
    if (!representedIds.has(id)) rows.push({ id: Number(id), title: `Saved Quest ${id}`, objective: '', status: 'saved' });
  }
  const representedDrafts = new Set();
  for (const quest of rows) {
    const matched = adventureQuestPolicyFor(quest);
    if (matched.draftKey) representedDrafts.add(matched.draftKey);
  }
  for (const [draftKey, policy] of Object.entries(adventureQuestConfig.drafts || {})) {
    if (representedDrafts.has(draftKey)) continue;
    rows.push({ id: null, title: policy.matchTitle || 'Saved quest', objective: policy.matchObjective || '', status: 'saved', savedDraftKey: draftKey });
  }
  if (rows.length === 0) {
    adventureQuestList.innerHTML = '<div class="empty-state">No quest cards were exposed by the current page.</div>';
    return;
  }
  const header = document.createElement('div');
  header.className = 'objective-quest-row objective-quest-header';
  for (const label of ['Quest objective', 'Type', 'Where', 'Area', 'Mob', 'Target damage', 'Required count', 'Item / ability', 'Priority', 'On']) {
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
      : `cooldown · ${objectiveCooldownLabel(element.dataset.cooldownUntil)}`;
  }
}

async function refreshAdventureQuests() {
  if (!activeAccount) return;
  setRefreshBusy(btnRefreshAdventureQuests, true);
  setWorkspaceStatus(adventureQuestStatus, 'Reading Adventurer Guild…');
  try {
    const result = await window.botAPI.getAdventurerQuests();
    if (!result?.success) throw new Error(result?.error || 'Adventurer quests could not be read');
    latestAdventureQuestState = result.state;
    renderAdventureQuests(result.state);
    const count = result.state?.page?.quests?.length || 0;
    setWorkspaceStatus(adventureQuestStatus, `${count} quest card${count === 1 ? '' : 's'} read · ${result.state.status.replaceAll('_', ' ')}`, 'success');
  } catch (error) {
    setWorkspaceStatus(adventureQuestStatus, error.message, 'error');
  } finally {
    setRefreshBusy(btnRefreshAdventureQuests, false);
    refreshLucideIcons();
  }
}

btnRefreshAdventureQuests?.addEventListener('click', refreshAdventureQuests);
let adventureQuestSaveTimer = null;
let pendingAdventureQuestPatch = null;

function queueAdventureQuestSave() {
  pendingAdventureQuestPatch = collectAdventureQuestSettings();
  adventureQuestConfig = pendingAdventureQuestPatch;
  clearTimeout(adventureQuestSaveTimer);
  adventureQuestSaveTimer = setTimeout(saveAdventureQuestSettings, 120);
}

function collectAdventureQuestSettings() {
    const quests = { ...(adventureQuestConfig.quests || {}) };
    const drafts = { ...(adventureQuestConfig.drafts || {}) };
    for (const row of adventureQuestList?.querySelectorAll('.objective-quest-row[data-quest-policy-key]') || []) {
      const id = row.dataset.questId;
      const policyKey = row.dataset.questPolicyKey;
      if (!id && !policyKey) continue;
      const field = name => row.querySelector(`[data-field="${name}"]`);
      const type = field('type')?.value || 'kill_loot';
      const requirementValue = field('requirement')?.value || '';
      const itemId = requirementValue.startsWith('id:') ? requirementValue.slice(3) : '';
      const itemName = requirementValue.startsWith('name:') ? requirementValue.slice(5) : '';
      const abilityId = type === 'ability_use' ? Math.max(0, Math.trunc(Number(requirementValue) || 0)) : 0;
      const policy = {
        enabled: field('enabled')?.checked === true,
        type,
        areaKey: field('areaKey')?.value || null,
        monsterKey: field('monsterKey')?.value || '',
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
  try {
    const { quests, drafts } = pendingAdventureQuestPatch || collectAdventureQuestSettings();
    pendingAdventureQuestPatch = null;
    const result = await updateCanonicalConfig({ adventureQuests: { quests, drafts } });
    if (!result?.success) throw new Error(result?.error || 'Quest settings could not be saved');
    adventureQuestConfig = result.config?.adventureQuests || { quests, drafts };
    setWorkspaceStatus(adventureQuestStatus, 'Adventurer Quest settings saved.', 'success');
  } catch (error) {
    setWorkspaceStatus(adventureQuestStatus, error.message, 'error');
  }
}

setInterval(() => updateObjectiveCooldowns(), 30000);
