async function saveLootRow(areaKey, monsterKey, name, controls) {
  const entry = {
    name,
    priority: nonNegativeInputValue(controls.priority),
    maxLooting: nonNegativeInputValue(controls.maxLooting),
    unlimited: Boolean(controls.unlimited.checked),
    enabled: Boolean(controls.enabled.checked),
  };
  const result = await updateCanonicalConfig({
    looting: { maps: { [areaKey]: { [monsterKey]: entry } } },
  });
  if (result?.success) {
    lootingConfig = result.config?.looting || lootingConfig;
  } else {
    appendLog('ERROR', result?.error || `Could not save ${name} loot priority`);
  }
}

function renderLootArea(area, discovered = [], sourceAvailable = true, message = '') {
  if (!lootAreaContent) return;
  const savedTargets = monsterConfig.maps?.[area.key] || {};
  const savedLoot = lootingConfig.maps?.[area.key] || {};
  const merged = new Map(discovered.map(monster => [monster.key, monster]));
  for (const [key, entry] of Object.entries(savedTargets)) {
    if (!merged.has(key)) merged.set(key, { key, name: entry.name, boss: false, savedOnly: true });
  }
  for (const [key, entry] of Object.entries(savedLoot)) {
    if (!merged.has(key)) merged.set(key, { key, name: entry.name, boss: false, savedOnly: true });
  }

  if (merged.size === 0) {
    const empty = document.createElement('div');
    empty.className = sourceAvailable ? 'empty-state' : 'empty-config-panel compact-empty-config';
    empty.textContent = message || (sourceAvailable
      ? uiText("No monster types were found for {0}.", area.label)
      : uiText('Dungeon monster discovery requires an active dungeon instance.'));
    lootAreaContent.replaceChildren(empty);
    return;
  }

  const table = document.createElement('div');
  table.className = 'loot-config-table';
  const header = document.createElement('div');
  header.className = 'loot-config-row loot-config-header';
  for (const label of ['Monster', 'Lootable', 'Priority', 'Max looting', '∞', 'Done', 'Loot']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    header.appendChild(cell);
  }
  table.appendChild(header);
  for (const monster of [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const stored = savedLoot[monster.key] || {};
    const row = document.createElement('div');
    row.className = 'loot-config-row';
    row.dataset.monsterKey = monster.key;
    row.dataset.monsterName = monster.name;
    const name = document.createElement('div');
    name.className = 'monster-config-name';
    name.textContent = monster.name;
    if (monster.phase) {
      const badge = document.createElement('span');
      badge.className = 'monster-phase-badge';
      badge.textContent = uiText("Phase {0}", monster.phase);
      name.appendChild(badge);
    } else if (monster.boss) {
      const badge = document.createElement('span');
      badge.className = 'monster-boss-badge';
      badge.textContent = uiText('Boss');
      name.appendChild(badge);
    }
    const lootable = document.createElement('span');
    lootable.className = 'lootable-count';
    lootable.textContent = Number.isFinite(Number(monster.lootableCount)) ? String(monster.lootableCount) : '—';
    lootable.title = uiText("{0} currently available to loot", monster.name);
    const priority = document.createElement('input');
    priority.type = 'number';
    priority.min = '0';
    priority.step = '1';
    priority.value = stored.priority ?? 0;
    priority.className = 'monster-number-input loot-priority-input';
    priority.title = uiText('Lower numbers are looted first; equal priorities sort by monster name.');
    priority.setAttribute('aria-label', uiText("{0} loot priority", monster.name));
    const maxLooting = document.createElement('input');
    maxLooting.type = 'number';
    maxLooting.min = '0';
    maxLooting.step = '1';
    maxLooting.value = stored.maxLooting ?? 0;
    maxLooting.className = 'monster-number-input loot-limit-input';
    maxLooting.setAttribute('aria-label', uiText("{0} maximum looting count", monster.name));
    const unlimited = document.createElement('input');
    unlimited.type = 'checkbox';
    unlimited.className = 'tree-checkbox loot-unlimited';
    unlimited.checked = stored.unlimited === true;
    unlimited.title = uiText('Allow looting without a count limit.');
    unlimited.setAttribute('aria-label', uiText("Unlimited looting for {0}", monster.name));
    const updateLootLimitState = () => {
      maxLooting.disabled = unlimited.checked;
      maxLooting.classList.toggle('module-setting-disabled', unlimited.checked);
    };
    updateLootLimitState();
    const progress = document.createElement('div');
    progress.className = 'monster-progress';
    const progressText = document.createElement('span');
    progressText.textContent = `${stored.lootedCount || 0}/${stored.unlimited === true ? '∞' : (stored.maxLooting || 0)}`;
    const resetProgress = document.createElement('button');
    resetProgress.type = 'button';
    resetProgress.className = 'monster-progress-reset';
    resetProgress.append(createLucideIcon('rotate-ccw'));
    resetProgress.title = uiText("Reset looted count for {0}", monster.name);
    resetProgress.addEventListener('click', async () => {
      const result = await updateCanonicalConfig({
        looting: { maps: { [area.key]: { [monster.key]: { lootedCount: 0, lootedInstanceIds: [] } } } },
      });
      if (result?.success) {
        lootingConfig = result.config?.looting || lootingConfig;
        progressText.textContent = `0/${unlimited.checked ? '∞' : (maxLooting.value || 0)}`;
      } else {
        appendLog('ERROR', result?.error || `Could not reset ${monster.name} loot progress`);
      }
    });
    progress.append(progressText, resetProgress);
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'tree-checkbox loot-enabled';
    enabled.checked = stored.enabled === true;
    enabled.setAttribute('aria-label', uiText("Enable looting {0}", monster.name));
    const controls = { priority, maxLooting, unlimited, enabled };
    Object.values(controls).forEach(control => {
      control.addEventListener('change', () => saveLootRow(area.key, monster.key, monster.name, controls));
    });
    unlimited.addEventListener('change', () => {
      updateLootLimitState();
      progressText.textContent = `${stored.lootedCount || 0}/${unlimited.checked ? '∞' : (maxLooting.value || 0)}`;
    });
    maxLooting.addEventListener('change', () => {
      progressText.textContent = `${stored.lootedCount || 0}/${unlimited.checked ? '∞' : (maxLooting.value || 0)}`;
    });
    row.append(name, lootable, priority, maxLooting, unlimited, progress, enabled);
    enhanceNumberInputs(row);
    table.appendChild(row);
  }
  lootAreaContent.replaceChildren(table);
  refreshLucideIcons(lootAreaContent);
}

async function setAllVisibleLoot(field, value) {
  const areaKey = activeLootAreaKey;
  if (!areaKey) return;
  const patch = {};
  for (const row of lootAreaContent?.querySelectorAll('.loot-config-row[data-monster-key]') || []) {
    patch[row.dataset.monsterKey] = { name: row.dataset.monsterName || row.dataset.monsterKey, [field]: value };
    const checkbox = row.querySelector(field === 'unlimited' ? '.loot-unlimited' : '.loot-enabled');
    if (checkbox) checkbox.checked = value;
  }
  if (Object.keys(patch).length === 0) return;
  const result = await updateCanonicalConfig({ looting: { maps: { [areaKey]: patch } } });
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not update visible loot settings');
    return;
  }
  lootingConfig = result.config?.looting || lootingConfig;
  await selectLootArea(areaKey, true);
}

btnLootUnlimitedAll?.addEventListener('click', () => setAllVisibleLoot('unlimited', true));
btnLootEnableAll?.addEventListener('click', () => setAllVisibleLoot('enabled', true));

async function selectLootArea(areaKey, force = false) {
  const area = monsterCatalog.find(candidate => candidate.key === areaKey);
  if (!area || !lootAreaContent) return;
  if (force) {
    const latestConfig = await window.botAPI.getConfig();
    monsterConfig = latestConfig?.monsters || monsterConfig;
    lootingConfig = latestConfig?.looting || lootingConfig;
  }
  activeLootAreaKey = areaKey;
  if (lootAreaSelect) lootAreaSelect.value = areaKey;
  if (lootAreaTypeSelect) lootAreaTypeSelect.value = areaWorkspaceType(area);

  if (!force && lootAreaCache.has(areaKey)) {
    const cached = lootAreaCache.get(areaKey);
    renderLootArea(area, cached.monsters, cached.sourceAvailable, cached.message);
    return;
  }

  lootAreaContent.innerHTML = ("<div class=\"empty-state\">" + uiText("Loading monster types…") + "</div>");
  const result = await window.botAPI.listLootableMonstersForArea(areaKey);
  if (!result?.success) {
    renderLootArea(area, [], true, result?.error || 'Monster discovery failed.');
    return;
  }
  lootAreaCache.set(areaKey, result);
  renderLootArea(area, result.monsters || [], result.sourceAvailable !== false, result.message || '');
}

async function loadLootWorkspace(force = false) {
  const latestConfig = await window.botAPI.getConfig();
  monsterConfig = latestConfig?.monsters || monsterConfig;
  lootingConfig = latestConfig?.looting || lootingConfig;
  if (monsterCatalog.length === 0) monsterCatalog = await window.botAPI.getMonsterCatalog();
  const configuredAreaKey = preferredBotSetupArea();
  const configuredArea = monsterCatalog.find(area => area.key === configuredAreaKey);
  if (configuredArea) activeLootAreaKey = configuredArea.key;
  const selectedArea = configuredArea || monsterCatalog.find(area => area.key === activeLootAreaKey);
  const selectedType = (selectedArea && areaWorkspaceType(selectedArea))
    || lootAreaTypeSelect?.value
    || 'gate';
  if (lootAreaTypeSelect) lootAreaTypeSelect.value = selectedType;
  activeLootAreaKey = populateLootAreaSelect(selectedType, activeLootAreaKey);
  if (activeLootAreaKey) await selectLootArea(activeLootAreaKey, force);
}

if (lootAreaSelect) lootAreaSelect.addEventListener('change', () => selectLootArea(lootAreaSelect.value));
if (lootAreaTypeSelect) {
  lootAreaTypeSelect.addEventListener('change', async () => {
    activeLootAreaKey = populateLootAreaSelect(lootAreaTypeSelect.value);
    if (activeLootAreaKey) await selectLootArea(activeLootAreaKey);
  });
}
if (btnRefreshLootArea) {
  btnRefreshLootArea.addEventListener('click', async () => {
    if (!activeLootAreaKey) return;
    btnRefreshLootArea.disabled = true;
    try {
      await selectLootArea(activeLootAreaKey, true);
    } finally {
      btnRefreshLootArea.disabled = false;
    }
  });
}

window.switchHomeSubTab = function (subtab) {
  const tabs = { general: subtabHomeGeneralBtn, bot: subtabHomeBotBtn };
  const views = { general: subviewHomeGeneral, equipment: subviewHomeEquipment, bot: subviewHomeBot };
  Object.entries(tabs).forEach(([name, button]) => button?.classList.toggle('active', name === subtab));
  Object.entries(views).forEach(([name, view]) => { if (view) view.style.display = name === subtab ? 'flex' : 'none'; });
  if (subtab === 'equipment') {
    renderCombatPlayerStats();
    refreshCombatData(false);
  }
};

document.querySelectorAll('[data-home-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchHomeSubTab(button.dataset.homeTab));
});
