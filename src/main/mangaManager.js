/**
 * Manga Manager
 * Manages shared list of manga titles/URLs for chapter energy farming
 * and per-account manga tracking / visibility / farmed counters.
 */

const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');
const { getDataDirectory } = require('../dataDirectory');
const { normalizeMangaInput, parseChapterCatalog } = require('../engine/chapterCatalog');

class MangaManager {
  constructor(dataDir, options = {}) {
    this.httpClient = null;
    this._setPaths(dataDir || getDataDirectory());
    if (options.deferInitialization !== true) this.ensureFiles();
  }

  _setPaths(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.jsonPath = path.join(this.dataDir, 'manga_list.json');
    this.accountDataPath = path.join(this.dataDir, 'account_manga.json');
    this.logPath = path.join(this.dataDir, 'manga.log');
  }

  setDataDirectory(dataDir) {
    this._setPaths(dataDir || getDataDirectory());
    this.ensureFiles();
    return this.dataDir;
  }

  setHttpClient(httpClient) {
    this.httpClient = httpClient || null;
  }

  ensureFiles() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.jsonPath)) {
      fs.writeFileSync(this.jsonPath, JSON.stringify([], null, 2), 'utf-8');
    }
    if (!fs.existsSync(this.accountDataPath)) {
      fs.writeFileSync(this.accountDataPath, JSON.stringify({}, null, 2), 'utf-8');
    }
    if (!fs.existsSync(this.logPath)) {
      fs.writeFileSync(this.logPath, '', 'utf-8');
    }
  }

  getList() {
    try {
      if (!fs.existsSync(this.jsonPath)) return [];
      const content = fs.readFileSync(this.jsonPath, 'utf-8');
      return JSON.parse(content || '[]');
    } catch (err) {
      console.error('Error reading manga list:', err);
      return [];
    }
  }

  saveList(list) {
    try {
      fs.writeFileSync(this.jsonPath, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error saving manga list:', err);
    }
  }

  getAccountData() {
    try {
      if (!fs.existsSync(this.accountDataPath)) return {};
      const content = fs.readFileSync(this.accountDataPath, 'utf-8');
      return JSON.parse(content || '{}');
    } catch (err) {
      console.error('Error reading account manga data:', err);
      return {};
    }
  }

  saveAccountData(data) {
    try {
      fs.writeFileSync(this.accountDataPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error saving account manga data:', err);
    }
  }

  /**
   * Returns manga list customized for a specific account (excludes hidden slugs, includes farmed counts)
   */
  getAccountMangaList(accountName) {
    const globalList = this.getList();
    if (!accountName) return globalList;

    const allAccountData = this.getAccountData();
    const userAcc = allAccountData[accountName] || { hiddenSlugs: [], farmedChapters: {} };
    const hidden = new Set((userAcc.hiddenSlugs || []).map((s) => s.toLowerCase()));
    const farmed = userAcc.farmedChapters || {};

    return globalList
      .filter((m) => !hidden.has(m.slug.toLowerCase()))
      .map((m) => ({
        ...m,
        farmedCount: farmed[m.slug] || 0,
        farmedChapterNumbers: Array.isArray(userAcc.farmedChapterNumbers?.[m.slug])
          ? [...userAcc.farmedChapterNumbers[m.slug]]
          : Array.from({ length: Math.max(0, Number(farmed[m.slug]) || 0) }, (_, index) => index + 1),
      }));
  }

  logEntry(message) {
    try {
      const now = new Date();
      const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
      const serverDate = new Date(utcTime + (330 * 60000));
      const timeStr = serverDate.toISOString().replace('T', ' ').substring(0, 19) + ' (UTC+5:30)';
      const line = `[${timeStr}] ${message}\n`;
      fs.appendFileSync(this.logPath, line, 'utf-8');
    } catch (err) {
      console.error('Error writing to manga.log:', err);
    }
  }

  getLogs() {
    try {
      if (!fs.existsSync(this.logPath)) return '';
      return fs.readFileSync(this.logPath, 'utf-8');
    } catch (err) {
      return '';
    }
  }

  normalizeInput(input) {
    return normalizeMangaInput(input);
  }

  async _fetchPage(url) {
    if (this.httpClient) {
      const response = await this.httpClient.get(url, { retries: 1 });
      return { ok: response.ok, status: response.status, text: response.text || '' };
    }
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }

  async verifyAndAdd(input, accountName) {
    const norm = this.normalizeInput(input);
    if (!norm || !norm.slug) {
      return { success: false, error: 'Invalid manga name or URL.' };
    }

    const currentList = this.getList();
    let existing = currentList.find(
      (m) => m.slug.toLowerCase() === norm.slug.toLowerCase() || m.url.toLowerCase() === norm.url.toLowerCase()
    );

    // If already in global list, make sure it is unhidden for this account
    if (existing) {
      if (accountName) {
        const allAccountData = this.getAccountData();
        if (allAccountData[accountName] && allAccountData[accountName].hiddenSlugs) {
          allAccountData[accountName].hiddenSlugs = allAccountData[accountName].hiddenSlugs.filter(
            (s) => s.toLowerCase() !== existing.slug.toLowerCase()
          );
          this.saveAccountData(allAccountData);
        }
      }
      if (!Array.isArray(existing.chapterEntries) || existing.chapterEntries.length === 0) {
        return this.refreshSingleManga(existing.slug, accountName);
      }
      return { success: true, manga: existing, list: this.getAccountMangaList(accountName) };
    }

    // Fetch page to verify and extract title & chapter count
    try {
      Logger.logApi(accountName, 'GET', norm.url, null, 'Fetching manga details');
      const response = await this._fetchPage(norm.url);

      Logger.logApi(accountName, 'GET', norm.url, response.status, response.ok ? 'OK' : 'Error');

      if (!response.ok) {
        return { success: false, error: `Failed to fetch manga page (Status: ${response.status}). Check name/URL.` };
      }

      const catalog = parseChapterCatalog(response.text, norm.url, norm);
      if (!catalog.recognized) return { success: false, error: 'The page loaded, but no supported chapter list was found.' };

      const newManga = {
        slug: norm.slug,
        title: catalog.title,
        url: norm.url,
        chapters: catalog.chapters,
        chapterEntries: catalog.chapterEntries,
        addedAt: new Date().toISOString(),
      };

      currentList.push(newManga);
      this.saveList(currentList);
      this.logEntry(`Added "${catalog.title}" (${catalog.chapters} chapters) - ${norm.url}`);

      return {
        success: true,
        manga: newManga,
        list: this.getAccountMangaList(accountName),
      };
    } catch (err) {
      Logger.logApi(accountName, 'GET', norm.url, 0, `Exception: ${err.message}`);
      return { success: false, error: `Error verifying manga URL: ${err.message}` };
    }
  }

  /**
   * Delete manga: if accountName is provided, hides it only for that account.
   * If accountName is not provided, removes globally.
   */
  deleteManga(slug, accountName) {
    if (accountName) {
      const allAccountData = this.getAccountData();
      if (!allAccountData[accountName]) {
        allAccountData[accountName] = { hiddenSlugs: [], farmedChapters: {} };
      }
      if (!allAccountData[accountName].hiddenSlugs) {
        allAccountData[accountName].hiddenSlugs = [];
      }
      if (!allAccountData[accountName].hiddenSlugs.includes(slug)) {
        allAccountData[accountName].hiddenSlugs.push(slug);
      }
      this.saveAccountData(allAccountData);
      this.logEntry(`Account [${accountName}] removed manga "${slug}" from view`);
      return { success: true, list: this.getAccountMangaList(accountName) };
    }

    const currentList = this.getList();
    const filtered = currentList.filter((m) => m.slug.toLowerCase() !== slug.toLowerCase());
    this.saveList(filtered);
    this.logEntry(`Globally removed manga with slug "${slug}"`);
    return { success: true, list: filtered };
  }

  /**
   * Increments farmed chapter count for a specific account
   */
  incrementFarmedCount(accountName, targetManga, chapterNumber = null) {
    if (!accountName) return;
    const norm = this.normalizeInput(targetManga);
    const slug = norm ? norm.slug : targetManga;

    const allAccountData = this.getAccountData();
    if (!allAccountData[accountName]) {
      allAccountData[accountName] = { hiddenSlugs: [], farmedChapters: {} };
    }
    if (!allAccountData[accountName].farmedChapters) {
      allAccountData[accountName].farmedChapters = {};
    }
    if (!allAccountData[accountName].farmedChapterNumbers) allAccountData[accountName].farmedChapterNumbers = {};
    const known = new Set((allAccountData[accountName].farmedChapterNumbers[slug]
      || Array.from({ length: Math.max(0, Number(allAccountData[accountName].farmedChapters[slug]) || 0) }, (_, index) => index + 1)).map(Number));
    const chapter = Number(chapterNumber);
    if (Number.isFinite(chapter) && chapter > 0) known.add(chapter);
    else known.add((Number(allAccountData[accountName].farmedChapters[slug]) || 0) + 1);
    allAccountData[accountName].farmedChapterNumbers[slug] = [...known].sort((left, right) => left - right);
    allAccountData[accountName].farmedChapters[slug] = known.size;
    this.saveAccountData(allAccountData);
    this.logEntry(`Account [${accountName}] farmed a chapter of "${slug}" (Total: ${allAccountData[accountName].farmedChapters[slug]})`);
  }

  resetFarmCycle(accountName, cycleId) {
    if (!accountName || !Number.isFinite(Number(cycleId))) return false;
    const allAccountData = this.getAccountData();
    const account = allAccountData[accountName] || { hiddenSlugs: [], farmSettings: {} };
    if (Number(account.farmCycleId) === Number(cycleId)) return false;
    account.farmCycleId = Number(cycleId);
    account.farmedChapters = {};
    account.farmedChapterNumbers = {};
    allAccountData[accountName] = account;
    this.saveAccountData(allAccountData);
    this.logEntry(`Account [${accountName}] started Chapter reward cycle ${cycleId}`);
    return true;
  }

  saveAccountFarmSettings(accountName, settings) {
    if (!accountName) return;
    const allAccountData = this.getAccountData();
    if (!allAccountData[accountName]) {
      allAccountData[accountName] = { hiddenSlugs: [], farmedChapters: {}, farmSettings: {} };
    }
    allAccountData[accountName].farmSettings = {
      ...(allAccountData[accountName].farmSettings || {}),
      ...settings,
    };
    this.saveAccountData(allAccountData);
  }

  getAccountFarmSettings(accountName) {
    if (!accountName) return {};
    const allAccountData = this.getAccountData();
    return allAccountData[accountName]?.farmSettings || {};
  }

  exportAccount(accountName) {
    if (!accountName) return {};
    return JSON.parse(JSON.stringify(this.getAccountData()[accountName] || {}));
  }

  replaceAccount(accountName, payload) {
    if (!accountName || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Manga backup');
    const allAccountData = this.getAccountData();
    allAccountData[accountName] = JSON.parse(JSON.stringify(payload));
    this.saveAccountData(allAccountData);
    return true;
  }

  purgeAccount(accountName) {
    if (!accountName) return false;
    const allAccountData = this.getAccountData();
    const removed = Object.prototype.hasOwnProperty.call(allAccountData, accountName);
    if (removed) {
      delete allAccountData[accountName];
      this.saveAccountData(allAccountData);
    }
    if (fs.existsSync(this.logPath)) {
      const marker = `Account [${accountName}]`;
      const retained = fs.readFileSync(this.logPath, 'utf8')
        .split(/(?<=\n)/)
        .filter(line => !line.includes(marker))
        .join('');
      fs.writeFileSync(this.logPath, retained, { encoding: 'utf8', mode: 0o600 });
    }
    return removed;
  }

  /**
   * Re-fetches title and chapter count for a single manga
   */
  async refreshSingleManga(slug, accountName) {
    const list = this.getList();
    const index = list.findIndex((m) => m.slug.toLowerCase() === slug.toLowerCase());
    if (index === -1) {
      return { success: false, error: `Manga "${slug}" not found in list.` };
    }

    const manga = list[index];
    try {
      Logger.logApi(accountName, 'GET', manga.url, null, `Refreshing manga "${manga.title || manga.slug}"`);
      const response = await this._fetchPage(manga.url);

      Logger.logApi(accountName, 'GET', manga.url, response.status, response.ok ? 'OK' : 'Error');

      if (!response.ok) {
        return { success: false, error: `Failed to fetch manga page (Status: ${response.status})` };
      }

      const catalog = parseChapterCatalog(response.text, manga.url, manga);
      if (!catalog.recognized) return { success: false, error: 'The page loaded, but no supported chapter list was found.' };
      list[index] = { ...manga, ...catalog };
      this.saveList(list);
      this.logEntry(`Refreshed "${catalog.title}" (${catalog.chapters} chapters)`);

      return {
        success: true,
        manga: list[index],
        list: this.getAccountMangaList(accountName),
      };
    } catch (err) {
      Logger.logApi(accountName, 'GET', manga.url, 0, `Exception: ${err.message}`);
      return { success: false, error: `Failed to refresh manga: ${err.message}` };
    }
  }

  /**
   * Re-fetches titles and chapter counts for all manga
   */
  async refreshAllManga(accountName) {
    const list = this.getList();
    let updatedCount = 0;
    for (let i = 0; i < list.length; i++) {
      const manga = list[i];
      try {
        Logger.logApi(accountName, 'GET', manga.url, null, `Refreshing all: "${manga.slug}"`);
        const response = await this._fetchPage(manga.url);
        Logger.logApi(accountName, 'GET', manga.url, response.status, response.ok ? 'OK' : 'Error');
        if (response.ok) {
          const catalog = parseChapterCatalog(response.text, manga.url, manga);
          if (catalog.recognized) {
            list[i] = { ...manga, ...catalog };
            updatedCount++;
          }
        }
      } catch (err) {
        Logger.logApi(accountName, 'GET', manga.url, 0, `Exception: ${err.message}`);
        console.error(`Failed to refresh manga ${manga.slug}:`, err);
      }
    }
    this.saveList(list);
    this.logEntry(`Refreshed chapter counts for ${updatedCount} manga(s)`);
    return { success: true, count: updatedCount, list: this.getAccountMangaList(accountName) };
  }
}

module.exports = { MangaManager, mangaManager: new MangaManager(undefined, { deferInitialization: true }) };
