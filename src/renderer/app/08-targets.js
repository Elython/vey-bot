async function saveMonsterRow(areaKey, monsterKey, name, controls) {
  const entry = {
    name,
    targetDamage: Math.max(0, Math.trunc(Number(controls.targetDamage.value) || 0)),
    killCount: Math.max(0, Math.trunc(Number(controls.killCount.value) || 0)),
    dungeonKillCount: Math.max(0, Math.trunc(Number(controls.dungeonKillCount?.value) || 0)),
    unlimited: controls.unlimited.checked,
    priority: Math.max(0, Math.trunc(Number(controls.priority.value) || 0)),
    minimumHp: Math.max(0, Math.trunc(Number(controls.minimumHp.value) || 0)),
    gearSet: controls.gearSet.value,
    petSet: controls.petSet.value,
    staminaPotion: controls.staminaPotion.value,
    allowAbilities: controls.allowAbilities.checked,
    enabled: controls.enabled.checked,
  };
  const result = await updateCanonicalConfig({
    monsters: { maps: { [areaKey]: { [monsterKey]: entry } } },
  });
  if (result?.success) {
    monsterConfig = result.config?.monsters || monsterConfig;
  } else {
    appendLog('ERROR', result?.error || `Could not save ${name} configuration`);
  }
}

let cubePvpTargetOverview = null;
let cubePvpTargetConfig = {};

function cubePvpCooldownLabel(milliseconds) {
  const remaining = Math.max(0, Number(milliseconds) || 0);
  if (remaining <= 0) return 'Ready';
  const totalMinutes = Math.ceil(remaining / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function saveCubePvpTargetPolicy(nodeId, patch) {
  const result = await updateCanonicalConfig({ cubePvp: { nodes: { [String(nodeId)]: patch } } });
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not save Cube PvP match policy');
    return false;
  }
  cubePvpTargetConfig = result.config?.cubePvp || cubePvpTargetConfig;
  const node = cubePvpTargetOverview?.nodes?.find(entry => Number(entry.id) === Number(nodeId));
  const policy = cubePvpTargetConfig.nodes?.[String(nodeId)];
  if (node && policy) {
    node.enabled = policy.enabled === true;
    node.matches = (node.matches || []).map(match => ({
      ...match,
      enabled: policy.matches?.[String(match.matchNo)]?.enabled !== false,
      priority: Number(policy.matches?.[String(match.matchNo)]?.priority) || 0,
    }));
    renderCubePvpTargets(cubePvpTargetOverview);
  }
  return true;
}

function renderCubePvpTargets(overview) {
  if (!cubePvpTargetContent) return;
  const nodes = overview?.nodes || [];
  if (cubePvpTargetStatus) {
    const enabledNodes = nodes.filter(node => node.enabled === true).length;
    cubePvpTargetStatus.textContent = !overview?.moduleSelected
      ? uiText('Select Module: Dungeons and Dungeon: Cube to run Cube PvP.')
      : cubePvpTargetConfig.enabled !== true
        ? uiText('Cube PvP is off. Enable Join Cube PvP, then press Apply or Start.')
        : enabledNodes === 0
          ? uiText('Enable at least one Cube PvP node below.')
          : uiText("{0} open match(es) · {1} enabled node(s)", nodes.reduce((total, node) => total + Number(node.openCount || 0), 0), enabledNodes);
  }
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    const details = document.createElement('details');
    details.className = 'cube-pvp-node';
    const summary = document.createElement('summary');
    const chevron = createLucideIcon('chevron-right');
    chevron.classList.add('cube-pvp-node-chevron');
    const title = document.createElement('strong');
    title.textContent = `${node.name} [${Number(node.openCount) || 0}/${node.maximumMatches}]`;
    const state = document.createElement('span');
    state.className = `cube-pvp-state cube-pvp-state-${node.status || 'hidden'}`;
    state.textContent = String(node.status || 'hidden').replaceAll('_', ' ');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'tree-checkbox';
    enabled.checked = node.enabled === true;
    enabled.title = uiText("Allow Veybot to join OPEN matches in {0}", node.name);
    enabled.setAttribute('aria-label', enabled.title);
    enabled.addEventListener('click', event => event.stopPropagation());
    enabled.addEventListener('change', () => saveCubePvpTargetPolicy(node.id, { enabled: enabled.checked }));
    const enabledLabel = document.createElement('span');
    enabledLabel.className = 'cube-pvp-node-enable';
    enabledLabel.textContent = uiText('Join');
    enabledLabel.title = enabled.title;
    enabledLabel.addEventListener('click', event => event.stopPropagation());
    summary.append(chevron, title, state, enabledLabel, enabled);
    details.append(summary);

    if (node.error && !node.matches?.length) {
      const message = document.createElement('div');
      message.className = 'empty-state compact-empty-state';
      message.textContent = node.error;
      details.append(message);
    } else {
      const table = document.createElement('div');
      table.className = 'cube-pvp-match-table';
      const header = document.createElement('div');
      header.className = 'cube-pvp-match-row cube-pvp-match-header';
      for (const label of [uiText('Match'), uiText('Status'), uiText('Players'), uiText('Priority'), uiText('Join')]) {
        const cell = document.createElement('span'); cell.textContent = label; header.append(cell);
      }
      table.append(header);
      for (const match of node.matches || []) {
        const row = document.createElement('div');
        row.className = `cube-pvp-match-row${match.joined ? ' is-current' : ''}`;
        const number = document.createElement('span'); number.textContent = `#${match.matchNo}${match.joined ? ' · joined' : ''}`;
        const matchState = document.createElement('span'); matchState.textContent = match.status;
        const players = document.createElement('span'); players.textContent = `${match.occupiedSlots}/${match.maximumSlots}`;
        const priority = document.createElement('input');
        priority.type = 'number'; priority.min = '0'; priority.step = '1'; priority.className = 'monster-number-input';
        priority.value = String(match.priority || 0); priority.title = uiText('Lower numbers join first. Equal priorities use the smallest match number.');
        const allow = document.createElement('input');
        allow.type = 'checkbox'; allow.className = 'tree-checkbox'; allow.checked = match.enabled !== false;
        allow.title = uiText("Allow joining match #{0}", match.matchNo);
        const save = () => saveCubePvpTargetPolicy(node.id, {
          matches: { [String(match.matchNo)]: { enabled: allow.checked, priority: Math.max(0, Math.trunc(Number(priority.value) || 0)) } },
        });
        priority.addEventListener('change', save);
        allow.addEventListener('change', save);
        row.append(number, matchState, players, priority, allow);
        table.append(row);
      }
      details.append(table);
    }
    fragment.append(details);
  }
  cubePvpTargetContent.replaceChildren(fragment);
  enhanceNumberInputs(cubePvpTargetContent);
  refreshLucideIcons(cubePvpTargetContent);
}

async function refreshCubePvpTargets(force = false) {
  if (!cubePvpTargetContent || !activeAccount) return;
  const requestToken = accountRequestToken();
  cubePvpTargetContent.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: uiText('Loading Cube PvP matches…') }));
  if (btnRefreshCubePvpTargets) btnRefreshCubePvpTargets.disabled = true;
  try {
    const [result, config] = await Promise.all([window.botAPI.getCubePvpOverview(force === true), window.botAPI.getConfig()]);
    if (!isCurrentAccountRequest(requestToken)) return;
    if (!result?.success) throw new Error(result?.error || uiText('Cube PvP matches are unavailable'));
    cubePvpTargetConfig = config?.cubePvp || {};
    cubePvpTargetOverview = result.overview;
    if (result.overview?.status) renderCubePvpStatus(result.overview.status);
    renderCubePvpTargets(cubePvpTargetOverview);
  } catch (error) {
    if (!isCurrentAccountRequest(requestToken)) return;
    cubePvpTargetOverview = null;
    cubePvpTargetContent.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: error.message }));
    if (cubePvpTargetStatus) cubePvpTargetStatus.textContent = uiText('Cube PvP discovery failed.');
  } finally {
    if (isCurrentAccountRequest(requestToken) && btnRefreshCubePvpTargets) btnRefreshCubePvpTargets.disabled = false;
  }
}

function updateCubePvpTargetVisibility(areaKey, refresh = false) {
  const visible = areaKey === 'polyhedral_crucible';
  if (cubePvpTargetPanel) cubePvpTargetPanel.style.display = visible ? '' : 'none';
  if (visible && (refresh || !cubePvpTargetOverview)) refreshCubePvpTargets();
}

function renderMonsterArea(area, discovered = [], sourceAvailable = true, message = '') {
  if (!monsterAreaContent) return;
  const saved = monsterConfig.maps?.[area.key] || {};
  const merged = new Map(discovered.map(monster => [monster.key, monster]));
  Object.entries(saved).forEach(([key, entry]) => {
    if (!merged.has(key)) merged.set(key, { key, name: entry.name, boss: false, instances: 0, savedOnly: true });
  });

  if (!sourceAvailable && merged.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-config-panel compact-empty-config';
    const title = document.createElement('strong');
    title.textContent = uiText("{0} is currently unavailable", area.label);
    const detail = document.createElement('span');
    detail.textContent = message || uiText('Monster discovery will retry automatically when this account can access the area.');
    empty.append(title, detail);
    monsterAreaContent.replaceChildren(empty);
    return;
  }

  if (merged.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = message || uiText("No monster types were found for {0}.", area.label);
    monsterAreaContent.replaceChildren(empty);
    return;
  }

  const table = document.createElement('div');
  table.className = 'monster-config-table';
  const header = document.createElement('div');
  header.className = 'monster-config-row monster-config-header';
  for (const [label, title] of [
    [uiText('Monster'), uiText('Monster Name')], [uiText('Alive'), uiText('Currently alive / total discovered')], [uiText('Stats'), uiText('Monster stats')], [uiText('Damage'), uiText('Target damage')], [uiText('Kills'), uiText('Total kill count')], [uiText('Per dungeon'), uiText('Dungeon only: maximum completed targets of this type in each dungeon instance; 0 disables this separate limit')], ['∞', uiText('Unlimited targets')],
    [uiText('Pri'), uiText('Priority — lower numbers run first')], [uiText('Min HP'), uiText('Minimum HP')],
    [uiText('Done'), uiText('Completed target count')], [uiText('Gear'), uiText('Gear set')], [uiText('Pet'), uiText('Pet set')],
    [uiText('Potions'), uiText('Stamina potion selection')], [uiText('Skills'), uiText('Allow all globally enabled abilities for this monster')], [uiText('Target'), uiText('Target enabled')],
  ]) {
    const cell = document.createElement('span');
    cell.textContent = label;
    cell.title = uiText(title);
    header.appendChild(cell);
  }
  table.appendChild(header);

  for (const monster of [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const stored = saved[monster.key] || {};
    const row = document.createElement('div');
    row.className = 'monster-config-row';
    row.dataset.monsterKey = monster.key;
    row.dataset.monsterName = monster.name;
    const name = document.createElement('div');
    name.className = 'monster-config-name';
    const nameText = document.createElement('span');
    nameText.className = 'monster-config-name-text';
    nameText.textContent = monster.name;
    name.appendChild(nameText);
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
    const availability = document.createElement('span');
    availability.className = 'monster-availability-count';
    const aliveCount = Math.max(0, Number(monster.aliveCount ?? monster.instances) || 0);
    const totalCount = Math.max(aliveCount, Number(monster.totalCount ?? monster.instances) || 0);
    availability.textContent = `${aliveCount}/${totalCount}`;
    availability.title = uiText("{0} currently alive out of {1} discovered", aliveCount, totalCount);
    const statsButton = document.createElement('button');
    statsButton.type = 'button';
    statsButton.className = `monster-stats-help${monster.statsAvailable ? ' has-stats' : ''}`;
    statsButton.append(createLucideIcon('circle-help'));
    statsButton.title = uiText("View verified stats for {0}", monster.name);
    statsButton.setAttribute('aria-label', uiText("View {0} stats", monster.name));
    statsButton.addEventListener('click', () => monsterStatsView?.open(area.key, monster.key, monster.name));

    const targetDamage = document.createElement('input');
    targetDamage.type = 'number';
    targetDamage.min = '0';
    targetDamage.step = '1';
    targetDamage.value = stored.targetDamage ?? 0;
    targetDamage.className = 'monster-number-input';
    targetDamage.setAttribute('aria-label', uiText("{0} target damage", monster.name));

    const killCount = document.createElement('input');
    killCount.type = 'number';
    killCount.min = '0';
    killCount.step = '1';
    killCount.value = stored.killCount ?? 0;
    killCount.className = 'monster-number-input';
    killCount.setAttribute('aria-label', uiText("{0} kill count", monster.name));

    let dungeonKillCount;
    if (area.type === 'dungeon') {
      dungeonKillCount = document.createElement('input');
      dungeonKillCount.type = 'number';
      dungeonKillCount.min = '0';
      dungeonKillCount.step = '1';
      dungeonKillCount.value = stored.dungeonKillCount ?? 0;
      dungeonKillCount.className = 'monster-number-input';
      dungeonKillCount.title = uiText('Maximum targets of this type to complete in each dungeon instance. It resets automatically for a new instance. 0 uses the ordinary Kills limit.');
      dungeonKillCount.setAttribute('aria-label', uiText("{0} per-dungeon kill count", monster.name));
    } else {
      dungeonKillCount = document.createElement('span');
      dungeonKillCount.textContent = '—';
      dungeonKillCount.title = uiText('Per-dungeon limits apply only to Dungeon areas.');
    }

    const unlimited = document.createElement('input');
    unlimited.type = 'checkbox';
    unlimited.className = 'tree-checkbox monster-unlimited';
    unlimited.checked = stored.unlimited === true;
    unlimited.title = uiText('Keep targeting new instances without a kill-count limit.');
    unlimited.setAttribute('aria-label', uiText("Unlimited targets for {0}", monster.name));
    const updateTargetLimitState = () => {
      killCount.disabled = unlimited.checked;
      killCount.classList.toggle('module-setting-disabled', unlimited.checked);
    };
    updateTargetLimitState();

    const priority = document.createElement('input');
    priority.type = 'number';
    priority.min = '0';
    priority.step = '1';
    priority.value = stored.priority ?? 0;
    priority.className = 'monster-number-input';
    priority.title = uiText('Lower numbers are targeted first; equal priorities sort by monster name.');
    priority.setAttribute('aria-label', uiText("{0} target priority", monster.name));

    const minimumHp = document.createElement('input');
    minimumHp.type = 'number';
    minimumHp.min = '0';
    minimumHp.step = '1';
    minimumHp.value = stored.minimumHp ?? 0;
    minimumHp.className = 'monster-number-input';
    minimumHp.title = uiText('Ignore an instance when its current HP is below this value.');
    minimumHp.setAttribute('aria-label', uiText("{0} minimum current HP", monster.name));

    const progress = document.createElement('div');
    progress.className = 'monster-progress';
    const progressText = document.createElement('span');
    progressText.textContent = `${stored.completedCount || 0}/${stored.unlimited === true ? '∞' : (stored.killCount || 0)}`;
    const resetProgress = document.createElement('button');
    resetProgress.type = 'button';
    resetProgress.className = 'monster-progress-reset';
    resetProgress.append(createLucideIcon('rotate-ccw'));
    resetProgress.title = uiText("Reset completed target count for {0}", monster.name);
    resetProgress.addEventListener('click', async () => {
      const result = await updateCanonicalConfig({
        monsters: { maps: { [area.key]: { [monster.key]: { completedCount: 0, completedInstanceIds: [] } } } },
      });
      if (result?.success) {
        monsterConfig = result.config?.monsters || monsterConfig;
        progressText.textContent = `0/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
      } else {
        appendLog('ERROR', result?.error || `Could not reset ${monster.name} progress`);
      }
    });
    progress.append(progressText, resetProgress);

    const gearSet = createMonsterSetSelect(stored.gearSet, `${monster.name} Gear set`);
    const petSet = createMonsterSetSelect(stored.petSet, `${monster.name} Pet set`);
    const staminaPotion = createStaminaPotionSelect(stored.staminaPotion, `${monster.name} stamina potion`);
    const allowAbilities = document.createElement('input');
    allowAbilities.type = 'checkbox';
    allowAbilities.className = 'tree-checkbox monster-abilities';
    allowAbilities.checked = stored.allowAbilities === true;
    allowAbilities.title = uiText('Off by default. When enabled, all abilities allowed in Combat may be used against this monster; individual per-monster ability selection is intentionally unavailable.');
    allowAbilities.setAttribute('aria-label', uiText("Allow abilities against {0}", monster.name));
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'tree-checkbox monster-enabled';
    enabled.checked = stored.enabled === true;
    enabled.title = uiText('Include this monster type as an automation target.');
    enabled.setAttribute('aria-label', uiText("Target {0}", monster.name));

    const controls = { targetDamage, killCount, dungeonKillCount: area.type === 'dungeon' ? dungeonKillCount : null, unlimited, priority, minimumHp, gearSet, petSet, staminaPotion, allowAbilities, enabled };
    Object.values(controls).filter(Boolean).forEach(control => {
      control.addEventListener('change', () => {
        saveMonsterRow(area.key, monster.key, monster.name, controls);
      });
    });
    killCount.addEventListener('change', () => {
      progressText.textContent = `${stored.completedCount || 0}/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
    });
    unlimited.addEventListener('change', () => {
      updateTargetLimitState();
      progressText.textContent = `${stored.completedCount || 0}/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
    });
    row.append(name, availability, statsButton, targetDamage, killCount, dungeonKillCount, unlimited, priority, minimumHp, progress, gearSet, petSet, staminaPotion, allowAbilities, enabled);
    enhanceNumberInputs(row);
    table.appendChild(row);
  }

  monsterAreaContent.replaceChildren(table);
  refreshLucideIcons(monsterAreaContent);
}

async function setAllVisibleTargets(field, value) {
  const areaKey = activeMonsterAreaKey;
  if (!areaKey) return;
  const patch = {};
  for (const row of monsterAreaContent?.querySelectorAll('.monster-config-row[data-monster-key]') || []) {
    patch[row.dataset.monsterKey] = { name: row.dataset.monsterName || row.dataset.monsterKey, [field]: value };
    const checkbox = row.querySelector(field === 'unlimited' ? '.monster-unlimited' : '.monster-enabled');
    if (checkbox) checkbox.checked = value;
  }
  if (Object.keys(patch).length === 0) return;
  const result = await updateCanonicalConfig({ monsters: { maps: { [areaKey]: patch } } });
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not update visible targets');
    return;
  }
  monsterConfig = result.config?.monsters || monsterConfig;
  await selectMonsterArea(areaKey, true);
}

btnTargetUnlimitedAll?.addEventListener('click', () => setAllVisibleTargets('unlimited', true));
btnTargetEnableAll?.addEventListener('click', () => setAllVisibleTargets('enabled', true));

async function selectMonsterArea(areaKey, force = false) {
  const area = monsterCatalog.find(candidate => candidate.key === areaKey);
  if (!area || !monsterAreaContent) return;
  if (force) {
    const latestConfig = await window.botAPI.getConfig();
    monsterConfig = latestConfig?.monsters || monsterConfig;
  }
  activeMonsterAreaKey = areaKey;
  if (targetAreaSelect) targetAreaSelect.value = areaKey;
  if (targetAreaTypeSelect) targetAreaTypeSelect.value = areaWorkspaceType(area);

  if (!force && monsterAreaCache.has(areaKey)) {
    const cached = monsterAreaCache.get(areaKey);
    renderMonsterArea(area, cached.monsters, cached.sourceAvailable, cached.message);
    updateCubePvpTargetVisibility(areaKey, false);
    return;
  }

  monsterAreaContent.innerHTML = ("<div class=\"empty-state\">" + uiText("Loading monster types…") + "</div>");
  const result = await window.botAPI.listMonstersForArea(areaKey, force);
  if (!result?.success) {
    renderMonsterArea(area, [], true, result?.error || 'Monster discovery failed.');
    updateCubePvpTargetVisibility(areaKey, force);
    return;
  }
  monsterAreaCache.set(areaKey, result);
  renderMonsterArea(area, result.monsters || [], result.sourceAvailable !== false, result.message || '');
  updateCubePvpTargetVisibility(areaKey, force);
}

async function loadMonsterWorkspace(force = false) {
  const latestConfig = await window.botAPI.getConfig();
  monsterConfig = latestConfig?.monsters || monsterConfig;
  if (monsterCatalog.length === 0) {
    monsterCatalog = await window.botAPI.getMonsterCatalog();
  }
  const configuredAreaKey = preferredBotSetupArea();
  const configuredArea = monsterCatalog.find(area => area.key === configuredAreaKey);
  if (configuredArea) activeMonsterAreaKey = configuredArea.key;
  const selectedArea = configuredArea || monsterCatalog.find(area => area.key === activeMonsterAreaKey);
  const selectedType = (selectedArea && areaWorkspaceType(selectedArea))
    || targetAreaTypeSelect?.value
    || 'gate';
  if (targetAreaTypeSelect) targetAreaTypeSelect.value = selectedType;
  activeMonsterAreaKey = populateTargetAreaSelect(selectedType, activeMonsterAreaKey);
  if (activeMonsterAreaKey) await selectMonsterArea(activeMonsterAreaKey, force);
}

if (targetAreaSelect) {
  targetAreaSelect.addEventListener('change', () => selectMonsterArea(targetAreaSelect.value));
}
if (targetAreaTypeSelect) {
  targetAreaTypeSelect.addEventListener('change', async () => {
    activeMonsterAreaKey = populateTargetAreaSelect(targetAreaTypeSelect.value);
    if (activeMonsterAreaKey) await selectMonsterArea(activeMonsterAreaKey);
  });
}

if (btnRefreshMonsterArea) {
  btnRefreshMonsterArea.addEventListener('click', async () => {
    if (!activeMonsterAreaKey) return;
    btnRefreshMonsterArea.disabled = true;
    try {
      await selectMonsterArea(activeMonsterAreaKey, true);
    } finally {
      btnRefreshMonsterArea.disabled = false;
    }
  });
}

btnRefreshCubePvpTargets?.addEventListener('click', () => refreshCubePvpTargets(true));

if (btnCollectMonsterStats) {
  btnCollectMonsterStats.addEventListener('click', async () => {
    if (!activeMonsterAreaKey) return;
    btnCollectMonsterStats.disabled = true;
    const previousText = btnCollectMonsterStats.textContent;
    btnCollectMonsterStats.textContent = uiText('Collecting…');
    try {
      const result = await window.botAPI.collectMonsterStatsForArea(activeMonsterAreaKey);
      if (!result?.success) throw new Error(result?.error || uiText('Monster Stats collection failed'));
      const details = `${result.collected} read, ${result.conflicts} conflicts, ${result.errors?.length || 0} errors`;
      appendLog(result.errors?.length || result.conflicts ? 'WARN' : 'INFO', `Monster Stats: ${details}`);
      monsterAreaCache.delete(activeMonsterAreaKey);
      await selectMonsterArea(activeMonsterAreaKey, true);
    } catch (error) {
      appendLog('ERROR', error.message);
    } finally {
      btnCollectMonsterStats.disabled = false;
      btnCollectMonsterStats.textContent = previousText;
    }
  });
}
