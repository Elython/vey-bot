// Tab Switching
window.switchTab = function (tab) {
  if (tab === 'autoFarm' && !autoFarmEligibility.eligible) {
    const message = autoFarmEligibility.known
      ? `Auto Farm requires Level 400 (current Level: ${autoFarmEligibility.level}).`
      : 'Auto Farm availability is waiting for account Level stats.';
    appendLog('WARN', message);
    return;
  }
  currentTab = tab;
  tabHomeBtn.classList.toggle('active', tab === 'home');
  tabBotSetupBtn.classList.toggle('active', tab === 'botSetup');
  tabAutoFarmBtn?.classList.toggle('active', tab === 'autoFarm');
  tabCombatBtn?.classList.toggle('active', tab === 'combat');
  tabEnergyFarmBtn.classList.toggle('active', tab === 'energyFarm');
  tabNPCConfigBtn.classList.toggle('active', tab === 'npcConfig');
  tabLootConfigBtn.classList.toggle('active', tab === 'lootConfig');
  tabStatisticsBtn?.classList.toggle('active', tab === 'statistics');
  tabBattlePassBtn?.classList.toggle('active', tab === 'battlePass');
  tabAdventureQuestsBtn?.classList.toggle('active', tab === 'adventureQuests');
  tabBossHuntBtn?.classList.toggle('active', tab === 'bossHunt');
  if (tabConsoleBtn) tabConsoleBtn.classList.toggle('active', tab === 'console');

  const homeShellVisible = tab === 'home' || tab === 'botSetup' || tab === 'combat';
  viewHome.style.display = homeShellVisible ? 'flex' : 'none';
  if (viewAutoFarm) viewAutoFarm.style.display = tab === 'autoFarm' ? 'flex' : 'none';
  viewEnergyFarm.style.display = tab === 'energyFarm' ? 'flex' : 'none';
  viewNPCConfig.style.display = tab === 'npcConfig' ? 'flex' : 'none';
  viewLootConfig.style.display = tab === 'lootConfig' ? 'flex' : 'none';
  if (viewStatistics) viewStatistics.style.display = tab === 'statistics' ? 'flex' : 'none';
  if (viewBattlePass) viewBattlePass.style.display = tab === 'battlePass' ? 'flex' : 'none';
  if (viewAdventureQuests) viewAdventureQuests.style.display = tab === 'adventureQuests' ? 'flex' : 'none';
  if (viewBossHunt) viewBossHunt.style.display = tab === 'bossHunt' ? 'flex' : 'none';
  if (viewConsole) viewConsole.style.display = tab === 'console' ? 'flex' : 'none';

  if (tab === 'console') {
    switchConsoleSubTab('user');
  }
  if (tab === 'energyFarm') {
    loadMangaList();
    loadFarmSettings();
  }
  if (tab === 'npcConfig') switchTargetWorkspaceTab('config');
  if (tab === 'autoFarm') switchAutoFarmWorkspaceTab('general');
  if (tab === 'lootConfig') switchLootingWorkspaceTab('config');
  if (tab === 'statistics') refreshStatistics();
  if (tab === 'battlePass') refreshBattlePass();
  if (tab === 'adventureQuests') refreshAdventureQuests();
  if (tab === 'bossHunt') refreshBossHunt(false);
  if (homeStatsBar) homeStatsBar.style.display = tab === 'home' ? 'flex' : 'none';
  if (homeRuntimeStatus) homeRuntimeStatus.style.display = tab === 'home' ? 'flex' : 'none';
  if (overviewCurrentPanel) overviewCurrentPanel.style.display = tab === 'home' ? 'flex' : 'none';
  if (overviewInfoGrid) overviewInfoGrid.style.display = tab === 'home' ? 'grid' : 'none';
  if (overviewConsolePanel) overviewConsolePanel.style.display = tab === 'home' ? 'flex' : 'none';
  renderCubePvpStatus?.(latestCubePvpStatus);
  if (homeSetupTabs) homeSetupTabs.style.display = tab === 'botSetup' ? 'flex' : 'none';
  if (tab === 'botSetup') window.switchHomeSubTab('general');
  if (tab === 'combat') window.switchHomeSubTab('equipment');
  if (tab !== 'botSetup' && tab !== 'combat') {
    for (const view of [subviewHomeGeneral, subviewHomeEquipment, subviewHomeBot]) {
      if (view) view.style.display = 'none';
    }
  }
  showTabGuideOnce(tab, activeAccount);
};

document.querySelectorAll('[data-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchTab(button.dataset.tab));
});

// Energy Farm Subtab Switching
window.switchEnergySubTab = function (subtab) {
  subtabStaminaGeneralBtn.classList.toggle('active', subtab === 'strategy');
  subtabProgressionLootBtn?.classList.toggle('active', subtab === 'history');
  subtabChaptersBtn.classList.toggle('active', subtab === 'chapters');

  subviewStaminaGeneral.style.display = subtab === 'strategy' ? 'flex' : 'none';
  if (subviewProgressionLoot) subviewProgressionLoot.style.display = subtab === 'history' ? 'flex' : 'none';
  subviewChaptersFarm.style.display = subtab === 'chapters' ? 'flex' : 'none';
  if (subtab === 'history' && activeAccount) refreshProgressionHistory();
};

document.querySelectorAll('[data-energy-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchEnergySubTab(button.dataset.energyTab));
});

// Log-file Subtab Switching (Developer Mode)
window.switchConsoleSubTab = async function (subtab) {
  subtabConsoleUserBtn.classList.toggle('active', subtab === 'user');
  subtabConsoleServerBtn.classList.toggle('active', subtab === 'server');

  subviewConsoleUser.style.display = subtab === 'user' ? 'flex' : 'none';
  subviewConsoleServer.style.display = subtab === 'server' ? 'flex' : 'none';

  if (subtab === 'user') {
    await refreshUserLogs();
  } else if (subtab === 'server') {
    await refreshServerLogs();
  }
};

document.querySelectorAll('[data-console-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchConsoleSubTab(button.dataset.consoleTab));
});

async function refreshUserLogs() {
  if (userLogsText) {
    userLogsText.textContent = 'Loading user logs...';
    try {
      const logs = await window.botAPI.getUserLogs();
      userLogsText.textContent = logs ? boundedDeveloperLogText(logs) : 'No user logs found.';
      userLogsText.scrollTop = userLogsText.scrollHeight;
    } catch (e) {
      userLogsText.textContent = `Error loading user logs: ${e.message}`;
    }
  }
}

async function refreshServerLogs() {
  if (serverLogsText) {
    serverLogsText.textContent = 'Loading client logs...';
    try {
      const logs = (window.botAPI.getClientLogs ? await window.botAPI.getClientLogs() : await window.botAPI.getAutoLogs());
      serverLogsText.textContent = logs ? boundedDeveloperLogText(logs) : 'No client logs found.';
      serverLogsText.scrollTop = serverLogsText.scrollHeight;
    } catch (e) {
      serverLogsText.textContent = `Error loading client logs: ${e.message}`;
    }
  }
}

if (btnClearLiveLogs) {
  btnClearLiveLogs.addEventListener('click', () => {
    if (logConsole) logConsole.innerHTML = '';
  });
}
logCategoryFilter?.addEventListener('change', applyLiveLogFilter);
if (btnRefreshUserLogs) {
  btnRefreshUserLogs.addEventListener('click', refreshUserLogs);
}
if (btnRefreshServerLogs) {
  btnRefreshServerLogs.addEventListener('click', refreshServerLogs);
}

async function applyAreaCatalogChange(nextCatalog) {
  const result = await updateCanonicalConfig({ areaCatalog: nextCatalog });
  if (!result?.success) throw new Error(result?.error || 'Could not update Gates catalog');
  areaCatalogConfig = result.config?.areaCatalog || nextCatalog;
  monsterAreaCache.clear();
  lootAreaCache.clear();
  await refreshMonsterCatalog(false);
  loadHomeConfiguration(result.config);
  return result.config;
}

menuRefreshMonsterCatalogBtn?.addEventListener('click', async () => {
  gearDropdown.classList.remove('show');
  if (!activeAccount) {
    appendLog('WARN', 'Log in before refreshing the monster catalog.');
    return;
  }
  menuRefreshMonsterCatalogBtn.disabled = true;
  const original = menuRefreshMonsterCatalogBtn.innerHTML;
  setButtonIcon(menuRefreshMonsterCatalogBtn, 'loader-circle', 'Refreshing monster catalog…');
  let collected = 0;
  let applied = 0;
  const errors = [];
  try {
    await refreshMonsterCatalog(false);
    for (const area of monsterCatalog) {
      const result = await window.botAPI.collectMonsterStatsForArea(area.key);
      if (!result?.success) {
        errors.push(`${area.label}: ${result?.error || 'scan failed'}`);
        continue;
      }
      collected += Number(result.collected || 0) + Number(result.cached || 0);
      for (const monsterKey of result.conflictKeys || []) {
        const accepted = await window.botAPI.applyObservedMonsterStats(area.key, monsterKey);
        if (accepted?.success) applied += 1;
        else errors.push(`${area.label}/${monsterKey}: ${accepted?.error || 'changed stats could not be applied'}`);
      }
      for (const error of result.errors || []) errors.push(`${area.label}/${error.monsterKey || 'unknown'}: ${error.error || error.message}`);
    }
    monsterAreaCache.clear();
    lootAreaCache.clear();
    appendLog(errors.length ? 'WARN' : 'INFO', `Monster catalog refresh finished: ${collected} monster type(s) read, ${applied} changed record(s) applied, ${errors.length} error(s).`);
    for (const error of errors.slice(0, 20)) appendLog('WARN', error);
  } catch (error) {
    appendLog('ERROR', `Monster catalog refresh failed: ${error.message}`);
  } finally {
    menuRefreshMonsterCatalogBtn.innerHTML = original;
    menuRefreshMonsterCatalogBtn.disabled = false;
    refreshLucideIcons(menuRefreshMonsterCatalogBtn);
  }
});

async function renderGatesManager() {
  if (!gatesManagerContent) return;
  gatesManagerContent.innerHTML = '<div class="empty-state">Loading Gates…</div>';
  const areas = await refreshMonsterCatalog(true);
  const table = document.createElement('div'); table.className = 'gates-manager-table';
  const header = document.createElement('div'); header.className = 'gates-manager-row gates-manager-header';
  for (const label of ['Name', 'Type', 'ID', 'Wave', 'Status', 'Action']) { const cell = document.createElement('span'); cell.textContent = label; header.append(cell); }
  table.append(header);
  for (const area of areas.filter(entry => ['gate', 'event'].includes(entry.type))) {
    const row = document.createElement('div'); row.className = 'gates-manager-row';
    const name = document.createElement('span'); name.textContent = area.label; name.title = area.key;
    const type = document.createElement('span'); type.textContent = area.type === 'event' ? 'Event' : 'Gate';
    const id = document.createElement('span'); id.textContent = String(area.eventId || area.gateId || '—');
    const wave = document.createElement('span'); wave.textContent = String(area.wave || '—');
    const status = document.createElement('span'); status.textContent = area.hidden ? 'Hidden' : area.custom ? 'Custom' : 'Built-in';
    const action = document.createElement('button'); action.type = 'button'; action.className = 'btn btn-sm';
    action.textContent = area.custom ? 'Delete' : area.hidden ? 'Show' : 'Hide';
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        const custom = area.custom ? (areaCatalogConfig.custom || []).filter(entry => entry.key !== area.key) : [...(areaCatalogConfig.custom || [])];
        const hidden = area.custom
          ? (areaCatalogConfig.hidden || []).filter(key => key !== area.key)
          : area.hidden
            ? (areaCatalogConfig.hidden || []).filter(key => key !== area.key)
            : [...new Set([...(areaCatalogConfig.hidden || []), area.key])];
        await applyAreaCatalogChange({ custom, hidden });
        await renderGatesManager();
      } catch (error) {
        appendLog('ERROR', `Gates update failed: ${error.message}`);
        action.disabled = false;
      }
    });
    row.append(name, type, id, wave, status, action); table.append(row);
  }
  gatesManagerContent.replaceChildren(table);
}

menuGatesBtn?.addEventListener('click', async () => {
  gearDropdown.classList.remove('show');
  if (modalGates) modalGates.style.display = 'flex';
  await renderGatesManager();
});
btnCloseGates?.addEventListener('click', () => { if (modalGates) modalGates.style.display = 'none'; });
modalGates?.addEventListener('click', event => { if (event.target === modalGates) modalGates.style.display = 'none'; });
btnAddGateArea?.addEventListener('click', async () => {
  const type = selectNewAreaType?.value === 'event' ? 'event' : 'gate';
  const label = inputNewAreaName?.value.trim() || '';
  const routeId = Math.trunc(Number(inputNewAreaId?.value) || 0);
  const wave = Math.trunc(Number(inputNewAreaWave?.value) || 0);
  if (!label || routeId < 1 || wave < 1) {
    appendLog('ERROR', 'A custom Gate/Event needs a name, positive ID, and positive wave.');
    return;
  }
  btnAddGateArea.disabled = true;
  try {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 45) || 'area';
    const key = `custom_${type}_${slug}_${Date.now().toString(36)}`;
    const entry = { key, label, type, wave, ...(type === 'event' ? { eventId: routeId } : { gateId: routeId }) };
    await applyAreaCatalogChange({ custom: [...(areaCatalogConfig.custom || []), entry], hidden: areaCatalogConfig.hidden || [] });
    if (inputNewAreaName) inputNewAreaName.value = '';
    if (inputNewAreaId) inputNewAreaId.value = '';
    if (inputNewAreaWave) inputNewAreaWave.value = '';
    await renderGatesManager();
  } catch (error) {
    appendLog('ERROR', `Could not add Gate/Event: ${error.message}`);
  } finally {
    btnAddGateArea.disabled = false;
  }
});

function closeClearHistoryModal() {
  if (modalClearHistory) modalClearHistory.style.display = 'none';
  setWorkspaceStatus(clearHistoryStatus, '');
}

function updateClearHistoryRange() {
  if (inputClearHistoryBefore) inputClearHistoryBefore.disabled = radioClearHistoryBefore?.checked !== true;
}

menuClearHistoryBtn?.addEventListener('click', () => {
  gearDropdown.classList.remove('show');
  if (inputClearHistoryBefore && !inputClearHistoryBefore.value) {
    const today = new Date();
    const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    inputClearHistoryBefore.value = local;
  }
  updateClearHistoryRange();
  if (modalClearHistory) modalClearHistory.style.display = 'flex';
});
btnCloseClearHistory?.addEventListener('click', closeClearHistoryModal);
btnCancelClearHistory?.addEventListener('click', closeClearHistoryModal);
modalClearHistory?.addEventListener('click', event => { if (event.target === modalClearHistory) closeClearHistoryModal(); });
radioClearHistoryAll?.addEventListener('change', updateClearHistoryRange);
radioClearHistoryBefore?.addEventListener('change', updateClearHistoryRange);
btnConfirmClearHistory?.addEventListener('click', async () => {
  const kinds = [];
  if (chkClearAttackHistory?.checked) kinds.push('target');
  if (chkClearLootHistory?.checked) kinds.push('loot');
  if (kinds.length === 0) {
    setWorkspaceStatus(clearHistoryStatus, 'Select at least one history type.', 'error');
    return;
  }
  let before = null;
  if (radioClearHistoryBefore?.checked) {
    if (!inputClearHistoryBefore?.value) {
      setWorkspaceStatus(clearHistoryStatus, 'Choose a cutoff date.', 'error');
      return;
    }
    before = new Date(`${inputClearHistoryBefore.value}T00:00:00`).toISOString();
  }
  btnConfirmClearHistory.disabled = true;
  setWorkspaceStatus(clearHistoryStatus, 'Clearing…');
  try {
    const result = await window.botAPI.clearActivityHistory(kinds, before);
    if (!result?.success) throw new Error(result?.error || 'History could not be cleared');
    const removed = Number(result.removed?.target || 0) + Number(result.removed?.loot || 0);
    setWorkspaceStatus(clearHistoryStatus, `${removed} saved action${removed === 1 ? '' : 's'} removed.`, 'success');
    if (kinds.includes('target')) await refreshTargetHistory();
    if (kinds.includes('loot')) await refreshProgressionHistory();
  } catch (error) {
    setWorkspaceStatus(clearHistoryStatus, error.message, 'error');
  } finally {
    btnConfirmClearHistory.disabled = false;
  }
});

function stopPurgeCountdown() {
  if (purgeCountdownTimer) clearInterval(purgeCountdownTimer);
  purgeCountdownTimer = null;
}

function closePurgeModal() {
  stopPurgeCountdown();
  if (modalPurge) modalPurge.style.display = 'none';
  setWorkspaceStatus(purgeStatus, '');
}

function startPurgeCountdown() {
  stopPurgeCountdown();
  let seconds = 5;
  if (btnConfirmPurge) {
    btnConfirmPurge.disabled = true;
    setButtonIcon(btnConfirmPurge, 'trash-2', `Purge in ${seconds}s`);
  }
  purgeCountdownTimer = setInterval(() => {
    seconds -= 1;
    if (!btnConfirmPurge) return;
    if (seconds > 0) {
      setButtonIcon(btnConfirmPurge, 'trash-2', `Purge in ${seconds}s`);
      return;
    }
    stopPurgeCountdown();
    btnConfirmPurge.disabled = false;
    setButtonIcon(btnConfirmPurge, 'trash-2', 'Purge account');
  }, 1000);
}

menuPurgeBtn?.addEventListener('click', () => {
  gearDropdown.classList.remove('show');
  if (!activeAccount || !modalPurge) return;
  if (purgeAccountName) purgeAccountName.textContent = activeAccount;
  setWorkspaceStatus(purgeStatus, 'The confirmation unlocks after 5 seconds.');
  modalPurge.style.display = 'flex';
  startPurgeCountdown();
});
btnClosePurge?.addEventListener('click', closePurgeModal);
btnCancelPurge?.addEventListener('click', closePurgeModal);
modalPurge?.addEventListener('click', event => { if (event.target === modalPurge) closePurgeModal(); });
btnConfirmPurge?.addEventListener('click', async () => {
  if (btnConfirmPurge.disabled || !activeAccount) return;
  stopPurgeCountdown();
  btnConfirmPurge.disabled = true;
  if (btnClosePurge) btnClosePurge.disabled = true;
  if (btnCancelPurge) btnCancelPurge.disabled = true;
  setButtonIcon(btnConfirmPurge, 'loader-circle', 'Purging…');
  setWorkspaceStatus(purgeStatus, 'Removing all account-specific data from this device…');
  let result;
  try {
    await flushPendingConfigSaves();
    result = await window.botAPI.purgeActiveAccount();
  } catch (error) {
    result = { success: false, error: error.message };
  }
  if (btnClosePurge) btnClosePurge.disabled = false;
  if (btnCancelPurge) btnCancelPurge.disabled = false;
  closePurgeModal();
  await performLogout({ skipServer: true });
  if (!result?.success) alert(result?.error || 'Account purge was incomplete.');
});

// Gear Dropdown Toggle
gearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  gearDropdown.classList.toggle('show');
});

document.addEventListener('click', () => {
  gearDropdown.classList.remove('show');
});

gearDropdown.addEventListener('click', (e) => {
  e.stopPropagation();
});
