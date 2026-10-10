const INTERFACE_LANGUAGES = ['en', 'de', 'fr'];
const INTERFACE_LANGUAGE_KEY = 'veybot:language:v1';
let interfaceLanguage = 'en';
try {
  const saved = localStorage.getItem(INTERFACE_LANGUAGE_KEY);
  if (INTERFACE_LANGUAGES.includes(saved)) interfaceLanguage = saved;
} catch { /* Storage may be unavailable; English remains usable. */ }

function uiText(english, ...values) {
  const source = String(english ?? '');
  const key = source.replace(/\s+/g, ' ').trim();
  const value = interfaceLanguage === 'en' ? null : UI_TRANSLATIONS[interfaceLanguage]?.[key];
  const translated = value == null ? source : source.match(/^\s*/)[0] + value.trim() + source.match(/\s*$/)[0];
  return translated.replace(/\{(\d+)\}/g, (match, index) => Number(index) < values.length ? String(values[Number(index)] ?? '') : match);
}

function localizeStaticInterface() {
  // This runs before account hydration, while the DOM contains only our local templates.
  // It never observes subsequent game data or rewrites user/server strings.
  document.documentElement.lang = interfaceLanguage;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = []; let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script, style, textarea')) continue;
    const key = node.textContent.replace(/\s+/g, ' ').trim();
    if (Object.hasOwn(UI_TRANSLATIONS.en, key)) nodes.push(node);
  }
  for (const node of nodes) {
    const source = node.textContent;
    const prefix = source.match(/^\s*/)[0]; const suffix = source.match(/\s*$/)[0];
    node.textContent = prefix + uiText(source.trim()) + suffix;
  }
  for (const element of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      if (element.hasAttribute(attribute)) element.setAttribute(attribute, uiText(element.getAttribute(attribute)));
    }
  }
  const languageSelect = document.getElementById('selectInterfaceLanguage');
  if (languageSelect) {
    languageSelect.value = interfaceLanguage;
    languageSelect.addEventListener('change', async () => {
      const next = languageSelect.value;
      if (!INTERFACE_LANGUAGES.includes(next) || next === interfaceLanguage) return;
      languageSelect.disabled = true;
      try {
        // Finish local draft persistence; changing language does not Apply or restart the engine.
        if (typeof pendingAdventureQuestPatch !== 'undefined' && pendingAdventureQuestPatch) {
          clearTimeout(adventureQuestSaveTimer); await saveAdventureQuestSettings();
        }
        await flushPendingConfigSaves();
        localStorage.setItem(INTERFACE_LANGUAGE_KEY, next);
        localStorage.setItem('veybot:language:return', JSON.stringify({
          tab: typeof currentTab === 'string' ? currentTab : 'home',
          pending: pendingConfigRevision !== appliedConfigRevision,
        }));
        window.location.reload();
      } catch (error) {
        languageSelect.value = interfaceLanguage; languageSelect.disabled = false;
        appendLog('WARN', error.message);
      }
    });
  }
}

function restoreInterfaceLanguageNavigation() {
  try {
    const saved = JSON.parse(localStorage.getItem('veybot:language:return') || 'null');
    localStorage.removeItem('veybot:language:return');
    if (!saved) return;
    if (saved.pending) markConfigDirty();
    if (activeAccount && typeof saved.tab === 'string') window.switchTab(saved.tab);
  } catch { /* Invalid saved navigation does not block login. */ }
}

localizeStaticInterface();
