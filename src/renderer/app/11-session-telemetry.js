// Live Application Stream Log Appender
function appendLog(level, message) {
  if (!logConsole) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-${level || 'INFO'}`;
  entry.dataset.category = classifyLogMessage(message);
  const serverDate = getServerDate();
  const time = serverDate.toLocaleTimeString();
  entry.textContent = `[${time}] [${level || 'INFO'}] ${message}`;
  const selectedCategory = logCategoryFilter?.value || 'all';
  entry.classList.toggle('is-filtered', selectedCategory !== 'all' && entry.dataset.category !== selectedCategory);
  logConsole.appendChild(entry);
  while (logConsole.childElementCount > MAX_LIVE_LOG_ENTRIES) {
    logConsole.firstElementChild?.remove();
  }
  logConsole.scrollTop = logConsole.scrollHeight;
}

// Load Accounts List
function createAccountItem(account, includeLogin) {
  const item = document.createElement('div');
  item.className = 'account-item';
  const name = document.createElement('div');
  name.className = 'account-name';
  name.textContent = account.name;
  const actions = document.createElement('div');
  actions.className = 'account-actions';
  if (includeLogin) {
    const login = document.createElement('button');
    login.className = 'btn btn-primary btn-sm';
    login.textContent = 'Login';
    login.addEventListener('click', () => window.loginWith(account.name));
    actions.appendChild(login);
  }
  const remove = document.createElement('button');
  remove.className = 'btn btn-danger btn-sm';
  remove.textContent = 'Delete';
  remove.addEventListener('click', () => window.deleteAccount(account.name));
  actions.appendChild(remove);
  item.append(name, actions);
  return item;
}

async function refreshAccounts() {
  const accounts = await window.botAPI.listAccounts();

  if (savedAccountsList) {
    savedAccountsList.innerHTML = '';
    if (accounts.length === 0) {
      savedAccountsList.innerHTML = '<div class="empty-state">No saved accounts found. Click below to add one.</div>';
    } else {
      accounts.forEach(acc => savedAccountsList.appendChild(createAccountItem(acc, true)));
    }
  }

  if (modalAccountsList) {
    modalAccountsList.innerHTML = '';
    if (accounts.length === 0) {
      modalAccountsList.innerHTML = '<div class="empty-state">No saved accounts.</div>';
    } else {
      accounts.forEach(acc => modalAccountsList.appendChild(createAccountItem(acc, false)));
    }
  }
}

// Login with Account
window.loginWith = async function (accountName) {
  appendLog('INFO', `Logging in as ${accountName}...`);
  const res = await window.botAPI.loginWithAccount(accountName);
  if (res.success) {
    activeAccount = accountName;
    latestProgressionTelemetry = null;
    latestProgressionLootView = null;
    latestProgressionLootRevision = -1;
    progressionLootSnapshotSyncPromise = null;
    pendingConfigRevision = 0;
    appliedConfigRevision = 0;
    resetAccountScopedRendererState();
    localStorage.setItem('activeAccount', accountName);
    if (footerUsername) footerUsername.textContent = accountName;

    try {
      await hydrateAccountConfiguration();
    } catch (error) {
      appendLog('ERROR', `Account settings could not be loaded: ${error.message}`);
    }

    // Switch to Logged-in View
    viewLogin.style.display = 'none';
    appContainer?.classList.add('is-authenticated');
    unauthTitle.style.display = 'block';
    tabContainer.style.display = 'flex';
    btnHeaderStartStop.style.display = 'flex';
    btnHeaderApplyConfig.style.display = 'flex';
    renderPendingConfigState();
    switchTab('home');

    menuViewBrowserBtn.disabled = false;
    menuPauseResumeBtn.disabled = false;
    menuLogoutBtn.disabled = false;
    if (menuPurgeBtn) menuPurgeBtn.disabled = false;

    appendLog('INFO', `Logged in successfully. Bot engine ready.`);
    if (res.warning) appendLog('WARN', res.warning);
    if (res.stats) renderPlayerStats(res.stats);
    const telemetry = await window.botAPI.getTelemetry();
    if (telemetry) {
      updateBotStatus(telemetry.state || 'STOPPED');
      latestProgressionTelemetry = telemetry.progression || null;
      renderProgressionStatus();
      renderOverviewTelemetry(telemetry);
      await syncProgressionLootSnapshot(telemetry.progression?.lootRevision).catch(error => {
        appendLog('WARN', `Progression loot snapshot could not be loaded: ${error.message}`);
      });
    }
    await loadMangaList();
    await loadFarmSettings();

  } else {
    alert(`Failed to login: ${res.error}`);
    appendLog('ERROR', `Login failed: ${res.error}`);
  }
};

// Delete Account
window.deleteAccount = async function (accountName) {
  if (confirm(`Are you sure you want to delete ${accountName}?`)) {
    await window.botAPI.deleteAccount(accountName);
    if (activeAccount === accountName) {
      performLogout();
    }
    await refreshAccounts();
  }
};

// Logout
async function performLogout(options = {}) {
  await flushPendingConfigSaves();
  if (options.skipServer !== true) await window.botAPI.logout();
  activeAccount = null;
  latestProgressionTelemetry = null;
  latestProgressionLootView = null;
  latestProgressionLootRevision = -1;
  progressionLootViewRefreshPromise = null;
  progressionLootSnapshotSyncPromise = null;
  renderAvailableProgressionLoot([], []);
  resetAccountScopedRendererState();
  localStorage.removeItem('activeAccount');
  if (footerUsername) footerUsername.textContent = '-';

  viewHome.style.display = 'none';
  viewEnergyFarm.style.display = 'none';
  viewNPCConfig.style.display = 'none';
  viewLootConfig.style.display = 'none';
  if (viewConsole) viewConsole.style.display = 'none';
  tabContainer.style.display = 'none';
  appContainer?.classList.remove('is-authenticated');
  btnHeaderStartStop.style.display = 'none';
  btnHeaderApplyConfig.style.display = 'none';
  pendingConfigRevision = 0;
  appliedConfigRevision = 0;
  renderPendingConfigState();
  unauthTitle.style.display = 'block';
  viewLogin.style.display = 'flex';

  menuViewBrowserBtn.disabled = true;
  menuPauseResumeBtn.disabled = true;
  menuLogoutBtn.disabled = true;
  if (menuPurgeBtn) menuPurgeBtn.disabled = true;

  updateBotStatus('STOPPED');
  await refreshAccounts();
}

let currentBotState = 'STOPPED';

function updateBotStatus(state) {
  currentBotState = state;

  const runningStates = new Set([
    'IDLE', 'SCANNING_GATES', 'JOINING_BATTLE', 'ATTACKING', 'WAITING_LOOT',
    'LOOTING', 'HEALING', 'FARMING_ENERGY', 'CHALLENGE_WAIT',
  ]);
  const labels = {
    STOPPED: 'Stopped', IDLE: 'Idle', SCANNING_GATES: 'Scanning gates',
    JOINING_BATTLE: 'Joining battle', ATTACKING: 'Attacking', WAITING_LOOT: 'Waiting to loot',
    LOOTING: 'Looting', HEALING: 'Healing', FARMING_ENERGY: 'Farming energy',
    CHALLENGE_WAIT: 'Challenge waiting', PAUSED: 'Paused',
  };
  if (botStateText) botStateText.textContent = labels[state] || state;
  if (menuPauseResumeBtn) {
    setButtonIcon(menuPauseResumeBtn, state === 'PAUSED' ? 'play' : 'pause', state === 'PAUSED' ? 'Resume Bot' : 'Pause Bot');
    menuPauseResumeBtn.disabled = state === 'STOPPED';
  }

  if (runningStates.has(state)) {
    setButtonIcon(btnHeaderStartStop, 'square');
    btnHeaderStartStop.classList.add('is-running');
  } else {
    setButtonIcon(btnHeaderStartStop, 'play');
    btnHeaderStartStop.classList.remove('is-running');
  }
  refreshLucideIcons();
}

btnHeaderStartStop.addEventListener('click', async () => {
  let result;
  const wasStopped = currentBotState === 'STOPPED';
  if (wasStopped) {
    document.activeElement?.blur();
    await Promise.resolve();
    await flushPendingConfigSaves();
    result = await window.botAPI.start();
  } else if (currentBotState === 'PAUSED') {
    result = await window.botAPI.resume();
  } else {
    result = await window.botAPI.stop();
  }
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Bot lifecycle request failed');
  } else if (wasStopped) {
    runtimeDryRun = savedDryRun;
    renderBotModeState();
    markConfigApplied();
  }
});

btnHeaderApplyConfig?.addEventListener('click', async () => {
  if (configApplyInFlight) return;
  configApplyInFlight = true;
  btnHeaderApplyConfig.disabled = true;
  try {
    await flushPendingConfigSaves();
    const revision = pendingConfigRevision;
    const result = await window.botAPI.applyConfig();
    if (!result?.success) {
      appendLog('ERROR', result?.error || 'Could not apply configuration');
      return;
    }
    // A field can finish saving while the engine restart is in flight. Only
    // clear the indicator through the revision that was actually applied.
    markConfigApplied(revision);
    runtimeDryRun = savedDryRun;
    renderBotModeState();
    appendLog('INFO', result.restarted
      ? 'Configuration applied; the bot restarted with the new settings.'
      : 'Configuration applied.');
    if (Number(result.loadouts?.dryRun) > 0) {
      appendLog('WARN', 'Quick Sets were not changed because Dry Run is enabled.');
    } else if (Number(result.loadouts?.applied) > 0) {
      appendLog('INFO', `Applied ${result.loadouts.applied} configured PvE Quick Set${result.loadouts.applied === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    appendLog('ERROR', `Could not apply configuration: ${error.message}`);
  } finally {
    configApplyInFlight = false;
    btnHeaderApplyConfig.disabled = false;
    renderPendingConfigState();
  }
});

btnAddNewAccount.addEventListener('click', () => {
  window.botAPI.openAddAccountWindow();
});

menuAddAccountBtn.addEventListener('click', () => {
  window.botAPI.openAddAccountWindow();
});

menuViewBrowserBtn.addEventListener('click', () => {
  window.botAPI.openBrowserView();
});

menuPauseResumeBtn.addEventListener('click', async () => {
  const result = currentBotState === 'PAUSED' ? await window.botAPI.resume() : await window.botAPI.pause();
  if (!result?.success) appendLog('ERROR', result?.error || 'Pause/resume request failed');
});

menuSavedAccountsBtn.addEventListener('click', () => {
  modalSavedAccounts.style.display = 'flex';
  refreshAccounts();
});

btnCloseModal.addEventListener('click', () => {
  modalSavedAccounts.style.display = 'none';
});

menuLogoutBtn.addEventListener('click', () => {
  performLogout();
});

btnHeaderQuit.addEventListener('click', () => {
  if (confirm('Are you sure you want to quit?')) {
    window.botAPI.quitApp();
  }
});

btnSaveScheduler.addEventListener('click', async () => {
  const gateMinSeconds = Number(inputGateMinDelaySeconds.value);
  const gateMaxSeconds = Number(inputGateMaxDelaySeconds.value);
  const dungeonMinSeconds = Number(inputDungeonMinDelaySeconds.value);
  const dungeonMaxSeconds = Number(inputDungeonMaxDelaySeconds.value);
  const lootScanIntervalMinutes = Number(inputLootScanIntervalMinutes?.value);
  const targetScanIntervalSeconds = Number(inputTargetScanIntervalSeconds?.value);
  if (![gateMinSeconds, gateMaxSeconds, dungeonMinSeconds, dungeonMaxSeconds].every(Number.isFinite)
    || gateMinSeconds < 1.05 || gateMaxSeconds < gateMinSeconds
    || dungeonMinSeconds < 0.01 || dungeonMaxSeconds < dungeonMinSeconds
    || !Number.isFinite(lootScanIntervalMinutes) || lootScanIntervalMinutes < 1
    || !Number.isFinite(targetScanIntervalSeconds) || targetScanIntervalSeconds < 1) {
    appendLog('ERROR', 'Gate delays require at least 1.05 sec; Dungeon delays require at least 0.01 sec; target rescans require at least 1 second; Lootable scans require at least 1 minute; each maximum must be at least its minimum.');
    return;
  }
  if (!chkDryRun.checked && !confirm('Enable live actions? The bot will send join, attack, heal, loot, and reaction requests to the game.')) {
    chkDryRun.checked = true;
    return;
  }
  const result = await updateCanonicalConfig({
    scheduler: {
      attackIntervals: {
        gate: { minDelay: Math.round(gateMinSeconds * 1000), maxDelay: Math.round(gateMaxSeconds * 1000) },
        dungeon: { minDelay: Math.round(dungeonMinSeconds * 1000), maxDelay: Math.round(dungeonMaxSeconds * 1000) },
      },
      lootScanIntervalMinutes: Math.max(1, Math.trunc(lootScanIntervalMinutes)),
      targetScanIntervalSeconds: Math.max(1, Math.trunc(targetScanIntervalSeconds)),
    },
    safety: { dryRun: Boolean(chkDryRun.checked) },
  });
  if (result?.success) {
    loadSchedulerConfiguration(result.config);
    appendLog('INFO', `Attack pacing updated: Gates ${gateMinSeconds}-${gateMaxSeconds}s; Dungeons ${dungeonMinSeconds}-${dungeonMaxSeconds}s (${chkDryRun.checked ? 'dry run' : 'live mode'})`);
    alert('Bot pacing saved!');
  } else {
    appendLog('ERROR', result?.error || 'Could not save settings');
  }
});

// IPC Event Listeners
window.botAPI.onStateChange((data) => {
  if (data && data.state) {
    updateBotStatus(data.state);
  }
});

window.botAPI.onTelemetry((telemetry) => {
  if (!telemetry) return;
  latestProgressionTelemetry = telemetry.progression || null;
  const lootRevision = Number(telemetry.progression?.lootRevision);
  if (Number.isFinite(lootRevision) && lootRevision !== latestProgressionLootRevision) {
    syncProgressionLootSnapshot(lootRevision).catch(error => {
      appendLog('WARN', `Progression loot snapshot could not be synchronized: ${error.message}`);
    });
  }
  renderProgressionStatus();
  if (telemetry.state) updateBotStatus(telemetry.state);
  renderOverviewTelemetry(telemetry);
  scheduleVisibleActivityHistoryRefresh(telemetry.currentAction);
});

window.botAPI.onLootDiscovery?.(snapshot => {
  if (!snapshot?.areaKey) return;
  lootDiscoveryCache.set(snapshot.areaKey, snapshot);
  if (subviewLootingHistory?.style.display !== 'none' && lootableAreaSelect?.value === snapshot.areaKey) {
    // Background discovery publishes a cheap raw snapshot. Ask the shared
    // service for its enriched database view before replacing visible values.
    refreshLootableArea(false).catch(error => appendLog('WARN', error.message));
  }
});

function renderOverviewTelemetry(telemetry) {
  if (!telemetry) return;
  const runtime = telemetry.runtimeStatus || {};
  if (botActionText) botActionText.textContent = telemetry.currentAction || '-';
  if (botTargetText) botTargetText.textContent = telemetry.target?.name || '-';
  if (overviewTargetName) overviewTargetName.textContent = telemetry.target?.name || runtime.title || 'Nothing running';
  if (overviewActionReason) overviewActionReason.textContent = runtime.detail || telemetry.currentReason || 'Waiting for the next decision.';
  if (overviewRuntimeBadge) {
    const kind = String(runtime.kind || 'active').toLowerCase();
    overviewRuntimeBadge.textContent = runtime.title || telemetry.state || 'Working';
    overviewRuntimeBadge.className = `runtime-status-badge is-${kind}`;
  }
  const currentDamage = Number(telemetry.target?.userDmg || 0);
  const targetDamage = Number(telemetry.target?.targetDamage || 0);
  const progressPercent = targetDamage > 0 ? Math.min(100, Math.max(0, (currentDamage / targetDamage) * 100)) : 0;
  if (overviewProgressFill) overviewProgressFill.style.width = `${progressPercent}%`;
  if (overviewProgressText) {
    overviewProgressText.textContent = targetDamage > 0
      ? `${currentDamage.toLocaleString()} / ${targetDamage.toLocaleString()}`
      : '-';
  }
  if (overviewModuleName) overviewModuleName.textContent = telemetry.module?.displayName || telemetry.module?.label || 'Idle';
  if (overviewConnectionText) {
    const autoFarmModule = telemetry.module?.id === 'auto_farm';
    overviewConnectionText.textContent = autoFarmModule
      ? (telemetry.autoFarm?.running ? 'Server Auto Farm running' : 'Server Auto Farm starting or paused')
      : telemetry.connection?.connected ? 'Game session connected' : 'Game session unavailable';
    overviewConnectionText.classList.toggle('is-active', autoFarmModule && telemetry.autoFarm?.running === true);
  }
  const eligibleLootCount = Number(telemetry.progression?.eligibleLootCount) || 0;
  if (overviewProgressionState) {
    overviewProgressionState.textContent = telemetry.state === 'STOPPED' && eligibleLootCount > 0
      ? `${eligibleLootCount.toLocaleString()} eligible · press Start`
      : (telemetry.progression?.status || 'Monitoring');
  }
  if (overviewProgressionXp) {
    const eligibleXp = Number(telemetry.progression?.eligibleLootXp);
    overviewProgressionXp.textContent = `Eligible loot XP: ${Number.isFinite(eligibleXp) ? eligibleXp.toLocaleString() : '-'}`;
  }
  const runStats = telemetry.stats || {};
  if (overviewSessionKills) overviewSessionKills.textContent = (Number(runStats.monstersKilled) || 0).toLocaleString();
  if (overviewSessionLoot) overviewSessionLoot.textContent = (Number(runStats.lootCollected) || 0).toLocaleString();
  if (overviewSessionDamage) overviewSessionDamage.textContent = (Number(runStats.damageDealt) || 0).toLocaleString();
  if (overviewSessionStaminaPots) {
    const staminaPots = Object.values(runStats.staminaPotionsUsed || {}).reduce((total, value) => total + (Number(value) || 0), 0);
    overviewSessionStaminaPots.textContent = staminaPots.toLocaleString();
  }
  if (overviewSessionManaPots) {
    const manaPots = Object.values(runStats.manaPotionsUsed || {}).reduce((total, value) => total + (Number(value) || 0), 0);
    overviewSessionManaPots.textContent = manaPots.toLocaleString();
  }
  if (overviewSessionHealthPots) overviewSessionHealthPots.textContent = (Number(runStats.healthPotionsUsed) || 0).toLocaleString();
  if (overviewSessionErrors) overviewSessionErrors.textContent = (Number(runStats.errors) || 0).toLocaleString();
  renderOverviewPotionCounters(telemetry.potions);
  renderBotSetupResourceCounters(telemetry);
  renderMonsterPhasePvpTelemetry(telemetry.monsterPhasePvp);
  renderProgressionStaminaPotionCounters(telemetry);
  runtimeDryRun = telemetry.dryRun !== false;
  renderBotModeState();
}

function renderBotSetupResourceCounters(telemetry = {}) {
  const runStats = telemetry.stats || {};
  const available = { health: 0, smallMana: 0, largeMana: 0 };
  for (const item of telemetry.potions?.items || []) {
    const quantity = Math.max(0, Number(item?.quantity) || 0);
    if (item?.category === 'health') available.health += quantity;
    if (item?.category === 'mana' && item?.type === 'small') available.smallMana += quantity;
    if (item?.category === 'mana' && item?.type === 'large') available.largeMana += quantity;
  }
  const recognized = telemetry.potions?.recognized === true;
  if (healthDeathsUsed) healthDeathsUsed.textContent = `${Math.max(0, Number(runStats.deaths) || 0).toLocaleString()} deaths`;
  if (healthPotsUsed) healthPotsUsed.textContent = `${Math.max(0, Number(runStats.healthPotionsUsed) || 0).toLocaleString()} used`;
  if (healthPotsAvailable) healthPotsAvailable.textContent = recognized ? `${available.health.toLocaleString()} left` : '— left';
  if (smallManaPotsUsed) smallManaPotsUsed.textContent = `${Math.max(0, Number(runStats.manaPotionsUsed?.small) || 0).toLocaleString()} used`;
  if (smallManaPotsAvailable) smallManaPotsAvailable.textContent = recognized ? `${available.smallMana.toLocaleString()} left` : '— left';
  if (largeManaPotsUsed) largeManaPotsUsed.textContent = `${Math.max(0, Number(runStats.manaPotionsUsed?.large) || 0).toLocaleString()} used`;
  if (largeManaPotsAvailable) largeManaPotsAvailable.textContent = recognized ? `${available.largeMana.toLocaleString()} left` : '— left';
}

function renderMonsterPhasePvpTelemetry(phase) {
  if (!overviewMonsterPhasePvpPanel) return;
  const active = phase?.active === true;
  overviewMonsterPhasePvpPanel.style.display = active ? 'block' : 'none';
  if (!active) return;
  const labels = {
    opening: 'Opening duel',
    fighting: 'Fighting automatically',
    complete: phase?.winnerSide === 'ally' ? 'Won · returning to PvE' : 'Duel ended',
    error: 'Watcher error',
  };
  const label = labels[phase.status] || String(phase.status || 'Fighting automatically');
  if (monsterPhasePvpStatus) monsterPhasePvpStatus.textContent = label;
  if (monsterPhasePvpOpponent) monsterPhasePvpOpponent.textContent = phase.targetName || 'Phase opponent';
  if (monsterPhasePvpActiveId) monsterPhasePvpActiveId.textContent = phase.activeId || '—';
  if (monsterPhasePvpWatcher) monsterPhasePvpWatcher.textContent = phase.watcherActive ? 'Connected' : 'Starting';
  if (monsterPhasePvpLiveBadge) {
    monsterPhasePvpLiveBadge.textContent = phase.status === 'complete' ? 'Complete' : phase.status === 'error' ? 'Error' : 'Live';
    monsterPhasePvpLiveBadge.classList.toggle('is-error', phase.status === 'error');
  }
}

function renderOverviewPotionCounters(potions) {
  if (!overviewPotionCounters) return;
  overviewPotionCounters.replaceChildren();
  if (potions?.recognized !== true) {
    const message = document.createElement('span');
    message.className = 'overview-card-detail';
    message.textContent = 'Read when a battle page is available.';
    overviewPotionCounters.appendChild(message);
    return;
  }
  const quantities = new Map();
  for (const item of potions.items || []) {
    if (!['stamina', 'health', 'mana'].includes(item.category)) continue;
    if (/\bxp\s*boost\b/i.test(String(item.name || ''))) continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    quantities.set(name, (quantities.get(name) || 0) + Math.max(0, Number(item.quantity) || 0));
  }
  if (quantities.size === 0) {
    const message = document.createElement('span');
    message.className = 'overview-card-detail';
    message.textContent = 'No supported potions are present in the battle inventory.';
    overviewPotionCounters.appendChild(message);
    return;
  }
  for (const [name, quantity] of [...quantities].sort(([left], [right]) => left.localeCompare(right))) {
    const counter = document.createElement('span');
    counter.className = 'overview-potion-counter';
    const label = document.createElement('span');
    label.textContent = `${name} `;
    const value = document.createElement('strong');
    value.textContent = quantity.toLocaleString();
    counter.append(label, value);
    overviewPotionCounters.appendChild(counter);
  }
}

window.botAPI.onLog((data) => {
  if (data) {
    appendLog(data.level, data.message);
  }
});

window.botAPI.onCaptchaAlert((data) => {
  if (data && data.active) {
    updateBotStatus('CHALLENGE_WAIT');
    appendLog('WARN', 'Cloudflare Captcha detected. Please solve it in the game window.');
  }
});

// Live Stats Subscriber & Color Logic for Stamina (+Next)
function renderPlayerStats(stats) {
  if (!stats) return;
  latestStats = stats;
  updateAutoFarmEligibility(stats);
  if (Number.isFinite(Number(stats.serverTzOff))) serverTzOffsetSeconds = Number(stats.serverTzOff);

  const currentStamina = (stats.stamina && stats.stamina.current) !== undefined ? stats.stamina.current : 0;
  const maxStamina = (stats.stamina && stats.stamina.max) || stats.totalStamina || 0;
  const nextInc = stats.nextStaminaIncrease || stats.hourlyRefill || 40;

  if (statStamina && (currentStamina > 0 || maxStamina > 0)) {
    statStamina.textContent = `${currentStamina} / ${maxStamina}`;
  }

  if (statStaminaNext && (currentStamina > 0 || maxStamina > 0)) {
    statStaminaNext.style.display = 'inline';
    statStaminaNext.textContent = `(+${nextInc})`;

    // If next stamina + current stamina > max stamina, display in red, else green
    if (currentStamina + nextInc > maxStamina) {
      statStaminaNext.style.color = '#ff5252';
    } else {
      statStaminaNext.style.color = '#4caf50';
    }
  }

  if (statHealth && stats.hp && (Number(stats.hp.current) >= 0 || Number(stats.hp.max) > 0)) {
    statHealth.textContent = `${stats.hp.current ?? '-'} / ${stats.hp.max ?? '-'}`;
  }
  if (statMana && stats.mp && (Number(stats.mp.current) >= 0 || Number(stats.mp.max) > 0)) {
    statMana.textContent = `${stats.mp.current ?? '-'} / ${stats.mp.max ?? '-'}`;
  }

  renderCombatPlayerStats(stats);
  if (statGold && stats.gold && stats.gold !== '0') statGold.textContent = stats.gold;
  if (statGems && stats.gems && stats.gems !== '0') statGems.textContent = stats.gems;
  if (statLevel && stats.level && stats.level > 0) statLevel.textContent = `Lv. ${stats.level} (${stats.expPercent || '0%'})`;
  renderProgressionStatus(stats);

  if (statEnergy && ((stats.farmedEnergy !== undefined && stats.farmedEnergy !== null) || stats.energy !== undefined)) {
    const energyVal = (stats.farmedEnergy !== undefined && stats.farmedEnergy !== null) ? stats.farmedEnergy : stats.energy;
    statEnergy.textContent = `${energyVal} / 1000`;
  }
}

window.botAPI.onStats((stats) => {
  renderPlayerStats(stats);
});

// Real-Time Log Streaming from Main Process
if (window.botAPI.onLogEntry) {
  window.botAPI.onLogEntry((entry) => {
    if (!entry) return;
    const { type, line, action } = entry;
    const logLine = line || action || '';

    if (type === 'client' || type === 'api') {
      appendDeveloperLogLine(serverLogsText, logLine);
      // BotEngine events already arrived through bot:log. Logger writes an
      // exact bracket-prefixed copy for the file; do not duplicate it in the
      // Overview stream.
      if (/^\[(?:INFO|WARN|ERROR|ACTION|DEBUG)\]\s/i.test(String(action || ''))) return;
      appendLog('INFO', logLine.replace(/^\[.*?\]\s*/, ''));
    } else if (type === 'user') {
      appendDeveloperLogLine(userLogsText, logLine);
      appendLog('USER', logLine.replace(/^\[.*?\]\s*/, ''));
    }
  });
}

// Home Tab Stats Refresh Button
if (btnRefreshStats) {
  btnRefreshStats.addEventListener('click', async () => {
    btnRefreshStats.disabled = true;
    btnRefreshStats.classList.add('spinning');
    appendLog('INFO', 'Refreshing player stats from server...');
    try {
      const res = await window.botAPI.refreshStats();
      if (res && res.success) {
        const statsData = res.stats || res.player;
        if (statsData) {
          renderPlayerStats(statsData);
        }
        appendLog('INFO', 'Player stats refreshed successfully.');
      } else {
        appendLog('WARN', `Stats refresh response: ${res?.error || 'No update'}`);
      }
    } catch (err) {
      appendLog('ERROR', `Failed to refresh stats: ${err.message}`);
    } finally {
      btnRefreshStats.classList.remove('spinning');
      btnRefreshStats.disabled = false;
      refreshLucideIcons();
    }
  });
}
