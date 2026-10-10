function switchAutoFarmWorkspaceTab(tab) {
  const targets = tab === 'targets';
  subtabAutoFarmGeneralBtn?.classList.toggle('active', !targets);
  subtabAutoFarmTargetsBtn?.classList.toggle('active', targets);
  if (subviewHomeAutoFarm) subviewHomeAutoFarm.style.display = targets ? 'none' : 'flex';
  if (subviewTargetsAutoFarm) subviewTargetsAutoFarm.style.display = targets ? 'flex' : 'none';
  if (targets) loadAutoFarmTargetWorkspace();
  else loadAutoFarmServerState();
}

subtabAutoFarmGeneralBtn?.addEventListener('click', () => switchAutoFarmWorkspaceTab('general'));
subtabAutoFarmTargetsBtn?.addEventListener('click', () => switchAutoFarmWorkspaceTab('targets'));

function populateAutoFarmTargetAreaSelect(preferred = null) {
  if (!autoFarmTargetAreaSelect) return null;
  const type = autoFarmTargetAreaTypeSelect?.value || 'gate';
  const areas = monsterCatalog.filter(area => areaWorkspaceType(area) === type
    && area.supportsAutoFarm !== false
    && area.key !== 'grakthar_1');
  autoFarmTargetAreaSelect.replaceChildren(...areas.map(area => {
    const option = document.createElement('option'); option.value = area.key; option.textContent = area.label; return option;
  }));
  const nextKey = preferred && areas.some(area => area.key === preferred) ? preferred : areas[0]?.key || null;
  if (nextKey) autoFarmTargetAreaSelect.value = nextKey;
  return nextKey;
}

function stageAutoFarmTarget(areaKey, monsterKey, name, controls) {
  autoFarmTargetDrafts.set(`${areaKey}:${monsterKey}`, { areaKey, monsterKey, entry: {
    name,
    monsterId: String(controls.monsterId || ''),
    targetDamage: nonNegativeInputValue(controls.targetDamage),
    maxStack: Math.min(250, Math.max(1, nonNegativeInputValue(controls.maxStack))),
    enabled: controls.enabled.checked,
  } });
}

async function saveAutoFarmTargets() {
  if (btnSaveAutoFarmTargets) btnSaveAutoFarmTargets.disabled = true;
  setWorkspaceStatus(autoFarmTargetStatus, uiText('Adding selected targets…'));
  try {
    for (const rendered of autoFarmRenderedRows.values()) {
      stageAutoFarmTarget(rendered.areaKey, rendered.monsterKey, rendered.name, rendered.controls);
    }
    const maps = {};
    for (const { areaKey, monsterKey, entry } of autoFarmTargetDrafts.values()) {
      maps[areaKey] ||= {};
      maps[areaKey][monsterKey] = entry;
    }
    const areaKey = autoFarmTargetAreaSelect?.value || autoFarmConfig.areaKey;
    const enabledCount = Object.values(maps[areaKey] || {}).filter(entry => entry.enabled === true).length;
    if (enabledCount === 0) throw new Error(uiText('Select at least one non-boss monster to add'));
    const result = await updateCanonicalConfig({ autoFarm: {
      areaKey,
      maps,
    } });
    if (!result?.success) throw new Error(result?.error || uiText('Could not save Auto Farm Targets'));
    autoFarmConfig = result.config?.autoFarm || autoFarmConfig;
    const serverResult = await window.botAPI.addAutoFarmTargets(areaKey);
    if (!serverResult?.success) throw new Error(serverResult?.error || uiText('Server Auto Farm target add failed'));
    autoFarmConfig = serverResult.config?.autoFarm || autoFarmConfig;
    for (const rendered of autoFarmRenderedRows.values()) rendered.controls.enabled.checked = false;
    autoFarmTargetDrafts.clear();
    renderAutoFarmServerTargets(serverResult.state);
    appendLog('INFO', `Added or updated ${serverResult.added ?? 0} Auto Farm target(s).`);
    setWorkspaceStatus(autoFarmTargetStatus, uiText("Added or updated {0} target(s).", serverResult.added ?? 0), 'success');
  } catch (error) {
    appendLog('ERROR', `Auto Farm target add failed: ${error.message}`);
    setWorkspaceStatus(autoFarmTargetStatus, error.message, 'error');
  } finally {
    if (btnSaveAutoFarmTargets) btnSaveAutoFarmTargets.disabled = false;
  }
}

function renderAutoFarmTargets(area, discovered = [], available = [], unavailableReason = '') {
  const saved = autoFarmConfig.maps?.[area.key] || {};
  autoFarmRenderedRows.clear();
  const bossKeys = new Set(discovered.filter(monster => monster.boss === true).map(monster => monster.key));
  const discoveredByKey = new Map(discovered.map(monster => [monster.key, monster]));
  const merged = new Map();
  for (const choice of available) {
    const key = autoFarmNameKey(choice.name);
    const discoveredMonster = discoveredByKey.get(key) || {};
    if (!key || bossKeys.has(key) || discoveredMonster.boss === true || !/^\d+$/.test(String(choice.id || ''))) continue;
    merged.set(key, {
      ...discoveredMonster,
      key,
      name: choice.name,
      autoFarmMonsterId: String(choice.id),
      aliveCount: discoveredMonster.aliveCount || 0,
      totalCount: discoveredMonster.totalCount || 0,
    });
  }
  if (merged.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = unavailableReason || uiText("No verified Auto Farm monster IDs were found for {0}.", area.label);
    autoFarmTargetContent?.replaceChildren(empty);
    return 0;
  }
  const table = document.createElement('div');
  table.className = 'monster-config-table auto-farm-target-table';
  const header = document.createElement('div');
  header.className = 'monster-config-row monster-config-header';
  for (const label of [uiText('Monster'), uiText('ID'), uiText('Stats'), uiText('Damage'), uiText('Stack'), uiText('Target')]) {
    const cell = document.createElement('span'); cell.textContent = label; header.append(cell);
  }
  table.append(header);
  for (const monster of [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const stored = autoFarmTargetDrafts.get(`${area.key}:${monster.key}`)?.entry || saved[monster.key] || {};
    const row = document.createElement('div'); row.className = 'monster-config-row';
    const name = document.createElement('span'); name.className = 'monster-config-name'; name.textContent = monster.name;
    const id = document.createElement('span'); id.className = 'activity-history-id'; id.textContent = monster.autoFarmMonsterId;
    const stats = document.createElement('button'); stats.type = 'button'; stats.className = 'monster-stats-help'; stats.append(createLucideIcon('circle-help')); stats.title = uiText("View verified stats for {0}", monster.name); stats.setAttribute('aria-label', stats.title); stats.addEventListener('click', () => monsterStatsView?.open(area.key, monster.key, monster.name));
    const targetDamage = document.createElement('input'); targetDamage.type = 'number'; targetDamage.min = '0'; targetDamage.value = stored.targetDamage ?? 0; targetDamage.className = 'tree-input-sm';
    const maxStack = document.createElement('input'); maxStack.type = 'number'; maxStack.min = '1'; maxStack.max = '250'; maxStack.value = stored.maxStack ?? 1; maxStack.className = 'tree-input-sm';
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'tree-checkbox'; enabled.checked = stored.enabled === true;
    const controls = { monsterId: monster.autoFarmMonsterId, targetDamage, maxStack, enabled };
    autoFarmRenderedRows.set(`${area.key}:${monster.key}`, { areaKey: area.key, monsterKey: monster.key, name: monster.name, controls });
    for (const control of [targetDamage, maxStack, enabled]) {
      control.addEventListener('change', () => stageAutoFarmTarget(area.key, monster.key, monster.name, controls));
    }
    row.append(name, id, stats, targetDamage, maxStack, enabled);
    table.append(row);
  }
  autoFarmTargetContent?.replaceChildren(table);
  enhanceNumberInputs(table);
  refreshLucideIcons(autoFarmTargetContent);
  return merged.size;
}

async function loadAutoFarmTargetWorkspace() {
  const latestConfig = await window.botAPI.getConfig();
  autoFarmConfig = latestConfig?.autoFarm || autoFarmConfig;
  if (monsterCatalog.length === 0) monsterCatalog = await window.botAPI.getMonsterCatalog();
  const preferredArea = autoFarmTargetAreaSelect?.value || autoFarmConfig.areaKey || 'grakthar_2';
  const preferredRecord = monsterCatalog.find(entry => entry.key === preferredArea);
  const preferredType = preferredRecord ? areaWorkspaceType(preferredRecord) : 'gate';
  if (autoFarmTargetAreaTypeSelect) autoFarmTargetAreaTypeSelect.value = preferredType;
  const areaKey = populateAutoFarmTargetAreaSelect(preferredArea);
  const area = monsterCatalog.find(entry => entry.key === areaKey);
  if (!area) return;
  setWorkspaceStatus(autoFarmTargetStatus, uiText("Loading {0}…", area.label));
  if (autoFarmTargetContent) autoFarmTargetContent.innerHTML = ("<div class=\"empty-state\">" + uiText("Loading Auto Farm targets…") + "</div>");
  const result = await window.botAPI.listMonstersForArea(areaKey);
  if (result?.success) monsterAreaCache.set(areaKey, result);
  const available = result?.autoFarmAvailableMonsters || [];
  const catalog = result?.autoFarmCatalog || {};
  const addableCount = renderAutoFarmTargets(
    area,
    result?.monsters || monsterAreaCache.get(areaKey)?.monsters || [],
    available,
    catalog.error
      ? `Auto Farm IDs are unavailable: ${catalog.error}`
      : `The server Wave does not expose Auto Farm IDs for ${area.label}, and no verified catalog is available.`,
  );
  const sourceLabel = catalog.source === 'database' ? 'verified account database'
    : catalog.source === 'deferred' ? 'database mapping required'
      : '';
  const success = result?.success && addableCount > 0;
  setWorkspaceStatus(autoFarmTargetStatus, success
    ? uiText("{0} addable server monster type(s){1}", addableCount, sourceLabel ? ` · ${sourceLabel}` : '')
    : (result?.error || catalog.error || uiText("No verified Auto Farm IDs are available for {0}", area.label)), success ? 'success' : 'error');
}

autoFarmTargetAreaTypeSelect?.addEventListener('change', () => {
  populateAutoFarmTargetAreaSelect();
  loadAutoFarmTargetWorkspace();
});
autoFarmTargetAreaSelect?.addEventListener('change', loadAutoFarmTargetWorkspace);
btnRefreshAutoFarmTargets?.addEventListener('click', loadAutoFarmTargetWorkspace);
btnSaveAutoFarmTargets?.addEventListener('click', saveAutoFarmTargets);
