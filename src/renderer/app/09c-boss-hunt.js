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

function renderBossHunt(discoveredBosses = null) {
  if (!bossHuntContent) return;
  if (Array.isArray(discoveredBosses)) bossHuntKnownBosses = discoveredBosses;
  const query = String(bossHuntSearchQuery || '').trim().toLocaleLowerCase();
  const bosses = bossHuntKnownBosses.filter(boss => !query || [
    boss.name,
    boss.areaName,
    boss.areaType,
    Number(boss.phase) > 0 ? `phase ${boss.phase}` : 'boss',
  ].some(value => String(value || '').toLocaleLowerCase().includes(query)));
  if (bossHuntKnownBosses.length === 0 || bosses.length === 0) {
    bossHuntContent.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: bossHuntKnownBosses.length === 0
        ? uiText('No verified Gate or Event bosses are known for this account. Use Refresh after the account can access its Gates.')
        : uiText('No known bosses match this search.'),
    }));
    setWorkspaceStatus(bossHuntStatus, bossHuntKnownBosses.length === 0
      ? uiText('0 known bosses')
      : uiText("0 of {0} known bosses", bossHuntKnownBosses.length));
    return;
  }
  const table = document.createElement('div');
  table.className = 'monster-config-table boss-hunt-table';
  const header = document.createElement('div');
  header.className = 'monster-config-row monster-config-header';
  for (const [label, title] of [
    [uiText('Boss'), uiText('Boss or phase name and source area')], [uiText('Active'), uiText('Currently alive / observed total')], [uiText('Stats'), uiText('Monster stats and rewards')],
    [uiText('Damage'), uiText('Target damage')], [uiText('Count'), uiText('Completed boss instances required')], ['∞', uiText('Unlimited instances')],
    [uiText('Pri'), uiText('Priority — lower numbers run first')], [uiText('Min HP'), uiText('Minimum current HP')], [uiText('Done'), uiText('Completed Boss Hunt targets')],
    [uiText('Gear'), uiText('Gear set')], [uiText('Pet'), uiText('Pet set')], [uiText('Potions'), uiText('Stamina potion policy')], [uiText('Skills'), uiText('Allow configured abilities')], [uiText('Target'), uiText('Enable Boss Hunt target')],
  ]) {
    const cell = document.createElement('span');
    cell.textContent = label;
    cell.title = uiText(title);
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
      badge.textContent = uiText("Phase {0}", boss.phase);
      name.append(badge);
    } else {
      const badge = document.createElement('span');
      badge.className = 'monster-boss-badge';
      badge.textContent = uiText('Boss');
      name.append(badge);
    }
    name.append(area);

    const availability = document.createElement('span');
    const alive = Math.max(0, Number(boss.aliveCount) || 0);
    const total = Math.max(alive, Number(boss.totalCount) || Number(boss.activeInstances) || 0);
    availability.className = `monster-availability-count${alive > 0 ? ' is-active' : ''}`;
    availability.textContent = `${alive}/${total}`;
    availability.title = alive > 0 ? uiText('A matching boss is active') : uiText('No matching boss is currently observed');

    const statsButton = document.createElement('button');
    statsButton.type = 'button';
    statsButton.className = `monster-stats-help${boss.statsAvailable ? ' has-stats' : ''}`;
    statsButton.append(createLucideIcon('circle-help'));
    statsButton.title = uiText("View verified stats and rewards for {0}", boss.name);
    statsButton.addEventListener('click', () => monsterStatsView?.open(boss.areaKey, boss.monsterKey, boss.name));

    const targetDamage = document.createElement('input');
    targetDamage.type = 'number'; targetDamage.min = '0'; targetDamage.step = '1';
    targetDamage.className = 'monster-number-input'; targetDamage.value = stored.targetDamage ?? 0;
    targetDamage.setAttribute('aria-label', uiText("{0} target damage", boss.name));
    const killCount = document.createElement('input');
    killCount.type = 'number'; killCount.min = '0'; killCount.step = '1';
    killCount.className = 'monster-number-input'; killCount.value = stored.killCount ?? 0;
    killCount.setAttribute('aria-label', uiText("{0} target count", boss.name));
    const unlimited = document.createElement('input');
    unlimited.type = 'checkbox'; unlimited.className = 'tree-checkbox'; unlimited.checked = stored.unlimited === true;
    unlimited.title = uiText('Keep targeting new instances without a count limit.');
    const updateLimit = () => {
      killCount.disabled = unlimited.checked;
      killCount.classList.toggle('module-setting-disabled', unlimited.checked);
    };
    updateLimit();
    const priority = document.createElement('input');
    priority.type = 'number'; priority.min = '0'; priority.step = '1';
    priority.className = 'monster-number-input'; priority.value = stored.priority ?? 0;
    priority.title = uiText('Lower priorities run first; equal priorities rotate.');
    const minimumHp = document.createElement('input');
    minimumHp.type = 'number'; minimumHp.min = '0'; minimumHp.step = '1';
    minimumHp.className = 'monster-number-input'; minimumHp.value = stored.minimumHp ?? 0;
    minimumHp.title = uiText('Ignore active instances below this HP.');

    const progress = document.createElement('div');
    progress.className = 'monster-progress';
    const progressText = document.createElement('span');
    progressText.textContent = `${stored.completedCount || 0}/${stored.unlimited === true ? '∞' : (stored.killCount || 0)}`;
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'monster-progress-reset'; reset.append(createLucideIcon('rotate-ccw'));
    reset.title = uiText("Reset Boss Hunt progress for {0}", boss.name);
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
    allowAbilities.title = uiText('Allow globally enabled Combat abilities against this boss.');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.className = 'tree-checkbox'; enabled.checked = stored.enabled === true;
    enabled.title = uiText('Include this boss in Boss Hunt.');

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
  setWorkspaceStatus(bossHuntStatus, query
    ? uiText("{0} of {1} known bosses", bosses.length, bossHuntKnownBosses.length)
    : uiText("{0} known boss target{1}", bosses.length, bosses.length === 1 ? '' : 's'));
  refreshLucideIcons(bossHuntContent);
}

async function refreshBossHunt(force = false) {
  if (!bossHuntContent || !activeAccount) return;
  const token = accountRequestToken();
  bossHuntContent.replaceChildren(Object.assign(document.createElement('div'), {
    className: 'empty-state', textContent: force ? uiText('Refreshing accessible Gates and Events…') : uiText('Loading Boss Hunt…'),
  }));
  if (btnRefreshBossHunt) btnRefreshBossHunt.disabled = true;
  try {
    const [result, config] = await Promise.all([
      window.botAPI.listBossHuntTargets(force === true),
      window.botAPI.getConfig(),
    ]);
    if (!isCurrentAccountRequest(token)) return;
    if (!result?.success) throw new Error(result?.error || uiText('Boss Hunt is unavailable'));
    bossHuntConfig = config?.bossHunt || { targets: {} };
    renderBossHunt(result.bosses || []);
  } catch (error) {
    if (!isCurrentAccountRequest(token)) return;
    bossHuntContent.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state', textContent: error.message,
    }));
    setWorkspaceStatus(bossHuntStatus, uiText('Boss discovery failed'));
  } finally {
    if (isCurrentAccountRequest(token) && btnRefreshBossHunt) btnRefreshBossHunt.disabled = false;
  }
}

btnRefreshBossHunt?.addEventListener('click', () => refreshBossHunt(true));
inputBossHuntSearch?.addEventListener('input', () => {
  bossHuntSearchQuery = inputBossHuntSearch.value;
  renderBossHunt();
});
let bossHistoryGeneration=0;
async function refreshBossHistory(){const token=accountRequestToken();const generation=++bossHistoryGeneration;const content=document.getElementById('bossHuntHistoryContent');content.textContent=uiText('Loading boss history…');try{
 const result=await withUiTimeout(window.botAPI.getActivityHistory('target',{limit:1000}),20000,uiText('Boss history'));
 if(!isCurrentAccountRequest(token)||generation!==bossHistoryGeneration)return;
 if(!result?.success)throw Error(result?.error||uiText('History unavailable'));
 const keys=new Set(Object.entries(bossHuntConfig.targets||{}).flatMap(([area,rows])=>Object.values(rows).map(row=>area+'|'+row.monsterKey)));
 const boss=row=>row.boss===true||Number(row.phase)>0||row.module==='boss_hunt'||keys.has(row.areaKey+'|'+row.monsterKey);
 renderActivityHistory('target',{entries:(result.entries||[]).filter(boss),summaries:(result.summaries||[]).filter(boss)},content);
 }catch(error){if(isCurrentAccountRequest(token)&&generation===bossHistoryGeneration)content.textContent=error.message;}}
for(const [id,history] of [['btnBossTargetsTab',false],['btnBossHistoryTab',true]])document.getElementById(id).addEventListener('click',()=>{
 document.getElementById('bossHuntTargets').style.display=history?'none':'flex';document.getElementById('bossHuntHistory').style.display=history?'flex':'none';
 document.getElementById('btnBossTargetsTab').classList.toggle('active',!history);document.getElementById('btnBossHistoryTab').classList.toggle('active',history);if(history)refreshBossHistory();
});
document.getElementById('btnRefreshBossHistory').addEventListener('click',refreshBossHistory);
