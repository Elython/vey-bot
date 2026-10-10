function getServerDate() {
  const now = new Date();
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utcTime + (serverTzOffsetSeconds * 1000));
}

// Live Footer Clock (Ticking every second from app startup)
function updateClocks() {
  const now = new Date();
  const serverDate = getServerDate();

  if (footerServerTime) {
    footerServerTime.textContent = serverDate.toLocaleTimeString();
  }
  if (footerLocalTime) {
    footerLocalTime.textContent = now.toLocaleTimeString();
  }
}
updateClocks();
setInterval(updateClocks, 1000);

// Collapsible Tree Section Toggle (Safety, Mangas, Running)
window.toggleTreeSection = function (sectionId) {
  const sec = document.getElementById(sectionId);
  if (sec) {
    sec.classList.toggle('collapsed');
  }
};

document.querySelectorAll('[data-tree-section]').forEach(header => {
  header.addEventListener('click', () => window.toggleTreeSection(header.dataset.treeSection));
});

// Segmented Button Config Toggle ([Scheduler] | [Independent])
function setFarmConfig(config, persist = true) {
  currentFarmConfig = config;
  if (btnConfigScheduler) btnConfigScheduler.classList.toggle('active', config === 'scheduler');
  if (btnConfigIndependent) btnConfigIndependent.classList.toggle('active', config === 'independent');
  if (rowIndependentDelay) {
    rowIndependentDelay.style.display = config === 'independent' ? 'flex' : 'none';
  }
  if (persist) saveCurrentFarmSettings();
}

if (btnConfigScheduler) btnConfigScheduler.addEventListener('click', () => setFarmConfig('scheduler'));
if (btnConfigIndependent) btnConfigIndependent.addEventListener('click', () => setFarmConfig('independent'));

// Farm Terminal Output Appender
function appendFarmTerminal(type, message) {
  if (!farmTerminalOutput) return;
  const line = document.createElement('div');
  line.className = `terminal-line text-${type || 'info'}`;
  const serverDate = getServerDate();
  const time = serverDate.toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  farmTerminalOutput.appendChild(line);
  while (farmTerminalOutput.childElementCount > MAX_FARM_LOG_ENTRIES) {
    farmTerminalOutput.firstElementChild?.remove();
  }
  farmTerminalOutput.scrollTop = farmTerminalOutput.scrollHeight;
}

if (btnClearFarmTerminal) {
  btnClearFarmTerminal.addEventListener('click', () => {
    if (farmTerminalOutput) {
      farmTerminalOutput.innerHTML = ("<div class=\"terminal-line text-muted\">" + uiText("[Cleared] Farm terminal log reset.") + "</div>");
    }
  });
}

// Farm Settings Manager (Per-Account & Persistent)
async function loadFarmSettings() {
  if (!activeAccount) return;
  try {
    const settings = await window.botAPI.getFarmSettings(activeAccount);
    if (settings) {
      if (selectFarmModule && settings.module) selectFarmModule.value = settings.module;
      updateFarmModuleUI();
      if (settings.configMode) {
        setFarmConfig(settings.configMode, false);
      }
      if (selectFarmDelay && settings.delay) selectFarmDelay.value = settings.delay;
      if (chkStopMaxStamina) chkStopMaxStamina.checked = settings.stopMaxStamina !== undefined ? Boolean(settings.stopMaxStamina) : true;
      if (inputMaxStaminaFarm) inputMaxStaminaFarm.value = settings.maxStaminaFarm !== undefined ? settings.maxStaminaFarm : 1000;
      if (inputStopHourlyStaminaMin) inputStopHourlyStaminaMin.value = settings.stopHourlyMin !== undefined ? settings.stopHourlyMin : 10;
      if (selectReactionType && settings.reactionType) selectReactionType.value = settings.reactionType;
      if (inputManualChapterCount && settings.manualChapterCount) inputManualChapterCount.value = settings.manualChapterCount;
      if (selectManualManga && settings.lastWorkingManga && [...selectManualManga.options].some(option => option.value === settings.lastWorkingManga)) {
        selectManualManga.value = settings.lastWorkingManga;
      }
      if (workingMangaText) workingMangaText.textContent = settings.lastWorkingManga || '-';
    }
  } catch (err) {
    console.error('Error loading farm settings:', err);
  }
}

async function saveCurrentFarmSettings() {
  if (!activeAccount) return;
  const settings = {
    module: selectFarmModule ? selectFarmModule.value : 'manual',
    configMode: currentFarmConfig,
    delay: selectFarmDelay ? selectFarmDelay.value : '1.0s',
    stopMaxStamina: chkStopMaxStamina ? Boolean(chkStopMaxStamina.checked) : true,
    maxStaminaFarm: parseInt(inputMaxStaminaFarm?.value, 10) || 1000,
    stopHourlyMin: parseInt(inputStopHourlyStaminaMin?.value, 10) || 10,
    reactionType: selectReactionType ? selectReactionType.value : '1',
    manualChapterCount: Math.max(1, parseInt(inputManualChapterCount?.value, 10) || 1),
    lastWorkingManga: workingMangaText ? workingMangaText.textContent : '-',
  };
  try {
    const result = await updateCanonicalConfig({ energyFarming: {
      enabled: settings.module === 'automatic', reactionType: settings.reactionType, chapterSettings: settings,
    } });
    if (!result?.success) appendLog('ERROR', result?.error || 'Chapter settings could not be saved');
  } catch (err) {
    console.error('Error saving farm settings:', err);
  }
}

function updateFarmModuleUI() {
  if (rowManualFarmControls) rowManualFarmControls.style.display = selectFarmModule?.value === 'manual' ? 'flex' : 'none';
}

if (selectFarmModule) selectFarmModule.addEventListener('change', () => {
  updateFarmModuleUI();
  saveCurrentFarmSettings();
});
if (inputManualChapterCount) inputManualChapterCount.addEventListener('change', saveCurrentFarmSettings);
if (selectManualManga) selectManualManga.addEventListener('change', () => {
  if (workingMangaText && selectManualManga.value) workingMangaText.textContent = selectManualManga.value;
  saveCurrentFarmSettings();
});
if (selectFarmDelay) selectFarmDelay.addEventListener('change', saveCurrentFarmSettings);
if (chkStopMaxStamina) chkStopMaxStamina.addEventListener('change', saveCurrentFarmSettings);
if (inputMaxStaminaFarm) inputMaxStaminaFarm.addEventListener('change', saveCurrentFarmSettings);
if (inputStopHourlyStaminaMin) inputStopHourlyStaminaMin.addEventListener('change', saveCurrentFarmSettings);
if (selectReactionType) selectReactionType.addEventListener('change', saveCurrentFarmSettings);

let GATE_MAPS = [
  ['grakthar_1', uiText('Grakthar 1')], ['grakthar_2', uiText('Grakthar 2')], ['grakthar_3', uiText('Grakthar 3')],
  ['olympus_1', uiText('Olympus 1')], ['olympus_hermes', uiText('Olympus Hermes')],
  ['olympus_artemis', uiText('Olympus Artemis')], ['olympus_poseidon', uiText('Olympus Poseidon')],
  ['olympus_ares', uiText('Olympus Ares')], ['olympus_apollo', uiText('Olympus Apollo')],
  ['olympus_athena', uiText('Olympus Athena')], ['olympus_hera', uiText('Olympus Hera')],
  ['olympus_zeus', uiText('Olympus Zeus')],
];
let DUNGEON_MAPS = [
  ['castle_fallen_prince', uiText('Castle of the Fallen Prince')],
  ['shadowbridge_warrens', uiText('Shadowbridge Warrens')],
  ['polyhedral_crucible', uiText('The Polyhedral Crucible')],
];
// Event areas are populated from the active/custom area catalog. Ended events
// are deliberately not kept in this visible bootstrap list.
let EVENT_MAPS = [];
