function combatProfileRows() {
  return Object.values(combatProfilesConfig?.profiles || {})
    .filter(profile => profile?.id)
    .sort((left, right) => {
      if (left.id === 'default') return -1;
      if (right.id === 'default') return 1;
      return String(left.name || '').localeCompare(String(right.name || ''));
    });
}

function nextCombatProfileName() {
  const names = new Set(combatProfileRows().map(profile => String(profile.name || '').toLowerCase()));
  let number = 1;
  while (names.has(`combat config ${number}`)) number += 1;
  return `Combat config ${number}`;
}

function renderCombatProfileControls() {
  const activeId = combatProfilesConfig?.profiles?.[combatProfilesConfig.activeId]
    ? combatProfilesConfig.activeId : 'default';
  const rows = combatProfileRows();
  for (const select of [selectCombatProfileSetup, selectCombatProfile]) {
    if (!select) continue;
    select.replaceChildren(...rows.map(profile => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.id === 'default' ? uiText('Default') : profile.name;
      return option;
    }));
    select.value = activeId;
  }
  const active = combatProfilesConfig?.profiles?.[activeId];
  if (inputCombatProfileName) inputCombatProfileName.value = active?.name || 'Default';
  const immutable = activeId === 'default';
  if (btnRenameCombatProfile) btnRenameCombatProfile.disabled = immutable;
  if (btnDeleteCombatProfile) btnDeleteCombatProfile.disabled = immutable;
}

function loadCombatProfileConfiguration(config = {}) {
  combatProfilesConfig = config.combatProfiles || { activeId: 'default', profiles: {} };
  renderCombatProfileControls();
  if (typeof customRunCombatProfiles !== 'undefined') {
    customRunCombatProfiles = config.combatProfiles?.profiles || { default: { name: 'Default' } };
    renderCustomRuns();
  }
}

async function selectCombatProfileById(profileId) {
  if (!profileId || profileId === combatProfilesConfig.activeId) return;
  const result = await trackConfigSave(window.botAPI.selectCombatProfile(profileId));
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not select Combat profile');
    renderCombatProfileControls();
    return;
  }
  loadHomeConfiguration(result.config);
  markConfigDirty();
}

for (const select of [selectCombatProfileSetup, selectCombatProfile]) {
  select?.addEventListener('change', () => selectCombatProfileById(select.value));
}

btnCreateCombatProfile?.addEventListener('click', async () => {
  btnCreateCombatProfile.disabled = true;
  try {
    const result = await trackConfigSave(window.botAPI.createCombatProfile(nextCombatProfileName()));
    if (!result?.success) {
      appendLog('ERROR', result?.error || 'Could not create Combat profile');
      return;
    }
    loadHomeConfiguration(result.config);
    markConfigDirty();
    inputCombatProfileName?.focus();
    inputCombatProfileName?.select();
  } finally {
    btnCreateCombatProfile.disabled = false;
  }
});

btnRenameCombatProfile?.addEventListener('click', async () => {
  const profileId = combatProfilesConfig.activeId;
  const name = String(inputCombatProfileName?.value || '').trim();
  if (profileId === 'default' || !name) return;
  const result = await trackConfigSave(window.botAPI.renameCombatProfile(profileId, name));
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not rename Combat profile');
    return;
  }
  loadHomeConfiguration(result.config);
  markConfigDirty();
});

btnDeleteCombatProfile?.addEventListener('click', async () => {
  const profileId = combatProfilesConfig.activeId;
  const profile = combatProfilesConfig.profiles?.[profileId];
  if (!profile || profileId === 'default') return;
  if (!window.confirm(uiText("Delete Combat profile \"{0}\"?", profile.name))) return;
  const result = await trackConfigSave(window.botAPI.deleteCombatProfile(profileId));
  if (!result?.success) {
    appendLog('ERROR', result?.error || 'Could not delete Combat profile');
    return;
  }
  loadHomeConfiguration(result.config);
  markConfigDirty();
});
