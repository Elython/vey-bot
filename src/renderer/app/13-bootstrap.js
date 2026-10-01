// Initialize on Load
document.addEventListener('DOMContentLoaded', async () => {
  initDevMode();
  await refreshAccounts();
  await loadMangaList();
  await refreshMonsterCatalog(false);

  const config = await window.botAPI.getConfig();
  if (config) {
    loadHomeConfiguration(config);
    loadSchedulerConfiguration(config);
  }
  updateFarmModuleUI();

  // Restore active account session on reload (e.g. Ctrl+R)
  const savedAccount = localStorage.getItem('activeAccount');
  if (savedAccount) {
    const accounts = await window.botAPI.listAccounts();
    if (accounts && accounts.some((a) => a.name === savedAccount)) {
      await window.loginWith(savedAccount);
    }
  }
});
