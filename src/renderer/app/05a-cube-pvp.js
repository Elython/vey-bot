let latestCubePvpStatus = {};

async function saveCubePvpSettings() {
  const result = await updateCanonicalConfig({ cubePvp: {
    enabled: chkCubePvpEnabled?.checked === true,
    mode: 'server_ai',
    recheckMinutes: Math.max(1, Math.min(60, Math.trunc(Number(inputCubePvpRecheck?.value) || 5))),
  } });
  if (result?.success) {
    cubePvpTargetConfig = result.config?.cubePvp || cubePvpTargetConfig;
    renderCubePvpStatus(latestCubePvpStatus);
    if (cubePvpTargetOverview) renderCubePvpTargets(cubePvpTargetOverview);
  } else {
    appendLog('ERROR', result?.error || 'Could not save Cube PvP settings');
  }
}

function renderCubePvpStatus(status = {}) {
  const incomingRevision = Number(status?.revision);
  const renderedRevision = Number(latestCubePvpStatus?.revision);
  if (Number.isFinite(incomingRevision) && Number.isFinite(renderedRevision)
    && incomingRevision < renderedRevision) return;
  latestCubePvpStatus = status || {};
  const commitment = status.commitment;
  if (overviewCubePvpPanel) {
    const visible = currentTab === 'home' && (chkCubePvpEnabled?.checked === true || commitment);
    overviewCubePvpPanel.style.display = visible ? '' : 'none';
  }
  if (cubePvpStatus) cubePvpStatus.textContent = String(status.state || 'idle').replaceAll('_', ' ');
  if (cubePvpMatch) cubePvpMatch.textContent = commitment ? `${commitment.nodeName || `Node ${commitment.nodeId}`} · #${commitment.matchNo}` : '—';
  if (cubePvpSlot) cubePvpSlot.textContent = commitment?.slotIndex ? String(commitment.slotIndex) : '—';
  if (cubePvpCooldown) cubePvpCooldown.textContent = Number(status.cooldownRemainingMs) > 0
    ? uiText("{0} min", Math.ceil(Number(status.cooldownRemainingMs) / 60000)) : uiText('Ready');
  if (cubePvpWaitReason) cubePvpWaitReason.textContent = status.waitReason || '—';
  if (cubePvpLastState) cubePvpLastState.textContent = status.lastStateAt ? new Date(status.lastStateAt).toLocaleString() : '—';
  if (btnOpenCubePvpMatch) btnOpenCubePvpMatch.disabled = !commitment;
}

async function refreshCubePvpStatus() {
  const requestToken = accountRequestToken();
  const result = await window.botAPI.getCubePvpStatus?.();
  if (!isCurrentAccountRequest(requestToken)) return;
  renderCubePvpStatus(result?.status || {});
}

for (const control of [chkCubePvpEnabled, selectCubePvpMode, inputCubePvpRecheck]) control?.addEventListener('change', saveCubePvpSettings);
btnOpenCubePvpMatch?.addEventListener('click', async () => {
  const result = await window.botAPI.openCubePvpMatch();
  if (!result?.success) appendLog('WARN', result?.error || 'Cube PvP match is not available');
});
window.botAPI.onCubePvpStatus?.(status => {
  const previous = latestCubePvpStatus?.commitment;
  renderCubePvpStatus(status);
  const current = latestCubePvpStatus?.commitment;
  const previousIdentity = previous
    ? `${previous.instanceId}:${previous.nodeId}:${previous.matchNo}` : '';
  const currentIdentity = current
    ? `${current.instanceId}:${current.nodeId}:${current.matchNo}` : '';
  if (currentIdentity && currentIdentity !== previousIdentity
    && currentTab === 'npcConfig' && activeMonsterAreaKey === 'polyhedral_crucible') {
    refreshCubePvpTargets?.(true).catch(() => null);
  }
});
refreshCubePvpStatus().catch(() => null);
