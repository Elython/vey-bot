function populateEquipmentSetOptions() {
  Object.values(EQUIPMENT_SELECTS).flatMap(group => Object.values(group)).forEach(select => {
    if (!select) return;
    for (let setNumber = 1; setNumber <= 10; setNumber += 1) {
      const option = document.createElement('option');
      option.value = `quick_set_${setNumber}`;
      option.textContent = `Quick Set ${setNumber}`;
      select.appendChild(option);
    }
  });
}

function progressionProfileRows() {
  return Object.values(progressionProfilesConfig?.profiles || {})
    .filter(profile => profile?.id)
    .sort((left, right) => {
      if (left.id === 'default') return -1;
      if (right.id === 'default') return 1;
      return String(left.name || '').localeCompare(String(right.name || ''));
    });
}

function nextProgressionProfileName() {
  const existingNames = new Set(progressionProfileRows().map(profile => String(profile.name || '').toLowerCase()));
  let number = 1;
  while (existingNames.has(`progression config ${number}`)) number += 1;
  return `Progression config ${number}`;
}

function renderProgressionProfileControls() {
  const activeId = progressionProfilesConfig?.profiles?.[progressionProfilesConfig.activeId]
    ? progressionProfilesConfig.activeId : 'default';
  const rows = progressionProfileRows();
  for (const select of [selectProgressionProfileSetup, selectProgressionProfile]) {
    if (!select) continue;
    select.replaceChildren(...rows.map(profile => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      return option;
    }));
    select.value = activeId;
  }
  const active = progressionProfilesConfig?.profiles?.[activeId];
  if (inputProgressionProfileName) inputProgressionProfileName.value = active?.name || 'Default';
  const immutable = activeId === 'default';
  if (btnRenameProgressionProfile) btnRenameProgressionProfile.disabled = immutable;
  if (btnDeleteProgressionProfile) btnDeleteProgressionProfile.disabled = immutable;
  if (inputProgressionProfileName) inputProgressionProfileName.disabled = false;
}

function loadProgressionProfileConfiguration(config = {}) {
  progressionProfilesConfig = config.progressionProfiles || { activeId: 'default', profiles: {} };
  renderProgressionProfileControls();
  const progression = config.progression || {};
  if (chkProgressionLootLeveling) chkProgressionLootLeveling.checked = progression.useLootForLeveling === true;
  if (chkProgressionChapterFallback) chkProgressionChapterFallback.checked = progression.allowChapterFallback === true;
  if (chkProgressionDrainBeforePots) chkProgressionDrainBeforePots.checked = progression.drainBeforePots !== false;
  if (chkProgressionLootDungeons) chkProgressionLootDungeons.checked = progression.lootSources?.dungeons?.enabled === true;
  if (chkProgressionLootEvents) chkProgressionLootEvents.checked = progression.lootSources?.events?.enabled === true;
  if (chkProgressionLootGates) chkProgressionLootGates.checked = progression.lootSources?.gates?.enabled === true;
  loadProgressionAreaSelection(progressionDungeonSourceList, progression.lootSources?.dungeons?.areas);
  loadProgressionAreaSelection(progressionEventSourceList, progression.lootSources?.events?.areas);
  loadProgressionAreaSelection(progressionGateSourceList, progression.lootSources?.gates?.areas);
  const stamina = config.resources?.stamina || {};
  if (chkAllowStaminaPots) chkAllowStaminaPots.checked = stamina.allowPotions === true;
  if (selectStaminaPotionPriority) selectStaminaPotionPriority.value = stamina.priority || 'small';
  if (inputSmallStaminaPotLimit) inputSmallStaminaPotLimit.value = stamina.potionLimits?.small ?? 0;
  if (inputLargeStaminaPotLimit) inputLargeStaminaPotLimit.value = stamina.potionLimits?.large ?? 0;
  if (inputFullStaminaPotLimit) inputFullStaminaPotLimit.value = stamina.potionLimits?.full ?? 0;
  if (inputAdventureStaminaPotLimit) inputAdventureStaminaPotLimit.value = stamina.potionLimits?.adventure ?? 0;
  updateProgressionControls();
  updatePotionPolicyControls();
}

async function selectProgressionProfileById(profileId) {
  if (!profileId || profileId === progressionProfilesConfig.activeId) return;
  const result = await trackConfigSave(window.botAPI.selectProgressionProfile(profileId));
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not select Progression profile');
    renderProgressionProfileControls();
    return;
  }
  loadProgressionProfileConfiguration(result.config);
  markConfigDirty();
}

for (const select of [selectProgressionProfileSetup, selectProgressionProfile]) {
  select?.addEventListener('change', () => selectProgressionProfileById(select.value));
}

btnCreateProgressionProfile?.addEventListener('click', async () => {
  btnCreateProgressionProfile.disabled = true;
  try {
    const result = await trackConfigSave(window.botAPI.createProgressionProfile(nextProgressionProfileName()));
    if (!result?.success) {
      appendLog('ERROR', result?.error || 'Could not create Progression profile');
      return;
    }
    loadProgressionProfileConfiguration(result.config);
    markConfigDirty();
    if (inputProgressionProfileName) {
      inputProgressionProfileName.focus();
      inputProgressionProfileName.select();
    }
  } finally {
    btnCreateProgressionProfile.disabled = false;
  }
});

btnRenameProgressionProfile?.addEventListener('click', async () => {
  const profileId = progressionProfilesConfig.activeId;
  const name = String(inputProgressionProfileName?.value || '').trim();
  if (profileId === 'default' || !name) return;
  const result = await trackConfigSave(window.botAPI.renameProgressionProfile(profileId, name));
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not rename Progression profile');
    return;
  }
  loadProgressionProfileConfiguration(result.config);
  markConfigDirty();
});

btnDeleteProgressionProfile?.addEventListener('click', async () => {
  const profileId = progressionProfilesConfig.activeId;
  const profile = progressionProfilesConfig.profiles?.[profileId];
  if (!profile || profileId === 'default') return;
  if (!window.confirm(`Delete Progression profile "${profile.name}"?`)) return;
  const result = await trackConfigSave(window.botAPI.deleteProgressionProfile(profileId));
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not delete Progression profile');
    return;
  }
  loadProgressionProfileConfiguration(result.config);
  markConfigDirty();
});

function renderProgressionStatus(stats = latestStats) {
  const enabled = selectGeneralModule?.value !== 'auto_farm';
  const lootLevelingEnabled = enabled && chkProgressionLootLeveling?.checked === true;
  progressionLootLevelingOptions?.classList.toggle('module-setting-disabled', !lootLevelingEnabled);
  progressionLootLevelingOptions?.setAttribute('aria-disabled', String(!lootLevelingEnabled));
  rowProgressionChapterFallback?.classList.toggle('module-setting-disabled', !enabled);
  rowProgressionChapterFallback?.setAttribute('aria-disabled', String(!enabled));
  if (chkProgressionChapterFallback) chkProgressionChapterFallback.disabled = !enabled;
  const hasLootSource = (
    chkProgressionLootDungeons?.checked === true && selectedProgressionAreas(progressionDungeonSourceList).length > 0
  ) || (
    chkProgressionLootEvents?.checked === true && selectedProgressionAreas(progressionEventSourceList).length > 0
  ) || (
    chkProgressionLootGates?.checked === true && selectedProgressionAreas(progressionGateSourceList).length > 0
  );
  const scanned = Number(latestProgressionTelemetry?.lootScannedAt) > 0;
  if (progressionCurrentState) {
    const status = latestProgressionTelemetry?.status || 'Monitoring';
    const boostPercent = Number(latestProgressionTelemetry?.lootXpBoostPercent) || 0;
    progressionCurrentState.textContent = enabled
      ? `${status}${latestProgressionTelemetry?.lootXpBoostActive === true ? ` · XP +${boostPercent}%` : ''}`
      : 'Disabled';
  }
  renderProgressionStaminaFlow();
  if (progressionLootXp) {
    const eligible = Number(latestProgressionTelemetry?.eligibleLootXp);
    progressionLootXp.textContent = lootLevelingEnabled && scanned && Number.isFinite(eligible)
      ? eligible.toLocaleString()
      : '-';
  }
  if (progressionLootScan) {
    const eligibleCount = Number(latestProgressionTelemetry?.eligibleLootCount) || 0;
    const unknownCount = Number(latestProgressionTelemetry?.unknownLootCount) || 0;
    const errorCount = Number(latestProgressionTelemetry?.lootScanErrorCount) || 0;
    progressionLootScan.textContent = !lootLevelingEnabled
      ? '-'
      : !scanned
        ? 'Not scanned'
        : `${eligibleCount} eligible${unknownCount ? ` · ${unknownCount} unverified` : ''}${errorCount ? ` · ${errorCount} failed` : ''}`;
  }
  if (btnRefreshProgressionLoot) btnRefreshProgressionLoot.disabled = selectGeneralModule?.value === 'auto_farm' || !lootLevelingEnabled || !hasLootSource;
  if (!progressionXpNeeded) return;
  let current = Number(stats?.expCurrent);
  let required = Number(stats?.expRequired);
  if ((!Number.isFinite(current) || !Number.isFinite(required)) && typeof stats?.exp === 'string') {
    const match = stats.exp.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    if (match) {
      current = Number(match[1].replace(/,/g, ''));
      required = Number(match[2].replace(/,/g, ''));
    }
  }
  progressionXpNeeded.textContent = Number.isFinite(current) && Number.isFinite(required)
    ? Math.max(0, required - current).toLocaleString()
    : '-';
}

function renderProgressionStaminaFlow() {
  if (!progressionStaminaFlow) return;
  const fallback = {
    current: 'waiting',
    steps: {
      looting: { enabled: chkProgressionLootLeveling?.checked === true, available: false },
      chapters: { enabled: chkProgressionChapterFallback?.checked === true && selectFarmModule?.value === 'automatic', available: false },
      potions: { enabled: chkAllowStaminaPots?.checked === true, available: chkAllowStaminaPots?.checked === true },
      waiting: { enabled: true, available: true },
    },
  };
  const flow = latestProgressionTelemetry?.staminaFlow || fallback;
  const locallyEnabled = {
    looting: chkProgressionLootLeveling?.checked === true,
    chapters: chkProgressionChapterFallback?.checked === true && selectFarmModule?.value === 'automatic',
    potions: chkAllowStaminaPots?.checked === true,
    waiting: true,
  };
  for (const step of progressionStaminaFlow.querySelectorAll('[data-flow-step]')) {
    const key = step.dataset.flowStep;
    const state = { ...(flow.steps?.[key] || { available: false }), enabled: locallyEnabled[key] === true };
    step.classList.toggle('is-disabled', state.enabled !== true);
    step.classList.toggle('is-unavailable', state.enabled === true && state.available !== true && flow.current !== key);
    step.classList.toggle('is-active', flow.current === key);
    step.title = flow.current === key ? 'Current action' : state.enabled !== true ? 'Turned off' : state.available !== true ? 'Currently unavailable' : 'Available';
  }
}

function renderProgressionStaminaPotionCounters(telemetry = {}) {
  const usedByType = telemetry.stats?.staminaPotionsUsed || {};
  const availableByType = { small: 0, large: 0, full: 0, adventure: 0 };
  for (const item of telemetry.potions?.items || []) {
    if (item?.category !== 'stamina' || !Object.hasOwn(availableByType, item.type)) continue;
    availableByType[item.type] += Math.max(0, Number(item.quantity) || 0);
  }
  for (const [type, elements] of Object.entries(progressionStaminaPotionCounters || {})) {
    if (elements.used) elements.used.textContent = `${Math.max(0, Number(usedByType[type]) || 0).toLocaleString()} used`;
    if (elements.available) {
      const quantity = Math.max(0, Number(availableByType[type]) || 0);
      elements.available.textContent = telemetry.potions?.recognized === true ? `${quantity.toLocaleString()} left` : '— left';
    }
  }
}

async function refreshProgressionLootViews() {
  if (progressionLootViewRefreshPromise) return progressionLootViewRefreshPromise;
  const refresh = (async () => {
    setRefreshBusy(btnRefreshProgressionLoot, true);
    if (btnRefreshAvailableLoot) btnRefreshAvailableLoot.disabled = true;
    if (progressionLootScan) progressionLootScan.textContent = 'Scanning…';
    if (!latestProgressionLootView && progressionAvailableLootContent) {
      progressionAvailableLootContent.innerHTML = '<div class="empty-state">Scanning configured unclaimed loot…</div>';
    }
    try {
      const result = await withUiTimeout(window.botAPI.refreshProgressionLoot(), 90000, 'Progression loot scan');
      if (!result?.success) throw new Error(result?.error || 'Eligible loot could not be scanned');
      latestProgressionTelemetry = result.progression || null;
      applyProgressionLootView(result.progression?.availableLoot || { entries: [], errors: [] });
      renderProgressionStatus();
      const unknown = Number(result.progression?.unknownLootCount) || 0;
      const errors = Number(result.progression?.lootScanErrorCount) || 0;
      if (unknown || errors) {
        appendLog('WARN', `Loot scan completed with ${unknown} unverified reward${unknown === 1 ? '' : 's'} and ${errors} area error${errors === 1 ? '' : 's'}.`);
      }
      for (const error of result.progression?.availableLoot?.errors || []) {
        appendLog('WARN', `Loot scan source failed: ${scanErrorText(error)}`);
      }
    } catch (error) {
      if (progressionLootScan) progressionLootScan.textContent = latestProgressionLootView ? 'Refresh failed · showing last scan' : 'Scan failed';
      if (latestProgressionLootView) renderAvailableProgressionLoot(latestProgressionLootView.entries || [], latestProgressionLootView.errors || []);
      else renderAvailableProgressionLoot([], [{ message: error.message }]);
      appendLog('ERROR', error.message);
    } finally {
      renderProgressionStatus();
      setRefreshBusy(btnRefreshProgressionLoot, false);
      if (btnRefreshAvailableLoot) btnRefreshAvailableLoot.disabled = selectGeneralModule?.value === 'auto_farm';
    }
  })();
  progressionLootViewRefreshPromise = refresh;
  try {
    return await refresh;
  } finally {
    if (progressionLootViewRefreshPromise === refresh) progressionLootViewRefreshPromise = null;
  }
}

btnRefreshProgressionLoot?.addEventListener('click', refreshProgressionLootViews);

function applyProgressionLootView(view) {
  if (!view || typeof view !== 'object') return;
  latestProgressionLootView = view;
  latestProgressionLootRevision = Number.isFinite(Number(view.revision))
    ? Number(view.revision)
    : latestProgressionLootRevision;
  renderProgressionScanErrors(view.errors || []);
  renderAvailableProgressionLoot(view.entries || [], view.errors || []);
}

function scanErrorText(error = {}) {
  const source = [error.areaKey, error.instanceId ? `instance ${error.instanceId}` : ''].filter(Boolean).join(' · ');
  return `${source ? `${source}: ` : ''}${error.message || error.error || 'Unknown scan error'}`;
}

function renderProgressionScanErrors(errors = []) {
  if (!progressionScanErrors || !progressionScanErrorsContent || !progressionScanErrorsSummary) return;
  progressionScanErrors.style.display = errors.length ? 'block' : 'none';
  progressionScanErrorsSummary.textContent = errors.length
    ? `${errors.length} source error${errors.length === 1 ? '' : 's'} · view details`
    : 'Scan details';
  progressionScanErrorsContent.replaceChildren(...errors.map(error => {
    const row = document.createElement('div');
    row.className = 'scan-error-row';
    row.textContent = scanErrorText(error);
    return row;
  }));
}

async function syncProgressionLootSnapshot(expectedRevision = null) {
  const revision = Number(expectedRevision);
  if (Number.isFinite(revision) && revision === latestProgressionLootRevision) return latestProgressionLootView;
  if (progressionLootSnapshotSyncPromise) return progressionLootSnapshotSyncPromise;
  const generation = progressionLootSessionGeneration;
  const sync = (async () => {
    const result = await window.botAPI.listAvailableProgressionLoot();
    if (!result?.success) throw new Error(result?.error || 'Progression loot snapshot is unavailable');
    if (generation === progressionLootSessionGeneration) applyProgressionLootView(result);
    return result;
  })();
  progressionLootSnapshotSyncPromise = sync;
  try {
    return await sync;
  } finally {
    if (progressionLootSnapshotSyncPromise === sync) progressionLootSnapshotSyncPromise = null;
  }
}

function renderAvailableProgressionLoot(entries = [], errors = []) {
  if (!progressionAvailableLootContent) return;
  if (entries.length === 0) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.textContent = errors.length ? `No readable loot found. ${errors.length} source error(s).` : 'No unclaimed loot was found.';
    progressionAvailableLootContent.replaceChildren(empty); return;
  }
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.areaKey}:${entry.monsterKey || entry.monsterName}`;
    const group = groups.get(key) || { name: entry.monsterName, area: entry.areaName || entry.areaKey, entries: [] };
    group.entries.push(entry); groups.set(key, group);
  }
  const list = document.createElement('div'); list.className = 'progression-loot-list';
  for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const details = document.createElement('details'); details.className = 'progression-loot-group';
    const summary = document.createElement('summary');
    const name = document.createElement('strong'); name.textContent = group.name;
    const area = document.createElement('span'); area.textContent = group.area || '—';
    const count = document.createElement('span'); count.textContent = `${group.entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.stackSize) || 1), 0)} lootable`;
    summary.append(name, area, count); details.append(summary);
    for (const entry of group.entries) {
      const row = document.createElement('div'); row.className = 'progression-loot-entry';
      const identity = document.createElement('span'); identity.textContent = entry.instanceId ? `${entry.monsterId} / ${entry.instanceId}` : entry.monsterId;
      const damage = document.createElement('span'); damage.textContent = Number.isFinite(Number(entry.userDamage)) ? `${formatNumber(entry.userDamage)} damage` : 'Damage unverified';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btn-sm'; open.textContent = 'Open'; open.disabled = !entry.pageUrl;
      open.addEventListener('click', async () => {
        const result = await window.botAPI.openBattleInBrowser(entry.pageUrl);
        if (!result?.success) appendLog('ERROR', result?.error || 'Could not open the loot battle page');
      });
      row.append(identity, damage, open); details.append(row);
    }
    list.append(details);
  }
  progressionAvailableLootContent.replaceChildren(list);
}

btnRefreshAvailableLoot?.addEventListener('click', refreshProgressionLootViews);

function updateProgressionControls() {
  const autoFarmIsolated = selectGeneralModule?.value === 'auto_farm';
  const enabled = !autoFarmIsolated;
  const strategyPanel = document.getElementById('subviewStaminaGeneral');
  strategyPanel?.classList.toggle('module-setting-disabled', autoFarmIsolated);
  renderProgressionProfileControls();
  const profileManager = selectProgressionProfile?.closest('.progression-profile-manager');
  profileManager?.setAttribute('aria-disabled', String(autoFarmIsolated));
  for (const control of profileManager?.querySelectorAll('input, select, button') || []) {
    if (autoFarmIsolated) control.disabled = true;
  }
  for (const [row, control] of [
    [rowProgressionLootLeveling, chkProgressionLootLeveling],
    [rowProgressionChapterFallback, chkProgressionChapterFallback],
  ]) {
    if (row) {
      row.classList.toggle('module-setting-disabled', !enabled);
      row.setAttribute('aria-disabled', String(!enabled));
    }
    if (control) control.disabled = !enabled;
  }
  const lootLevelingEnabled = enabled && chkProgressionLootLeveling?.checked === true;
  for (const [row, control] of [
    [rowProgressionDungeonSources, chkProgressionLootDungeons],
    [rowProgressionEventSources, chkProgressionLootEvents],
    [rowProgressionGateSources, chkProgressionLootGates],
  ]) {
    if (row) {
      row.classList.toggle('module-setting-disabled', !lootLevelingEnabled);
      row.setAttribute('aria-disabled', String(!lootLevelingEnabled));
    }
    if (control) control.disabled = !lootLevelingEnabled;
  }
  for (const [picker, container, sourceEnabled] of [
    [progressionDungeonSourcePicker, progressionDungeonSourceList, chkProgressionLootDungeons?.checked === true],
    [progressionEventSourcePicker, progressionEventSourceList, chkProgressionLootEvents?.checked === true],
    [progressionGateSourcePicker, progressionGateSourceList, chkProgressionLootGates?.checked === true],
  ]) {
    const interactive = lootLevelingEnabled && sourceEnabled;
    if (picker) {
      picker.classList.toggle('module-setting-disabled', !interactive);
      picker.setAttribute('aria-disabled', String(!interactive));
    }
    for (const checkbox of container?.querySelectorAll('.progression-source-checkbox') || []) {
      checkbox.disabled = !interactive;
    }
  }
  updateProgressionSourceCount(progressionDungeonSourceList, progressionDungeonSourceCount);
  updateProgressionSourceCount(progressionEventSourceList, progressionEventSourceCount);
  updateProgressionSourceCount(progressionGateSourceList, progressionGateSourceCount);
  renderProgressionStatus();
}

async function saveProgressionSettings() {
  updateProgressionControls();
  const progression = {
      enabled: true,
      useLootForLeveling: chkProgressionLootLeveling?.checked === true,
      allowChapterFallback: chkProgressionChapterFallback?.checked === true,
      drainBeforePots: chkProgressionDrainBeforePots?.checked !== false,
      lootSources: {
        dungeons: {
          enabled: chkProgressionLootDungeons?.checked === true,
          areas: selectedProgressionAreas(progressionDungeonSourceList),
        },
        events: {
          enabled: chkProgressionLootEvents?.checked === true,
          areas: selectedProgressionAreas(progressionEventSourceList),
        },
        gates: {
          enabled: chkProgressionLootGates?.checked === true,
          areas: selectedProgressionAreas(progressionGateSourceList),
        },
      },
    };
  const result = await trackConfigSave(window.botAPI.updateProgressionSettings(progression));
  if (result?.success) markConfigDirty();
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not save Progression settings');
    return;
  }
  progressionProfilesConfig = result.config?.progressionProfiles || progressionProfilesConfig;
  renderProgressionProfileControls();
  const hasSource = (
    progression.lootSources.dungeons.enabled && progression.lootSources.dungeons.areas.length > 0
  ) || (
    progression.lootSources.events.enabled && progression.lootSources.events.areas.length > 0
  ) || (
    progression.lootSources.gates.enabled && progression.lootSources.gates.areas.length > 0
  );
  if (!progression.useLootForLeveling || !hasSource) {
    latestProgressionTelemetry = {
      ...(latestProgressionTelemetry || {}),
      status: progression.useLootForLeveling ? 'Select a loot source' : 'Following base Stamina policy',
      eligibleLootXp: 0,
      eligibleLootCount: 0,
      unknownLootCount: 0,
      lootScanErrorCount: 0,
      lootScannedAt: Date.now(),
    };
    applyProgressionLootView({ revision: latestProgressionLootRevision + 1, refreshedAt: Date.now(), entries: [], errors: [] });
    renderProgressionStatus();
    return;
  }
  // Progression is a live safety/resource policy. Recalculate after the last
  // checkbox change so disabled sources disappear without requiring Apply.
  clearTimeout(saveProgressionSettings.refreshTimer);
  saveProgressionSettings.refreshTimer = setTimeout(() => {
    refreshProgressionLootViews().catch(error => appendLog('ERROR', error.message));
  }, 250);
}

function nonNegativeInputValue(input) {
  return Math.max(0, Math.trunc(Number(input?.value) || 0));
}

function percentageInputValue(input, minimum = 0) {
  const value = Math.min(100, Math.max(minimum, nonNegativeInputValue(input)));
  if (input) input.value = String(value);
  return value;
}

function manaRangeInputValue(input, minimum = 0) {
  const value = Math.max(minimum, Math.floor(nonNegativeInputValue(input) / 20) * 20);
  if (input) input.value = String(value);
  return value;
}

async function saveResourcePolicy() {
  const staminaMin = percentageInputValue(inputKeepStaminaMin);
  const staminaMax = percentageInputValue(inputKeepStaminaMax, staminaMin);
  const result = await updateCanonicalConfig({
    resources: {
      stamina: {
        keepMin: staminaMin,
        keepMax: staminaMax,
        stopBelow: percentageInputValue(inputStopStaminaBelow),
        allowPotions: Boolean(chkAllowStaminaPots?.checked),
        priority: selectStaminaPotionPriority?.value || 'small',
        potionLimits: {
          small: nonNegativeInputValue(inputSmallStaminaPotLimit),
          large: nonNegativeInputValue(inputLargeStaminaPotLimit),
          full: nonNegativeInputValue(inputFullStaminaPotLimit),
          adventure: nonNegativeInputValue(inputAdventureStaminaPotLimit),
        },
      },
      health: {
        sleepBelow: percentageInputValue(inputSleepHealthBelow),
        maxDeaths: nonNegativeInputValue(inputMaxDeaths),
        usePotions: Boolean(chkUseHealingPotions?.checked),
        maxPotions: nonNegativeInputValue(inputMaxHealingPotions),
        buyPotionIfNeeded: Boolean(chkBuyHealthPotion?.checked),
        maxPurchases: nonNegativeInputValue(inputMaxHealthPotionPurchases),
      },
      mana: {
        allowPotions: Boolean(chkAllowManaPotions?.checked),
        priority: selectManaPotionPriority?.value || 'small',
        potionLimits: {
          small: nonNegativeInputValue(inputSmallManaPotLimit),
          large: nonNegativeInputValue(inputLargeManaPotLimit),
        },
        keepMin: manaRangeInputValue(inputKeepManaMin),
        keepMax: manaRangeInputValue(inputKeepManaMax, manaRangeInputValue(inputKeepManaMin)),
        buyPotionIfNeeded: Boolean(chkBuyManaPotion?.checked),
        maxPurchases: nonNegativeInputValue(inputMaxManaPotionPurchases),
      },
    },
  });
  if (!result?.success) appendLog('ERROR', result?.error || 'Could not save resource policy');
  else {
    progressionProfilesConfig = result.config?.progressionProfiles || progressionProfilesConfig;
    renderProgressionProfileControls();
  }
}

function updatePotionPolicyControls() {
  const staminaEnabled = chkAllowStaminaPots?.checked === true;
  for (const row of staminaPotionRows) {
    row?.classList.toggle('module-setting-disabled', !staminaEnabled);
    row?.setAttribute('aria-disabled', String(!staminaEnabled));
    for (const control of row?.querySelectorAll('input, select') || []) control.disabled = !staminaEnabled;
  }
  const manaEnabled = chkAllowManaPotions?.checked === true;
  for (const control of [selectManaPotionPriority, inputSmallManaPotLimit, inputLargeManaPotLimit]) {
    if (!control) continue;
    control.disabled = !manaEnabled;
    control.closest('.form-tree-row')?.classList.toggle('module-setting-disabled', !manaEnabled);
  }
  const healthEnabled = chkUseHealingPotions?.checked === true;
  if (rowHealingPotionLimit) {
    rowHealingPotionLimit.classList.toggle('module-setting-disabled', !healthEnabled);
    rowHealingPotionLimit.setAttribute('aria-disabled', String(!healthEnabled));
  }
  if (inputMaxHealingPotions) inputMaxHealingPotions.disabled = !healthEnabled;
}
