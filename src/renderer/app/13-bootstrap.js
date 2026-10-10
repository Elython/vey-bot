// Initialize on Load
document.addEventListener('DOMContentLoaded', async () => {
  let features=null;
  try {features=await window.botAPI.getAppFeatures?.();}
  catch(error){appendLog('WARN','Release feature information could not be loaded; continuing startup.');}
  if(features?.soloPvp===false){
    unavailableSidebarTabs.add('soloPvp');applySidebarVisibility();
    document.querySelector('#selectGeneralModule option[value="pvp"]')?.remove();
    const index=runModules.findIndex(([id])=>id==='pvp');if(index>=0)runModules.splice(index,1);
  }
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
  restoreInterfaceLanguageNavigation();
});
document.querySelectorAll('[data-reset-usage]').forEach(button=>button.addEventListener('click',async()=>{
  if(!confirm(uiText('Reset this counter to zero? Its safety limit will start counting again.')))return;
  const result=await window.botAPI.resetUsageCounter(button.dataset.resetUsage);
  if(!result?.success)appendLog('WARN',result?.error||'Counter reset failed');
}));
