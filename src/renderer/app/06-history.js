function createMonsterSetSelect(value, label) {
  const select = document.createElement('select');
  select.className = 'monster-set-select';
  select.setAttribute('aria-label', label);
  for (let setNumber = 0; setNumber <= 10; setNumber += 1) {
    const option = document.createElement('option');
    option.value = setNumber === 0 ? 'default' : `quick_set_${setNumber}`;
    option.textContent = setNumber === 0 ? uiText('Default') : uiText("Quick Set {0}", setNumber);
    select.appendChild(option);
  }
  select.value = value || 'default';
  return select;
}

function createStaminaPotionSelect(value, label) {
  const select = document.createElement('select');
  select.className = 'monster-potion-select';
  select.setAttribute('aria-label', label);
  for (const [optionValue, optionLabel] of [
    ['none', uiText('None')],
    ['auto', uiText('Auto')],
    ['small', uiText('Small Pot')],
    ['large', uiText('Large Pot')],
    ['full', uiText('Full Pot')],
    ['adventure', uiText('Adventure Pot')],
  ]) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionLabel;
    select.appendChild(option);
  }
  select.value = value || 'none';
  return select;
}

function areaWorkspaceType(area) {
  if (Number.isInteger(Number(area?.eventId))) return 'event';
  return area?.type || 'gate';
}

function populateTypedAreaSelect(select, type, selectedKey = null) {
  if (!select) return null;
  const areas = monsterCatalog.filter(area => areaWorkspaceType(area) === type);
  select.replaceChildren(...areas.map(area => {
    const option = document.createElement('option');
    option.value = area.key;
    option.textContent = area.label;
    return option;
  }));
  const nextKey = selectedKey && areas.some(area => area.key === selectedKey)
    ? selectedKey
    : areas[0]?.key || null;
  if (nextKey) select.value = nextKey;
  return nextKey;
}

function populateTargetAreaSelect(type, selectedKey = null) {
  return populateTypedAreaSelect(targetAreaSelect, type, selectedKey);
}

function populateLootAreaSelect(type, selectedKey = null) {
  return populateTypedAreaSelect(lootAreaSelect, type, selectedKey);
}

function preferredBotSetupArea() {
  const module = selectGeneralModule?.value || 'idle';
  if (module === 'gates') return selectGeneralMap?.value || null;
  if (module === 'dungeons') return selectGeneralDungeonMap?.value || null;
  if (module === 'event') return selectGeneralEventMap?.value || null;
  if (module === 'auto_farm') return autoFarmTargetAreaSelect?.value || autoFarmConfig.areaKey || null;
  return null;
}

function formatHistoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const serverDate = new Date(date.getTime() + (serverTzOffsetSeconds * 1000));
  return serverDate.toLocaleString([], {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function renderActivityConsole(kind, entries = []) {
  const consoleElement = kind === 'target' ? targetHistoryConsole : progressionHistoryConsole;
  if (!consoleElement) return;
  const rows = entries.slice(0, 20).map(entry => {
    const time = formatHistoryTime(entry.observedAt);
    if (kind === 'target') {
      return `[${time}] ${entry.monsterName || 'Unknown'} · ${formatNumber(entry.damage || 0)} damage · ${formatNumber(entry.staminaSpent || 0)} ST${entry.completed ? ' · target reached' : ''}`;
    }
    return `[${time}] ${entry.monsterName || 'Unknown'} · ${formatNumber(entry.xp || 0)} XP · ${formatNumber(entry.gold || 0)} gold · ${formatNumber(entry.stackSize || 1)} loot`;
  });
  consoleElement.textContent = rows.length ? rows.join('\n') : (kind === 'target' ? uiText('No attacks recorded.') : uiText('No loot recorded.'));
}

function historyOpenButton(pageUrl) {
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn btn-sm activity-history-open';
  open.textContent = uiText('Open');
  open.disabled = !pageUrl;
  open.title = pageUrl ? uiText('Open this battle in the client browser') : uiText('Battle page is unavailable');
  open.addEventListener('click', async event => {
    event.stopPropagation();
    const result = await window.botAPI.openBattleInBrowser(pageUrl);
    if (!result?.success) appendLog('ERROR', result?.error || 'Could not open the battle page');
  });
  return open;
}

function showLootRewards(entry = {}) {
  if (!modalLootRewards || !lootRewardsContent) return;
  if (lootRewardsTitle) lootRewardsTitle.textContent = uiText("{0} Rewards", entry.monsterName || 'Monster');
  if (lootRewardsSummary) lootRewardsSummary.textContent = uiText("{0} XP · {1} gold · {2} loot", formatNumber(entry.xp || 0), formatNumber(entry.gold || 0), formatNumber(entry.stackSize || 1));
  const items = Array.isArray(entry.items) ? entry.items : [];
  if (items.length === 0) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.textContent = Number(entry.itemsCount) > 0
      ? uiText('This older record kept the item count but not the item details.')
      : uiText('No item drops were recorded for this claim.');
    lootRewardsContent.replaceChildren(empty);
  } else {
    lootRewardsContent.replaceChildren(...items.map(item => {
      const row = document.createElement('div'); row.className = 'loot-reward-row';
      const name = document.createElement('strong'); name.textContent = item.name || uiText('Unknown item');
      const details = document.createElement('span');
      details.textContent = uiText("x{0}{1}{2}", formatNumber(item.quantity || 1), item.tier ? ` · ${item.tier}` : '', item.itemId ? ` · ID ${item.itemId}` : '');
      row.append(name, details); return row;
    }));
  }
  modalLootRewards.style.display = 'flex';
  refreshLucideIcons();
}

function historyRewardsButton(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm activity-history-rewards';
  button.textContent = uiText('Loot');
  button.title = uiText('Show the EXP, Gold, and items returned by this loot claim');
  button.addEventListener('click', event => { event.stopPropagation(); showLootRewards(entry); });
  return button;
}

function buildActivityHistoryTable(kind, entries) {
  const table = document.createElement('div');
  table.className = `activity-history-table activity-history-${kind}`;
  const header = document.createElement('div');
  header.className = 'activity-history-row activity-history-header';
  for (const label of kind === 'target' ? [uiText('Server time'), uiText('Damage'), uiText('ST')] : [uiText('Server time'), uiText('Loot'), uiText('XP'), uiText('Gold'), uiText('ID'), uiText('Loot'), uiText('Page')]) {
    const cell = document.createElement('span'); cell.textContent = label; header.append(cell);
  }
  table.append(header);
  for (const entry of entries) {
    const row = document.createElement('div'); row.className = 'activity-history-row';
    if (kind === 'target' && entry.completed) row.classList.add('activity-history-completed');
    const time = document.createElement('span');
    time.textContent = formatHistoryTime(entry.observedAt);
    time.title = entry.observedAt || '';
    const first = document.createElement('span'); first.textContent = kind === 'target' ? formatNumber(entry.damage || 0) : formatNumber(entry.stackSize || 1);
    const second = document.createElement('span'); second.textContent = kind === 'target' ? formatNumber(entry.staminaSpent || 0) : formatNumber(entry.xp || 0);
    const third = document.createElement('span'); third.textContent = formatNumber(entry.gold || 0);
    const id = document.createElement('span');
    id.className = 'activity-history-id';
    id.textContent = entry.instanceId
      ? `${entry.monsterId} / ${entry.instanceId}`
      : (entry.monsterId || '—');
    id.title = entry.instanceId ? uiText('Monster ID / Dungeon instance ID') : uiText('Monster ID');
    row.title = entry.result || entry.actionName || '';
    row.append(time, first, second);
    if (kind !== 'target') row.append(third, id, historyRewardsButton(entry), historyOpenButton(entry.pageUrl));
    table.appendChild(row);
  }
  return table;
}

function targetHistoryIdentity(entry = {}) {
  const monsterId = String(entry.monsterId || '').trim() || 'Unknown';
  const instanceId = String(entry.instanceId || '').trim();
  return {
    key: `${monsterId}\u0000${instanceId}`,
    displayId: instanceId ? `${monsterId} / ${instanceId}` : monsterId,
    title: instanceId ? uiText('Monster ID / Dungeon instance ID') : uiText('Monster ID'),
  };
}

function renderActivityHistory(kind, payload = {}, container = null) {
  container ||= kind === 'target' ? targetHistoryContent : progressionHistoryContent;
  if (!container) return;
  const entries = payload.entries || [];
  const summaries = payload.summaries || [];
  renderActivityConsole(kind, entries);
  if (entries.length === 0 && summaries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = kind === 'target'
      ? uiText('No attacks recorded for this account.')
      : uiText('No loot recorded for this account.');
    container.replaceChildren(empty);
    return;
  }

  const groups = new Map();
  for (const summary of summaries) groups.set(summary.monsterKey || summary.monsterName, { summary, entries: [] });
  for (const entry of entries) {
    const key = entry.monsterKey || entry.monsterName;
    if (!groups.has(key)) groups.set(key, { summary: { ...entry }, entries: [] });
    groups.get(key).entries.push(entry);
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'activity-history-groups';
  for (const { summary, entries: groupEntries } of [...groups.values()].sort((a, b) => String(b.summary.latestAt || b.entries[0]?.observedAt || '').localeCompare(String(a.summary.latestAt || a.entries[0]?.observedAt || '')))) {
    const hasDetails = groupEntries.length > 0;
    const group = document.createElement(hasDetails ? 'details' : 'div');
    group.className = 'activity-history-group';
    const heading = document.createElement(hasDetails ? 'summary' : 'div');
    if (!hasDetails) heading.className = 'activity-history-summary-only';
    const boss = summary.boss ? 'Boss · ' : '';
    heading.textContent = kind === 'target'
      ? uiText("{0}{1}  {2} attacks | {3} reached | {4} ST", boss, summary.monsterName || 'Unknown', formatNumber(summary.attacks || 0), formatNumber(summary.completedTargets || 0), formatNumber(summary.totalStamina || 0))
      : uiText("{0}{1}  {2} claims | {3} loot | {4} XP | {5} gold", boss, summary.monsterName || 'Unknown', formatNumber(summary.claims || 0), formatNumber(summary.lootCount || 0), formatNumber(summary.totalXp || 0), formatNumber(summary.totalGold || 0));
    group.append(heading);
    if (!hasDetails) {
      wrapper.append(group);
      continue;
    }
    if (kind === 'target') {
      const instances = new Map();
      for (const entry of groupEntries) {
        const identity = targetHistoryIdentity(entry);
        if (!instances.has(identity.key)) instances.set(identity.key, { ...identity, entries: [] });
        instances.get(identity.key).entries.push(entry);
      }
      for (const instance of [...instances.values()].sort((left, right) => String(right.entries[0]?.observedAt || '').localeCompare(String(left.entries[0]?.observedAt || '')))) {
        const disclosure = document.createElement('details');
        disclosure.className = 'activity-history-instance';
        const instanceSummary = document.createElement('summary');
        const summaryText = document.createElement('span');
        summaryText.className = 'activity-history-instance-summary-text';
        const summaryActions = document.createElement('span');
        summaryActions.className = 'activity-history-instance-actions';
        const id = document.createElement('span');
        id.className = 'activity-history-id';
        id.textContent = instance.displayId;
        id.title = instance.title;
        const stamina = instance.entries.reduce((total, entry) => total + Math.max(0, Number(entry.staminaSpent) || 0), 0);
        const reached = instance.entries.some(entry => entry.completed === true);
        summaryText.textContent = uiText("{0} attacks | {1} ST{2}", formatNumber(instance.entries.length), formatNumber(stamina), reached ? ' | Reached' : '');
        summaryActions.append(id, historyOpenButton(instance.entries[0]?.pageUrl));
        instanceSummary.append(summaryText, summaryActions);
        if (reached) disclosure.classList.add('activity-history-instance-completed');
        disclosure.append(instanceSummary, buildActivityHistoryTable(kind, instance.entries));
        group.append(disclosure);
      }
    } else {
      group.append(buildActivityHistoryTable(kind, groupEntries));
    }
    wrapper.append(group);
  }
  container.replaceChildren(wrapper);
}

async function loadActivityHistory(kind, areaKey, container) {
  if (!container) return;
  const generation = ++activityHistoryRequestGeneration[kind];
  const button = kind === 'target' ? btnRefreshTargetHistory : btnRefreshProgressionHistory;
  const status = kind === 'target' ? targetHistoryStatus : null;
  setRefreshBusy(button, true);
  setWorkspaceStatus(status, uiText('Loading…'));
  container.innerHTML = ("<div class=\"empty-state\">" + uiText("Loading history…") + "</div>");
  try {
    const result = await withUiTimeout(
      window.botAPI.getActivityHistory(kind, { limit: 250, areaKey }),
      20000,
      kind === 'target' ? uiText('Target history') : uiText('Loot history'),
    );
    if (generation !== activityHistoryRequestGeneration[kind]) return;
    if (!result?.success) throw new Error(result?.error || uiText('History is unavailable'));
    renderActivityHistory(kind, result, container);
    setWorkspaceStatus(status, uiText("{0} recent action(s) · {1} monster type(s)", result.entries?.length || 0, result.summaries?.length || 0), 'success');
  } catch (error) {
    if (generation !== activityHistoryRequestGeneration[kind]) return;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = error.message || uiText('History is unavailable');
    container.replaceChildren(empty);
    setWorkspaceStatus(status, empty.textContent, 'error');
  } finally {
    if (generation === activityHistoryRequestGeneration[kind]) setRefreshBusy(button, false);
  }
}

function populateHistoryArea(typeSelect, areaSelect, preferred = null) {
  if (areaSelect && areaSelect.options.length === 0 && preferred) {
    const preferredArea = monsterCatalog.find(area => area.key === preferred);
    if (preferredArea && typeSelect) typeSelect.value = areaWorkspaceType(preferredArea);
  }
  return populateTypedAreaSelect(areaSelect, typeSelect?.value || 'gate', preferred);
}

function refreshTargetHistory() {
  const areaKey = populateHistoryArea(targetHistoryAreaTypeSelect, targetHistoryAreaSelect, targetHistoryAreaSelect?.value || preferredBotSetupArea());
  return loadActivityHistory('target', areaKey, targetHistoryContent);
}

function refreshProgressionHistory() {
  const areaKey = populateHistoryArea(progressionHistoryAreaTypeSelect, progressionHistoryAreaSelect, progressionHistoryAreaSelect?.value || preferredBotSetupArea());
  return loadActivityHistory('loot', areaKey, progressionHistoryContent);
}

let targetHistoryLiveTimer = null;
let progressionHistoryLiveTimer = null;
function scheduleVisibleActivityHistoryRefresh(action) {
  if (action === 'ATTACK' && subviewTargetsHistory?.style.display !== 'none') {
    clearTimeout(targetHistoryLiveTimer);
    targetHistoryLiveTimer = setTimeout(refreshTargetHistory, 350);
  }
  if ([uiText('LOOT'), uiText('CLAIM_LOOT')].includes(action) && subviewProgressionLoot?.style.display !== 'none') {
    clearTimeout(progressionHistoryLiveTimer);
    progressionHistoryLiveTimer = setTimeout(refreshProgressionHistory, 350);
  }
}

function lootCandidatePageUrl(candidate = {}) {
  const battleRef = candidate.battleRef;
  if (battleRef && typeof battleRef === 'object') {
    const dgmid = battleRef.dgmid || battleRef.monsterId || candidate.dgmid || candidate.id;
    const instanceId = battleRef.instanceId || candidate.instanceId;
    if (dgmid && instanceId) return `https://demonicscans.org/battle.php?dgmid=${encodeURIComponent(dgmid)}&instance_id=${encodeURIComponent(instanceId)}`;
  }
  const id = typeof battleRef === 'string' || typeof battleRef === 'number'
    ? battleRef
    : candidate.battleId || candidate.id;
  return id ? `https://demonicscans.org/battle.php?id=${encodeURIComponent(id)}` : '';
}

function lootCandidateKey(candidate = {}) {
  const areaKey = String(candidate.areaKey || lootableAreaSelect?.value || '');
  const battleRef = candidate.battleRef;
  if (battleRef && typeof battleRef === 'object' && (battleRef.isDungeon || battleRef.instanceId)) {
    return `${areaKey}:dungeon:${String(battleRef.instanceId || candidate.instanceId || '')}:${String(battleRef.dgmid || battleRef.id || candidate.dgmid || candidate.id || '')}`;
  }
  const id = candidate.id || candidate.battleId || battleRef || '';
  return `${areaKey}:gate:${String(id)}`;
}

function lootCandidateActionButton(candidate) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm activity-history-open activity-history-loot-action';
  button.textContent = uiText('Loot');
  button.title = uiText('Claim this exact currently lootable monster');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const areaKey = String(candidate.areaKey || lootableAreaSelect?.value || '');
      const result = await window.botAPI.claimDiscoveredLoot(areaKey, lootCandidateKey(candidate));
      if (!result?.success) throw new Error(result?.error || uiText('Loot could not be claimed'));
      appendLog('INFO', `Looted ${candidate.name || candidate.monsterName || 'monster'} manually.`);
      setWorkspaceStatus(
        lootableHistoryStatus,
        result.result?.pausedBot ? uiText('Loot claimed. Bot paused for the manual action.') : uiText('Loot claimed.'),
        'success',
      );
      if (result.result?.warning) appendLog('WARN', result.result.warning);
      await refreshLootableArea(true);
    } catch (error) {
      appendLog('ERROR', error.message);
      setWorkspaceStatus(lootableHistoryStatus, error.message, 'error');
      button.disabled = false;
    }
  });
  return button;
}

function renderLootableSnapshot(snapshot) {
  if (!lootHistoryContent) return;
  const candidates = snapshot?.candidates || [];
  if (candidates.length === 0) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.textContent = (snapshot?.errors || []).length
      ? uiText("No readable loot found. {0}", scanErrorText(snapshot.errors[0]))
      : uiText('No unclaimed loot was found in this area.');
    lootHistoryContent.replaceChildren(empty);
    return;
  }
  const groups = new Map();
  for (const candidate of candidates) {
    const key = candidate.monsterKey || candidate.name || candidate.id;
    const group = groups.get(key) || { name: candidate.name || candidate.monsterName || 'Unknown monster', entries: [], stacks: 0 };
    group.entries.push(candidate);
    group.stacks += Math.max(1, Number(candidate.stackSize) || 1);
    groups.set(key, group);
  }
  const wrapper = document.createElement('div'); wrapper.className = 'activity-history-groups';
  for (const groupData of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const group = document.createElement('details'); group.className = 'activity-history-group';
    const summary = document.createElement('summary');
    summary.textContent = uiText("{0}  {1} record(s) | {2} loot", groupData.name, groupData.entries.length, groupData.stacks);
    group.append(summary);
    const table = document.createElement('div'); table.className = 'activity-history-table lootable-history-table';
    const header = document.createElement('div'); header.className = 'activity-history-row activity-history-header';
    for (const label of [uiText('Monster'), uiText('Stack'), uiText('Damage'), uiText('XP'), uiText('ID'), uiText('Loot'), uiText('Page')]) {
      const cell = document.createElement('span'); cell.textContent = label; header.append(cell);
    }
    table.append(header);
    for (const candidate of groupData.entries) {
      const row = document.createElement('div'); row.className = 'activity-history-row';
      const name = document.createElement('span'); name.textContent = candidate.name || candidate.monsterName || uiText('Unknown');
      const stack = document.createElement('span'); stack.textContent = formatNumber(candidate.stackSize || 1);
      const damage = document.createElement('span'); damage.textContent = candidate.userDamage == null ? '—' : formatNumber(candidate.userDamage);
      const rate = document.createElement('span');
      rate.textContent = candidate.estimatedXp == null ? '—' : formatNumber(candidate.estimatedXp);
      rate.title = candidate.expPerDamage == null ? uiText('Reward XP could not be verified') : uiText("{0} XP per damage", candidate.expPerDamage);
      const id = document.createElement('span'); id.className = 'activity-history-id'; id.textContent = candidate.instanceId ? `${candidate.id || candidate.dgmid} / ${candidate.instanceId}` : (candidate.id || candidate.battleId || '—');
      row.append(name, stack, damage, rate, id, lootCandidateActionButton(candidate), historyOpenButton(lootCandidatePageUrl(candidate)));
      table.append(row);
    }
    group.append(table); wrapper.append(group);
  }
  if (snapshot?.errors?.length) {
    const details = document.createElement('details');
    details.className = 'scan-error-details';
    const summary = document.createElement('summary');
    summary.textContent = uiText("{0} source error{1}", snapshot.errors.length, snapshot.errors.length === 1 ? '' : 's');
    details.append(summary);
    for (const error of snapshot.errors) {
      const row = document.createElement('div'); row.className = 'scan-error-row'; row.textContent = scanErrorText(error); details.append(row);
    }
    wrapper.append(details);
  }
  lootHistoryContent.replaceChildren(wrapper);
}

async function refreshLootableArea(force = false) {
  if (!lootHistoryContent || !activeAccount) return;
  const areaKey = populateHistoryArea(lootableAreaTypeSelect, lootableAreaSelect, lootableAreaSelect?.value || preferredBotSetupArea());
  if (!areaKey) return;
  const generation = ++lootableRequestGeneration;
  setRefreshBusy(btnRefreshLootHistory, true);
  setWorkspaceStatus(lootableHistoryStatus, force ? uiText('Recalculating…') : uiText('Loading…'));
  lootHistoryContent.innerHTML = ("<div class=\"empty-state\">" + uiText("Loading lootable monsters…") + "</div>");
  try {
    const result = await withUiTimeout(
      force ? window.botAPI.refreshLootDiscovery(areaKey) : window.botAPI.listLootDiscovery(areaKey),
      30000,
      uiText('Lootable scan'),
    );
    if (generation !== lootableRequestGeneration || lootableAreaSelect?.value !== areaKey) return;
    if (!result?.success) throw new Error(result?.error || uiText('Loot discovery is unavailable.'));
    let snapshot = force ? result.snapshot : result.snapshots?.[0];
    if (!snapshot && !force) {
      setWorkspaceStatus(lootableHistoryStatus, uiText('No cached scan · scanning now…'));
      const refreshed = await withUiTimeout(window.botAPI.refreshLootDiscovery(areaKey), 30000, uiText('Lootable scan'));
      if (generation !== lootableRequestGeneration || lootableAreaSelect?.value !== areaKey) return;
      if (!refreshed?.success) throw new Error(refreshed?.error || uiText('Loot discovery is unavailable.'));
      snapshot = refreshed.snapshot;
    }
    if (snapshot) lootDiscoveryCache.set(areaKey, snapshot);
    renderLootableSnapshot(snapshot);
    const timestamp = snapshot?.refreshedAt ? new Date(snapshot.refreshedAt).toLocaleTimeString() : 'now';
    const errors = snapshot?.errors?.length || 0;
    setWorkspaceStatus(
      lootableHistoryStatus,
      uiText("{0} loot action(s) · updated {1}{2}", snapshot?.candidates?.length || 0, timestamp, errors ? ` · ${errors} error(s)` : ''),
      errors ? 'error' : 'success',
    );
  } catch (error) {
    if (generation !== lootableRequestGeneration) return;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = error.message || uiText('Loot discovery is unavailable.');
    lootHistoryContent.replaceChildren(empty);
    setWorkspaceStatus(lootableHistoryStatus, empty.textContent, 'error');
  } finally {
    if (generation === lootableRequestGeneration) setRefreshBusy(btnRefreshLootHistory, false);
  }
}

function switchTargetWorkspaceTab(tab) {
  const history = tab === 'history';
  subtabTargetsConfigBtn?.classList.toggle('active', !history);
  subtabTargetsHistoryBtn?.classList.toggle('active', history);
  if (subviewTargetsConfig) subviewTargetsConfig.style.display = history ? 'none' : 'flex';
  if (subviewTargetsHistory) subviewTargetsHistory.style.display = history ? 'flex' : 'none';
  if (history) refreshTargetHistory();
  else loadMonsterWorkspace();
}

function switchLootingWorkspaceTab(tab) {
  const history = tab === 'history';
  subtabLootingConfigBtn?.classList.toggle('active', !history);
  subtabLootingHistoryBtn?.classList.toggle('active', history);
  if (subviewLootingConfig) subviewLootingConfig.style.display = history ? 'none' : 'flex';
  if (subviewLootingHistory) subviewLootingHistory.style.display = history ? 'flex' : 'none';
  if (history) refreshLootableArea(false);
  else loadLootWorkspace();
}

subtabTargetsConfigBtn?.addEventListener('click', () => switchTargetWorkspaceTab('config'));
subtabTargetsHistoryBtn?.addEventListener('click', () => switchTargetWorkspaceTab('history'));
subtabLootingConfigBtn?.addEventListener('click', () => switchLootingWorkspaceTab('config'));
subtabLootingHistoryBtn?.addEventListener('click', () => switchLootingWorkspaceTab('history'));
targetHistoryAreaTypeSelect?.addEventListener('change', () => { populateHistoryArea(targetHistoryAreaTypeSelect, targetHistoryAreaSelect); refreshTargetHistory(); });
targetHistoryAreaSelect?.addEventListener('change', refreshTargetHistory);
btnRefreshTargetHistory?.addEventListener('click', refreshTargetHistory);
progressionHistoryAreaTypeSelect?.addEventListener('change', () => { populateHistoryArea(progressionHistoryAreaTypeSelect, progressionHistoryAreaSelect); refreshProgressionHistory(); });
progressionHistoryAreaSelect?.addEventListener('change', refreshProgressionHistory);
btnRefreshProgressionHistory?.addEventListener('click', refreshProgressionHistory);
lootableAreaTypeSelect?.addEventListener('change', () => { populateHistoryArea(lootableAreaTypeSelect, lootableAreaSelect); refreshLootableArea(false); });
lootableAreaSelect?.addEventListener('change', () => refreshLootableArea(false));
btnRefreshLootHistory?.addEventListener('click', () => refreshLootableArea(true));
btnCloseLootRewards?.addEventListener('click', () => { if (modalLootRewards) modalLootRewards.style.display = 'none'; });
modalLootRewards?.addEventListener('click', event => { if (event.target === modalLootRewards) modalLootRewards.style.display = 'none'; });
