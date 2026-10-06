function bossHuntStoredPolicy(boss) {
  return bossHuntConfig.targets?.[boss.areaKey]?.[boss.targetKey] || {};
}

async function saveBossHuntRow(boss, controls) {
  const entry = {
    name: boss.name,
    monsterKey: boss.monsterKey,
    phase: Number(boss.phase) || null,
    targetDamage: Math.max(0, Math.trunc(Number(controls.targetDamage.value) || 0)),
    killCount: Math.max(0, Math.trunc(Number(controls.killCount.value) || 0)),
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
    bossHunt: { targets: { [boss.areaKey]: { [boss.targetKey]: entry } } },
  });
  if (result?.success) bossHuntConfig = result.config?.bossHunt || bossHuntConfig;
  else appendLog('ERROR', result?.error || `Could not save Boss Hunt settings for ${boss.name}`);
}

function renderBossHunt(bosses = []) {
  if (!bossHuntContent) return;
  if (bosses.length === 0) {
    bossHuntContent.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: 'No verified Gate or Event bosses are known for this account. Use Refresh after the account can access its Gates.',
    }));
    setWorkspaceStatus(bossHuntStatus, '0 known bosses');
    return;
  }
  const table = document.createElement('div');
  table.className = 'monster-config-table boss-hunt-table';
  const header = document.createElement('div');
  header.className = 'monster-config-row monster-config-header';
  for (const [label, title] of [
    ['Boss', 'Boss or phase name and source area'], ['Active', 'Currently alive / observed total'], ['Stats', 'Monster stats and rewards'],
    ['Damage', 'Target damage'], ['Count', 'Completed boss instances required'], ['∞', 'Unlimited instances'],
    ['Pri', 'Priority — lower numbers run first'], ['Min HP', 'Minimum current HP'], ['Done', 'Completed Boss Hunt targets'],
    ['Gear', 'Gear set'], ['Pet', 'Pet set'], ['Potions', 'Stamina potion policy'], ['Skills', 'Allow configured abilities'], ['Target', 'Enable Boss Hunt target'],
  ]) {
    const cell = document.createElement('span');
    cell.textContent = label;
    cell.title = title;
    header.append(cell);
  }
  table.append(header);

  for (const boss of bosses) {
    const stored = bossHuntStoredPolicy(boss);
    const row = document.createElement('div');
    row.className = 'monster-config-row boss-hunt-row';
    const name = document.createElement('div');
    name.className = 'monster-config-name';
    const nameText = document.createElement('span');
    nameText.className = 'monster-config-name-text';
    nameText.textContent = boss.name;
    const area = document.createElement('small');
    area.className = 'boss-hunt-area';
    area.textContent = `${boss.areaType === 'event' ? 'Event' : 'Gate'} · ${boss.areaName}`;
    name.append(nameText);
    if (Number(boss.phase) > 0) {
      const badge = document.createElement('span');
      badge.className = 'monster-phase-badge';
      badge.textContent = `Phase ${boss.phase}`;
      name.append(badge);
    } else {
      const badge = document.createElement('span');
      badge.className = 'monster-boss-badge';
      badge.textContent = 'Boss';
      name.append(badge);
    }
    name.append(area);

    const availability = document.createElement('span');
    const alive = Math.max(0, Number(boss.aliveCount) || 0);
    const total = Math.max(alive, Number(boss.totalCount) || Number(boss.activeInstances) || 0);
    availability.className = `monster-availability-count${alive > 0 ? ' is-active' : ''}`;
    availability.textContent = `${alive}/${total}`;
    availability.title = alive > 0 ? 'A matching boss is active' : 'No matching boss is currently observed';

    const statsButton = document.createElement('button');
    statsButton.type = 'button';
    statsButton.className = `monster-stats-help${boss.statsAvailable ? ' has-stats' : ''}`;
    statsButton.append(createLucideIcon('circle-help'));
    statsButton.title = `View verified stats and rewards for ${boss.name}`;
    statsButton.addEventListener('click', () => monsterStatsView?.open(boss.areaKey, boss.monsterKey, boss.name));

    const targetDamage = document.createElement('input');
    targetDamage.type = 'number'; targetDamage.min = '0'; targetDamage.step = '1';
    targetDamage.className = 'monster-number-input'; targetDamage.value = stored.targetDamage ?? 0;
    targetDamage.setAttribute('aria-label', `${boss.name} target damage`);
    const killCount = document.createElement('input');
    killCount.type = 'number'; killCount.min = '0'; killCount.step = '1';
    killCount.className = 'monster-number-input'; killCount.value = stored.killCount ?? 0;
    killCount.setAttribute('aria-label', `${boss.name} target count`);
    const unlimited = document.createElement('input');
    unlimited.type = 'checkbox'; unlimited.className = 'tree-checkbox'; unlimited.checked = stored.unlimited === true;
    unlimited.title = 'Keep targeting new instances without a count limit.';
    const updateLimit = () => {
      killCount.disabled = unlimited.checked;
      killCount.classList.toggle('module-setting-disabled', unlimited.checked);
    };
    updateLimit();
    const priority = document.createElement('input');
    priority.type = 'number'; priority.min = '0'; priority.step = '1';
    priority.className = 'monster-number-input'; priority.value = stored.priority ?? 0;
    priority.title = 'Lower priorities run first; equal priorities rotate.';
    const minimumHp = document.createElement('input');
    minimumHp.type = 'number'; minimumHp.min = '0'; minimumHp.step = '1';
    minimumHp.className = 'monster-number-input'; minimumHp.value = stored.minimumHp ?? 0;
    minimumHp.title = 'Ignore active instances below this HP.';

    const progress = document.createElement('div');
    progress.className = 'monster-progress';
    const progressText = document.createElement('span');
    progressText.textContent = `${stored.completedCount || 0}/${stored.unlimited === true ? '∞' : (stored.killCount || 0)}`;
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'monster-progress-reset'; reset.append(createLucideIcon('rotate-ccw'));
    reset.title = `Reset Boss Hunt progress for ${boss.name}`;
    reset.addEventListener('click', async () => {
      const result = await updateCanonicalConfig({ bossHunt: { targets: { [boss.areaKey]: { [boss.targetKey]: {
        completedCount: 0, completedInstanceIds: [],
      } } } } });
      if (result?.success) {
        bossHuntConfig = result.config?.bossHunt || bossHuntConfig;
        progressText.textContent = `0/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
      } else appendLog('ERROR', result?.error || `Could not reset ${boss.name}`);
    });
    progress.append(progressText, reset);

    const gearSet = createMonsterSetSelect(stored.gearSet, `${boss.name} Gear set`);
    const petSet = createMonsterSetSelect(stored.petSet, `${boss.name} Pet set`);
    const staminaPotion = createStaminaPotionSelect(stored.staminaPotion, `${boss.name} stamina potion`);
    const allowAbilities = document.createElement('input');
    allowAbilities.type = 'checkbox'; allowAbilities.className = 'tree-checkbox';
    allowAbilities.checked = stored.allowAbilities === true;
    allowAbilities.title = 'Allow globally enabled Combat abilities against this boss.';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.className = 'tree-checkbox'; enabled.checked = stored.enabled === true;
    enabled.title = 'Include this boss in Boss Hunt.';

    const controls = { targetDamage, killCount, unlimited, priority, minimumHp, gearSet, petSet, staminaPotion, allowAbilities, enabled };
    for (const control of Object.values(controls)) control.addEventListener('change', () => saveBossHuntRow(boss, controls));
    killCount.addEventListener('change', () => {
      progressText.textContent = `${stored.completedCount || 0}/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
    });
    unlimited.addEventListener('change', () => {
      updateLimit();
      progressText.textContent = `${stored.completedCount || 0}/${unlimited.checked ? '∞' : (killCount.value || 0)}`;
    });
    row.append(name, availability, statsButton, targetDamage, killCount, unlimited, priority, minimumHp,
      progress, gearSet, petSet, staminaPotion, allowAbilities, enabled);
    enhanceNumberInputs(row);
    table.append(row);
  }
  bossHuntContent.replaceChildren(table);
  setWorkspaceStatus(bossHuntStatus, `${bosses.length} known boss target${bosses.length === 1 ? '' : 's'}`);
  refreshLucideIcons(bossHuntContent);
}

async function refreshBossHunt(force = false) {
  if (!bossHuntContent || !activeAccount) return;
  const token = accountRequestToken();
  bossHuntContent.replaceChildren(Object.assign(document.createElement('div'), {
    className: 'empty-state', textContent: force ? 'Refreshing accessible Gates and Events…' : 'Loading Boss Hunt…',
  }));
  if (btnRefreshBossHunt) btnRefreshBossHunt.disabled = true;
  try {
    const [result, config] = await Promise.all([
      window.botAPI.listBossHuntTargets(force === true),
      window.botAPI.getConfig(),
    ]);
    if (!isCurrentAccountRequest(token)) return;
    if (!result?.success) throw new Error(result?.error || 'Boss Hunt is unavailable');
    bossHuntConfig = config?.bossHunt || { targets: {} };
    renderBossHunt(result.bosses || []);
  } catch (error) {
    if (!isCurrentAccountRequest(token)) return;
    bossHuntContent.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state', textContent: error.message,
    }));
    setWorkspaceStatus(bossHuntStatus, 'Boss discovery failed');
  } finally {
    if (isCurrentAccountRequest(token) && btnRefreshBossHunt) btnRefreshBossHunt.disabled = false;
  }
}

btnRefreshBossHunt?.addEventListener('click', () => refreshBossHunt(true));
