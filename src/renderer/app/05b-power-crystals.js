let crystalReadGeneration = 0;
let crystalToggleGeneration = 0;
let latestPowerCrystalData = null;

function crystalElements() {
  return {
    enabled: chkEnableCrystalRouting,
    source: document.getElementById('selectCrystalSourceSet'),
    status: document.getElementById('powerCrystalStatus'),
    content: document.getElementById('powerCrystalInventory'),
  };
}

function setCrystalStatus(message, kind = '') {
  const status = crystalElements().status;
  status.textContent = message;
  status.classList.toggle('is-error', kind === 'error');
  status.classList.toggle('is-success', kind === 'success');
}

function renderPowerCrystalInventory() {
  const { content, source, enabled } = crystalElements();
  const config = latestPowerCrystalData?.config || {};
  enabled.checked = config.enabled === true;
  source.value = config.sourceSelection || 'default';
  if (!Array.isArray(latestPowerCrystalData?.crystals)) {
    content.textContent = uiText('Use Refresh to read this account’s crystals.');
    return;
  }
  const crystals = latestPowerCrystalData.crystals;
  if (!crystals.length) {
    content.textContent = uiText('No active crystals were found.');
    return;
  }
  const table = document.createElement('table');
  table.className = 'monster-table';
  const header = document.createElement('tr');
  for (const title of [uiText('Crystal'), uiText('Level'), uiText('Current equipment'), uiText('Automatic gear slot')]) {
    const cell = document.createElement('th');
    cell.textContent = title;
    header.append(cell);
  }
  table.append(header);
  for (const crystal of crystals) {
    const row = document.createElement('tr');
    for (const value of [
      crystal.name + ' (#' + crystal.id + ')',
      String(crystal.level),
      crystal.equipmentName,
      crystal.routeSlot || 'Not learned',
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    table.append(row);
  }
  content.replaceChildren(table);
}

async function refreshPowerCrystalInventory() {
  const token = accountRequestToken();
  const generation = ++crystalReadGeneration;
  setCrystalStatus(uiText('Reading Power Crystals…'));
  try {
    const result = await withUiTimeout(window.botAPI.getPowerCrystals(), 20000, uiText('Power Crystals'));
    if (!isCurrentAccountRequest(token) || generation !== crystalReadGeneration) return;
    if (!result?.success) throw new Error(result?.error || uiText('Inventory read failed'));
    latestPowerCrystalData = result;
    renderPowerCrystalInventory();
    const unresolved = (result.equipment || []).filter(item => !item.resolved && item.crystalIds?.length).length;
    if (unresolved) setCrystalStatus(uiText("Read complete. Scanning the source set will safely identify {0} full item(s).", unresolved));
    else if (result.config?.captured && result.config?.enabled) setCrystalStatus(uiText('Automatic Crystal routing is ready.'), 'success');
    else if (result.config?.captured) setCrystalStatus(uiText('Crystal routing is scanned but turned off.'));
    else setCrystalStatus(uiText('Choose where the current Crystal layout belongs, then scan it.'));
  } catch (error) {
    if (isCurrentAccountRequest(token) && generation === crystalReadGeneration) setCrystalStatus(error.message, 'error');
  }
}

async function setPowerCrystalRoutingEnabled() {
  const token = accountRequestToken();
  const enabled = crystalElements().enabled.checked === true;
  const generation = ++crystalToggleGeneration;
  crystalReadGeneration++;
  setCrystalStatus(uiText('Saving the Crystal-routing preference…'));
  try {
    const result = await withUiTimeout(updateCanonicalConfig({ powerCrystals: { enabled } }), 20000, uiText('Crystal routing setting'));
    if (!isCurrentAccountRequest(token) || generation !== crystalToggleGeneration) return;
    if (!result?.success) throw new Error(result?.error || uiText('Crystal routing setting failed'));
    const crystalConfig = result.config?.powerCrystals || { ...(latestPowerCrystalData?.config || {}), enabled };
    latestPowerCrystalData = { ...(latestPowerCrystalData || {}), config: crystalConfig };
    renderPowerCrystalInventory();
    if (enabled && !crystalConfig.captured) setCrystalStatus(uiText('Routing will be enabled after Save, but this account still needs a Crystal layout scan.'));
    else setCrystalStatus(uiText('Automatic Crystal routing will turn ') + (enabled ? uiText('on') : uiText('off')) + uiText(' after you press Save.'));
  } catch (error) {
    if (isCurrentAccountRequest(token) && generation === crystalToggleGeneration) {
      crystalElements().enabled.checked = !enabled;
      setCrystalStatus(error.message, 'error');
    }
  }
}

async function capturePowerCrystalRouting() {
  const token = accountRequestToken();
  const sourceSelection = crystalElements().source.value || 'default';
  const generation = ++crystalReadGeneration;
  setCrystalStatus(uiText('Scanning the current Crystal layout and Gear slots…'));
  try {
    const result = await withUiTimeout(window.botAPI.capturePowerCrystalRouting(sourceSelection), 120000, uiText('Crystal routing scan'));
    if (!isCurrentAccountRequest(token) || generation !== crystalReadGeneration) return;
    if (!result?.success) throw new Error(result?.error || uiText('Crystal routing scan failed'));
    markConfigDirty();
    latestPowerCrystalData = result;
    renderPowerCrystalInventory();
    const skipped = result.unmapped?.length ? ` ${result.unmapped.length} linked crystal(s) were outside that Gear set.` : '';
    setCrystalStatus(uiText('Learned ') + result.mapped + uiText(' automatic Crystal route(s).') + skipped + uiText(' Press Save to apply the layout.'), 'success');
  } catch (error) {
    if (isCurrentAccountRequest(token) && generation === crystalReadGeneration) setCrystalStatus(error.message, 'error');
  }
}

function showCombatWorkspace(showCrystals) {
  document.getElementById('combatPvePanel').style.display = showCrystals ? 'none' : '';
  document.getElementById('combatCrystalsPanel').style.display = showCrystals ? '' : 'none';
  document.getElementById('btnCombatGeneralTab').classList.toggle('active', !showCrystals);
  document.getElementById('btnCombatCrystalsTab').classList.toggle('active', showCrystals);
  if (showCrystals && !Array.isArray(latestPowerCrystalData?.crystals)) refreshPowerCrystalInventory();
}

function resetPowerCrystalWorkspace() {
  crystalReadGeneration++;
  crystalToggleGeneration++;
  latestPowerCrystalData = null;
  const content = document.getElementById('powerCrystalInventory');
  if (content) content.textContent = uiText('Use Refresh to read this account’s crystals.');
  const status = document.getElementById('powerCrystalStatus');
  if (status) status.textContent = uiText('Use Refresh to read this account’s crystals.');
}

document.getElementById('btnCombatGeneralTab').addEventListener('click', () => showCombatWorkspace(false));
document.getElementById('btnCombatCrystalsTab').addEventListener('click', () => showCombatWorkspace(true));
document.getElementById('chkEnableCrystalRouting').addEventListener('change', setPowerCrystalRoutingEnabled);
document.getElementById('btnRefreshCrystals').addEventListener('click', refreshPowerCrystalInventory);
document.getElementById('btnScanCrystalRouting').addEventListener('click', capturePowerCrystalRouting);
