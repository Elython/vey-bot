// Account-scoped Statistics read model. This view performs no game-network discovery.
let statisticsRequestGeneration = 0;

function statisticsTable(headers, rows, emptyMessage) {
  const table = document.createElement('div');
  table.className = 'statistics-table';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = emptyMessage;
    table.append(empty);
    return table;
  }
  const header = document.createElement('div');
  header.className = 'statistics-table-row statistics-table-header';
  for (const label of headers) {
    const cell = document.createElement('span');
    cell.textContent = label;
    header.append(cell);
  }
  table.append(header);
  for (const values of rows) {
    const row = document.createElement('div');
    row.className = 'statistics-table-row';
    for (const value of values) {
      const cell = document.createElement('span');
      cell.textContent = String(value ?? '-');
      cell.title = cell.textContent;
      row.append(cell);
    }
    table.append(row);
  }
  return table;
}

function replaceStatisticsTable(container, headers, rows, emptyMessage) {
  if (!container) return;
  container.replaceChildren(statisticsTable(headers, rows, emptyMessage));
}

function statisticsResourceLabel(row = {}) {
  const resource = row.resource ? uiText(row.resource.charAt(0).toUpperCase() + row.resource.slice(1)) : uiText('Resource');
  const potion = row.potionType ? uiText(row.potionType.charAt(0).toUpperCase() + row.potionType.slice(1)) : '';
  if (row.type === 'potion_use') return uiText('{0} potion used{1}', resource, potion ? ' · ' + potion : '');
  if (row.type === 'potion_purchase') return uiText('{0} potion purchased', resource);
  if (row.type === 'chapter_farm') return uiText('Chapter farmed');
  if (row.type === 'healing') return row.potionType ? uiText('Health potion healing') : uiText('Timed healing');
  return uiText(String(row.type || 'Activity').replaceAll('_', ' '));
}

function renderStatisticsTrend(trend = []) {
  if (!statisticsTrend) return;
  statisticsTrend.replaceChildren();
  const maxAttacks = Math.max(1, ...trend.map(row => Number(row.attacks) || 0));
  const maxClaims = Math.max(1, ...trend.map(row => Number(row.claims) || 0));
  for (const row of trend) {
    const column = document.createElement('div');
    column.className = 'statistics-trend-column';
    const bars = document.createElement('div');
    bars.className = 'statistics-trend-bars';
    const attacks = document.createElement('span');
    attacks.className = 'statistics-trend-bar statistics-trend-attacks';
    attacks.style.height = `${Math.max(2, Math.round(((Number(row.attacks) || 0) / maxAttacks) * 62))}px`;
    attacks.title = uiText("{0} attacks", formatNumber(row.attacks));
    const loot = document.createElement('span');
    loot.className = 'statistics-trend-bar statistics-trend-loot';
    loot.style.height = `${Math.max(2, Math.round(((Number(row.claims) || 0) / maxClaims) * 62))}px`;
    loot.title = uiText("{0} loot claims", formatNumber(row.claims));
    bars.append(attacks, loot);
    const label = document.createElement('span');
    label.className = 'statistics-trend-label';
    const date = new Date(`${row.date}T00:00:00Z`);
    label.textContent = Number.isNaN(date.getTime()) ? row.date : `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    column.append(bars, label);
    statisticsTrend.append(column);
  }
}

function resetStatisticsView() {
  statisticsRequestGeneration += 1;
  for (const element of [statisticsAttacks, statisticsReached, statisticsStamina,
    statisticsClaims, statisticsXp, statisticsGold, statisticsItems, statisticsPvpJoined, statisticsPvpWins, statisticsPvpLosses,
    statisticsAverageStamina, statisticsAverageXp, statisticsPotionsUsed, statisticsChapters, statisticsHeals]) {
    if (element) element.textContent = '0';
  }
  if (statisticsReachRate) statisticsReachRate.textContent = '0%';
  if (statisticsPvpDuration) statisticsPvpDuration.textContent = '—';
  for (const container of [statisticsTrend, statisticsCombatTable, statisticsLootTable,
    statisticsResourcesTable, statisticsItemsTable, statisticsPvpTable, statisticsAreasTable]) {
    container?.replaceChildren();
  }
  setWorkspaceStatus(statisticsStatus, uiText('Select a period to inspect saved account activity.'));
}

function renderStatistics(data = {}) {
  const summary = data.summary || {};
  const values = new Map([
    [statisticsAttacks, summary.attacks],
    [statisticsReached, summary.targetsReached],
    [statisticsStamina, summary.stamina],
    [statisticsClaims, summary.claims],
    [statisticsXp, summary.xp],
    [statisticsGold, summary.gold],
    [statisticsItems, summary.items],
    [statisticsPvpJoined, summary.pvpMatchesJoined],
    [statisticsPvpWins, summary.pvpWins],
    [statisticsPvpLosses, summary.pvpLosses],
    [statisticsPotionsUsed, summary.potionsUsed],
    [statisticsChapters, summary.chaptersFarmed],
    [statisticsHeals, summary.heals],
  ]);
  for (const [element, value] of values) if (element) element.textContent = formatNumber(value);
  const attacks = Math.max(0, Number(summary.attacks) || 0);
  const claims = Math.max(0, Number(summary.claims) || 0);
  if (statisticsReachRate) statisticsReachRate.textContent = `${attacks > 0 ? ((Number(summary.targetsReached) || 0) / attacks * 100).toFixed(1) : '0.0'}%`;
  if (statisticsAverageStamina) statisticsAverageStamina.textContent = formatNumber(attacks > 0 ? ((Number(summary.stamina) || 0) / attacks).toFixed(1) : 0);
  if (statisticsAverageXp) statisticsAverageXp.textContent = formatNumber(claims > 0 ? Math.round((Number(summary.xp) || 0) / claims) : 0);
  if (statisticsPvpDuration) {
    const averageSeconds = Number(summary.pvpCompleted) > 0 ? Math.round((Number(summary.pvpDurationMs) || 0) / Number(summary.pvpCompleted) / 1000) : 0;
    statisticsPvpDuration.textContent = averageSeconds > 0 ? uiText("{0}m {1}s", Math.floor(averageSeconds / 60), averageSeconds % 60) : '—';
  }
  renderStatisticsTrend(data.trend || []);

  replaceStatisticsTable(statisticsCombatTable,
    [uiText('Monster'), uiText('Area'), uiText('Hits'), uiText('Reached'), uiText('ST')],
    (data.combat || []).map(row => [row.monsterName, row.areaName, formatNumber(row.attacks),
      formatNumber(row.completedTargets), formatNumber(row.totalStamina)]),
    uiText('No recorded attacks in this period.'));
  replaceStatisticsTable(statisticsLootTable,
    [uiText('Monster'), uiText('Area'), uiText('Claims'), uiText('EXP'), uiText('Gold'), uiText('Items')],
    (data.loot || []).map(row => [row.monsterName, row.areaName, formatNumber(row.claims),
      formatNumber(row.totalXp), formatNumber(row.totalGold), formatNumber(row.itemsCount)]),
    uiText('No recorded loot claims in this period.'));
  replaceStatisticsTable(statisticsResourcesTable,
    [uiText('Activity'), uiText('Actions'), uiText('Quantity')],
    (data.resources || []).map(row => [statisticsResourceLabel(row), formatNumber(row.actions), formatNumber(row.quantity)]),
    uiText('No recorded resource activity in this period.'));
  replaceStatisticsTable(statisticsItemsTable,
    [uiText('Item'), uiText('Tier'), uiText('Quantity')],
    (data.items || []).map(row => [row.name, row.tier || '-', formatNumber(row.quantityObtained)]),
    uiText('No recorded item drops in this period.'));
  replaceStatisticsTable(statisticsPvpTable,
    [uiText('Time'), uiText('Node'), uiText('Match'), uiText('State'), uiText('Result'), uiText('Duration')],
    (data.pvp || []).map(event => [new Date(event.observedAt).toLocaleString(), event.details?.nodeName || `Node ${event.details?.nodeId || '-'}`,
      `#${event.details?.matchNo || '-'}`, event.details?.state || event.type.replace('cube_pvp_', ''), event.details?.winnerSide || '-',
      Number(event.details?.durationMs) > 0 ? `${Math.round(Number(event.details.durationMs) / 60000)}m` : '-']),
    uiText('No recorded Cube PvP activity in this period.'));
  replaceStatisticsTable(statisticsAreasTable,
    [uiText('Area'), uiText('Hits'), uiText('Reached'), uiText('ST'), uiText('Claims'), uiText('EXP'), uiText('Gold'), uiText('Items')],
    (data.areas || []).map(row => [row.areaName, formatNumber(row.attacks), formatNumber(row.targetsReached),
      formatNumber(row.stamina), formatNumber(row.claims), formatNumber(row.xp),
      formatNumber(row.gold), formatNumber(row.items)]),
    uiText('No recorded area activity in this period.'));

  const coverage = data.coverage || {};
  const limited = coverage.targetAtRetentionLimit || coverage.lootAtRetentionLimit || coverage.eventsAtRetentionLimit;
  const periodLabel = statisticsPeriod?.selectedOptions?.[0]?.textContent || data.period || uiText('Selected period');
  setWorkspaceStatus(statisticsStatus,
    uiText("{0} · {1} potions used · {2} chapters{3}", periodLabel, formatNumber(summary.potionsUsed), formatNumber(summary.chaptersFarmed), limited ? uiText(' · detailed history retention limit reached') : ''),
    limited ? 'warning' : 'success');
}

async function refreshStatistics() {
  if (!activeAccount || !statisticsPeriod) return;
  const generation = ++statisticsRequestGeneration;
  setRefreshBusy(btnRefreshStatistics, true);
  setWorkspaceStatus(statisticsStatus, uiText('Loading saved account statistics...'));
  try {
    const result = await withUiTimeout(window.botAPI.getStatistics(statisticsPeriod.value), 15000, uiText('Statistics'));
    if (generation !== statisticsRequestGeneration) return;
    if (!result?.success || !result.statistics) throw new Error(result?.error || uiText('Statistics are unavailable'));
    renderStatistics(result.statistics);
  } catch (error) {
    if (generation === statisticsRequestGeneration) setWorkspaceStatus(statisticsStatus, error.message, 'error');
  } finally {
    if (generation === statisticsRequestGeneration) setRefreshBusy(btnRefreshStatistics, false);
  }
}

statisticsPeriod?.addEventListener('change', refreshStatistics);
btnRefreshStatistics?.addEventListener('click', refreshStatistics);
