// Manga Manager UI Logic (Per-Account) - URLs hidden from view
function populateManualMangaOptions(list) {
  if (!selectManualManga) return;
  const previous = selectManualManga.value || workingMangaText?.textContent || '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = uiText('Select manga');
  const options = (list || []).map(manga => {
    const option = document.createElement('option');
    option.value = manga.slug;
    option.textContent = manga.title || manga.slug;
    return option;
  });
  selectManualManga.replaceChildren(placeholder, ...options);
  if (options.some(option => option.value === previous)) selectManualManga.value = previous;
  else if (options.length > 0) selectManualManga.value = options[0].value;
  if (workingMangaText && selectManualManga.value) workingMangaText.textContent = selectManualManga.value;
}

async function loadMangaList() {
  if (!mangaListTable) return;
  try {
    const list = await window.botAPI.getMangaList(activeAccount);
    populateManualMangaOptions(list);
    mangaListTable.innerHTML = '';
    if (!list || list.length === 0) {
      mangaListTable.innerHTML = ("<div class=\"empty-state\">" + uiText("No manga configured yet. Add one above.") + "</div>");
      return;
    }

    list.forEach((manga) => {
      const item = document.createElement('div');
      item.className = 'manga-item-card';
      const info = document.createElement('div');
      info.className = 'manga-item-info';
      const title = document.createElement('div');
      title.className = 'manga-item-title';
      title.append(document.createTextNode(`${manga.title || manga.slug} `));
      const chapters = document.createElement('span');
      chapters.className = 'manga-item-chapters';
      chapters.textContent = uiText("| {0} chapters", manga.chapters || 0);
      title.appendChild(chapters);
      info.appendChild(title);

      const actions = document.createElement('div');
      actions.className = 'manga-item-actions';
      const farmed = document.createElement('span');
      farmed.className = 'farmed-counter-badge';
      farmed.title = uiText('Chapters farmed by this account');
      farmed.textContent = uiText("Farmed: {0}", manga.farmedCount || 0);
      const refresh = document.createElement('button');
      refresh.className = 'btn-refresh-manga';
      refresh.title = uiText('Refresh chapter count');
      refresh.append(createLucideIcon('rotate-cw'));
      refresh.setAttribute('aria-label', refresh.title);
      refresh.addEventListener('click', () => window.refreshSingleManga(manga.slug));
      const farm = document.createElement('button');
      farm.className = 'btn-refresh-manga';
      farm.title = uiText('Farm the next chapter');
      farm.append(createLucideIcon('play'));
      farm.setAttribute('aria-label', farm.title);
      farm.addEventListener('click', () => window.farmSpecificManga(manga.slug));
      const remove = document.createElement('button');
      remove.className = 'btn-delete-x';
      remove.title = uiText('Remove for this account');
      remove.append(createLucideIcon('trash-2'));
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => window.deleteMangaTarget(manga.slug));
      actions.append(farmed, farm, refresh, remove);
      item.append(info, actions);
      mangaListTable.appendChild(item);
    });

    refreshLucideIcons(mangaListTable);
  } catch (err) {
    mangaListTable.innerHTML = '';
    const errorState = document.createElement('div');
    errorState.className = 'empty-state';
    errorState.textContent = uiText("Error loading manga: {0}", err.message);
    mangaListTable.appendChild(errorState);
  }
}

window.refreshSingleManga = async function (slug) {
  appendFarmTerminal('info', `Refreshing chapter count for "${slug}"...`);
  try {
    const res = await window.botAPI.refreshSingleManga(slug, activeAccount);
    if (res && res.success) {
      appendFarmTerminal('success', `Refreshed "${res.manga?.title || slug}" (${res.manga?.chapters || 0} chapters).`);
      await loadMangaList();
    } else {
      appendFarmTerminal('error', `Failed to refresh "${slug}": ${res?.error || 'Unknown error'}`);
    }
  } catch (err) {
    appendFarmTerminal('error', `Error refreshing "${slug}": ${err.message}`);
  } finally {
    refreshLucideIcons();
  }
};

if (btnAddManga) {
  btnAddManga.addEventListener('click', async () => {
    const input = inputMangaTarget ? inputMangaTarget.value.trim() : '';
    if (!input) {
      alert(uiText('Please enter a manga name or URL.'));
      return;
    }
    btnAddManga.disabled = true;
    appendFarmTerminal('info', `Verifying manga "${input}"...`);

    try {
      const res = await window.botAPI.addManga(input, activeAccount);
      if (res.success) {
        appendFarmTerminal('success', `Added "${res.manga.title}" (${res.manga.chapters} chapters).`);
        inputMangaTarget.value = '';
        await loadMangaList();
      } else {
        alert(res.error || uiText('Failed to add manga.'));
        appendFarmTerminal('error', `Failed to add manga: ${res.error || 'Unknown error'}`);
      }
    } catch (err) {
      appendFarmTerminal('error', `Error: ${err.message}`);
    } finally {
      btnAddManga.disabled = false;
    }
  });

  if (inputMangaTarget) {
    inputMangaTarget.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnAddManga.click();
      }
    });
  }
}

window.deleteMangaTarget = async function (slug) {
  if (confirm(uiText("Remove manga \"{0}\" for this account?", slug))) {
    await window.botAPI.deleteManga(slug, activeAccount);
    appendFarmTerminal('info', `Removed "${slug}" from account manga list.`);
    await loadMangaList();
  }
};

window.farmSpecificManga = async function (slug) {
  if (!confirm(uiText("Farm the next available chapter for \"{0}\" now? This sends a reaction request.", slug))) return;
  appendFarmTerminal('info', `Posting a verified chapter reaction for ${slug}...`);
  if (workingMangaText) {
    workingMangaText.textContent = slug;
    saveCurrentFarmSettings();
  }

  try {
    const res = await window.botAPI.startEnergyFarm({ targetManga: slug });
    if (res && res.success) {
      appendFarmTerminal('success', `Farm successful for "${slug}"! ${res.message || ''}`);
    } else {
      appendFarmTerminal('warn', `Farm completed for "${slug}": ${res ? res.message : 'No response'}`);
    }
    if (res && res.energy !== undefined && statEnergy) {
      statEnergy.textContent = `${res.energy} / 1000`;
    }
    await loadMangaList();
  } catch (err) {
    appendFarmTerminal('error', `Farm error for "${slug}": ${err.message}`);
  }
};

if (btnStartManualFarm) {
  btnStartManualFarm.addEventListener('click', async () => {
    const targetManga = selectManualManga?.value || '';
    const chapterCount = Number(inputManualChapterCount?.value);
    if (!targetManga) {
      appendFarmTerminal('warn', 'Choose a manga before starting manual farming.');
      return;
    }
    if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 1000) {
      appendFarmTerminal('warn', 'Chapter count must be between 1 and 1000.');
      return;
    }
    const safety = shouldStopFarming();
    if (safety.stop) {
      appendFarmTerminal('warn', `Manual farm not started: ${safety.reason}`);
      return;
    }
    if (!confirm(uiText("Farm {0} chapter{1} from \"{2}\"? This sends one reaction request per chapter.", chapterCount, chapterCount === 1 ? '' : 's', targetManga))) return;

    btnStartManualFarm.disabled = true;
    if (workingMangaText) workingMangaText.textContent = targetManga;
    await saveCurrentFarmSettings();
    appendFarmTerminal('info', `Starting manual farm for ${chapterCount} chapter${chapterCount === 1 ? '' : 's'}...`);
    try {
      const result = await window.botAPI.startEnergyFarm({ targetManga, chapterCount });
      appendFarmTerminal(result?.success ? 'success' : 'warn', result?.message || 'Manual farm finished without a response.');
      if (result?.energy !== undefined && statEnergy) statEnergy.textContent = `${result.energy} / 1000`;
      await loadMangaList();
    } catch (error) {
      appendFarmTerminal('error', `Manual farm failed: ${error.message}`);
    } finally {
      btnStartManualFarm.disabled = false;
    }
  });
}

if (window.botAPI.onEnergyProgress) {
  window.botAPI.onEnergyProgress(progress => {
    if(progress?.type==='recorded'){
      if(!window.chapterCounterRefreshTimer)window.chapterCounterRefreshTimer=setTimeout(()=>{window.chapterCounterRefreshTimer=null;loadMangaList();},250);
      return;
    }
    if (progress?.automatic === true) {
      const type = progress.status === 'success' ? 'success' : 'warn';
      appendFarmTerminal(type, `Automatic fallback · ${progress.slug || 'chapter'} #${progress.chapter || '?'}${progress.staminaGained ? ` · +${progress.staminaGained} ST` : ''}${progress.message ? ` · ${progress.message}` : ''}`);
      return;
    }
    if (!progress) return;
    if (progress.type === 'start') {
      appendFarmTerminal('info', `[${progress.current}/${progress.total}] Farming chapter ${progress.chapter}...`);
    } else if (progress.type === 'success') {
      const reward = Number(progress.staminaGained) > 0 ? ` · +${progress.staminaGained} ST` : ' · no new Stamina';
      appendFarmTerminal('success', `[${progress.current}/${progress.total}] Chapter ${progress.chapter}: ${progress.message || 'accepted'}${reward}`);
    } else if (progress.type === 'error') {
      appendFarmTerminal('error', `[${progress.current}/${progress.total}] Chapter ${progress.chapter}: ${progress.message || 'failed'}`);
    }
  });
}

// Check stopping criteria before farming
function shouldStopFarming() {
  const currentStamina = (latestStats && latestStats.stamina && latestStats.stamina.current) !== undefined ? latestStats.stamina.current : 0;
  const maxStamina = (latestStats && latestStats.stamina && latestStats.stamina.max) || (latestStats && latestStats.totalStamina) || 0;
  const farmedEnergy = Math.max(0, Number(latestStats?.farmedEnergy) || 0);

  // 1. Safety: Stop if Max Stamina reached
  if (chkStopMaxStamina?.checked && maxStamina > 0 && currentStamina >= maxStamina) {
    return { stop: true, reason: `Max stamina reached (${currentStamina}/${maxStamina}).` };
  }

  // 2. Safety: Max Stamina Farm target threshold
  const maxFarmTarget = parseInt(inputMaxStaminaFarm?.value, 10);
  if (!isNaN(maxFarmTarget) && maxFarmTarget > 0 && farmedEnergy >= maxFarmTarget) {
    return { stop: true, reason: `Chapter reward progress (${farmedEnergy}) reached the farming threshold (${maxFarmTarget}).` };
  }

  // 3. Safety: Stop when hourly stamina is in [X] min
  const stopMinutes = parseInt(inputStopHourlyStaminaMin?.value, 10);
  if (!isNaN(stopMinutes) && stopMinutes > 0 && stopMinutes < 60) {
    const serverDate = getServerDate();
    const minutesLeftInHour = 59 - serverDate.getMinutes();
    if (minutesLeftInHour < stopMinutes) {
      return { stop: true, reason: `Next hourly stamina refill is in ${minutesLeftInHour}m (threshold is ${stopMinutes}m).` };
    }
  }

  return { stop: false };
}

window.botAPI.onAccountAdded(async (data) => {
  appendLog('INFO', `Account saved: ${data.name}`);
  await refreshAccounts();
  if (data.name) {
    await window.loginWith(data.name);
  }
});
