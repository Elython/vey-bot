/**
 * Read-only game state adapter.
 * Server state comes from GameAPI; the visible page is observed only for verified live fields
 * and human-in-the-loop challenge detection.
 */

const { stateStore } = require('./stateStore');
const { Logger } = require('../main/logger');

class GameReader {
  constructor(webContents, gameAPI, httpClient, accountName = null, statsService = null, areaAccessService = null) {
    this.webContents = webContents;
    this.gameAPI = gameAPI;
    this.http = httpClient;
    this.accountName = accountName;
    this.statsService = statsService;
    this.areaAccessService = areaAccessService;
    this.farmedEnergyPromise = null;
  }

  setWebContents(webContents) {
    this.webContents = webContents;
    this.http?.setWebContents(webContents);
  }

  setAccount(accountName) {
    this.accountName = accountName;
  }

  async fetchStatsNow() {
    if (!this.gameAPI) throw new Error('GameAPI is not configured');
    if (this.statsService) {
      try {
        await this.statsService.read({ maxAgeMs: 0 });
        return stateStore.getState();
      } catch (error) {
        Logger.logClient(this.accountName, `Stats refresh failed: ${error.cause?.message || error.message}`);
        throw (error.cause || error);
      }
    }
    const resourcesRead = (async () => {
      // HP/Mana live on wave pages, but unlocked waves are account-specific.
      // Never use a universal fallback such as Grakthar 2: a low-level account
      // legitimately receives HTTP 503 there and that unrelated read must not
      // poison combat on an accessible Gate.
      const route = this.areaAccessService
        ? await this.areaAccessService.getPlayerResourceRoute()
        : null;
      return route
        ? this.gameAPI.fetchPlayerResources(route.gateId, route.wave)
        : (this.gameAPI?.fetchPlayerResources ? this.gameAPI.fetchPlayerResources() : {});
    })();
    const [statsResult, dashboardResult, resourcesResult] = await Promise.allSettled([
      this.gameAPI.fetchStats(),
      this.gameAPI.fetchDashboard(),
      resourcesRead,
    ]);

    if (statsResult.status === 'rejected' && dashboardResult.status === 'rejected') {
      const message = `${statsResult.reason?.message || 'stats failed'}; ${dashboardResult.reason?.message || 'dashboard failed'}`;
      Logger.logClient(this.accountName, `Stats refresh failed: ${message}`);
      throw new Error(message);
    }

    // Dashboard/topbar Stamina can remain at the pre-potion value. Keep it as
    // a fallback for fields absent from Stats, but let stats.php win whenever
    // both authenticated resources expose the same value.
    const raw = {
      ...(dashboardResult.status === 'fulfilled' ? dashboardResult.value : {}),
      ...(statsResult.status === 'fulfilled' ? statsResult.value : {}),
    };
    const updates = { isConnected: true };
    if (raw.stamina !== undefined || raw.maxStamina !== undefined) {
      const previous = stateStore.getState().stamina;
      updates.stamina = {
        current: raw.stamina ?? previous.current,
        max: raw.maxStamina ?? previous.max,
      };
    }
    if (raw.maxStamina !== undefined) updates.totalStamina = raw.maxStamina;
    for (const key of ['attack', 'defense', 'level', 'gold', 'gems', 'serverEpoch', 'serverTzOff', 'username']) {
      if (raw[key] !== undefined) updates[key] = raw[key];
    }
    if (raw.expCurrent !== undefined && raw.expRequired !== undefined) {
      updates.exp = `${raw.expCurrent} / ${raw.expRequired}`;
      updates.expCurrent = raw.expCurrent;
      updates.expRequired = raw.expRequired;
    }
    if (raw.expPercent !== undefined) updates.expPercent = `${raw.expPercent}%`;
    if (raw.lootXpBoost?.recognized === true) updates.lootXpBoost = raw.lootXpBoost;
    if (resourcesResult.status === 'fulfilled') {
      if (resourcesResult.value.hp) updates.hp = resourcesResult.value.hp;
      if (resourcesResult.value.mp) updates.mp = resourcesResult.value.mp;
    }
    stateStore.update(updates);
    return stateStore.getState();
  }

  async readTopbarState() {
    return this.gameAPI.fetchDashboard();
  }

  async readBattleState(battleId) {
    return this.gameAPI.getBattleConfig(battleId);
  }

  async injectDOMObserver() {
    if (!this.webContents || this.webContents.isDestroyed()) return false;
    try {
      return await this.webContents.executeJavaScript(`
        (() => {
          if (window._veyraObserverInjected) return true;
          const targets = ['#stamina_span', '#hpFill', '#pHpText', '#pManaText', '.player-resources']
            .map(selector => document.querySelector(selector))
            .filter(Boolean);
          if (targets.length === 0) return false;
          window._veyraObserverInjected = true;
          let timer = null;
          const observer = new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => {
              timer = null;
              console.log('__VEYRA_DOM_MUTATION__');
            }, 80);
          });
          targets.forEach(target => observer.observe(target, {
            attributes: true,
            childList: true,
            subtree: true,
            characterData: true,
          }));
          return true;
        })();
      `);
    } catch (error) {
      Logger.logClient(this.accountName, `DOM observer injection failed: ${error.message}`);
      return false;
    }
  }

  async fetchFarmedEnergy(slug = 'The-Investor-Who-Sees-The-Future', chapterNum = 1) {
    if (this.farmedEnergyPromise) return this.farmedEnergyPromise;
    const refresh = this._fetchFarmedEnergy(slug, chapterNum);
    this.farmedEnergyPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.farmedEnergyPromise === refresh) this.farmedEnergyPromise = null;
    }
  }

  async _fetchFarmedEnergy(slug, chapterNum) {
    if (!this.http) throw new Error('HttpClient is not configured');
    const safeSlug = String(slug || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(safeSlug)) throw new Error('Invalid manga slug');

    const chapters = [Math.max(1, Number.parseInt(chapterNum, 10) || 1)];
    if (chapters[0] === 1) chapters.push(2);
    for (const chapter of chapters) {
      const targetUrl = `https://demonicscans.org/title/${encodeURIComponent(safeSlug)}/chapter/${chapter}/1`;
      try {
        const response = await this.http.get(targetUrl, { retries: 1 });
        if (!response.ok) continue;
        const match = response.text.match(/class=["'][^"']*\bval\b[^"']*["'][^>]*>\s*([0-9,]+)\s*\/\s*1,?000/i);
        const fallback = response.text.match(/"(?:farmed|energy)"\s*:\s*(\d+)/i);
        const value = Number.parseInt((match?.[1] || fallback?.[1] || '').replace(/,/g, ''), 10);
        if (Number.isFinite(value)) {
          stateStore.update({ farmedEnergy: value });
          return value;
        }
      } catch (error) {
        Logger.logClient(this.accountName, `Farmed energy read failed for chapter ${chapter}: ${error.message}`);
      }
    }
    return null;
  }

  async readState({ syncStamina = false } = {}) {
    if (!this.webContents || this.webContents.isDestroyed()) {
      stateStore.update({ isConnected: false });
      return { isConnected: false, url: '' };
    }

    try {
      const observedAt = Date.now();
      const domState = await this.webContents.executeJavaScript(`
        (() => {
          const pairFromElement = (element) => {
            const match = element?.textContent?.match(/([\\d,]+)\\s*\\/\\s*([\\d,]+)/);
            return match ? {
              current: Number(match[1].replace(/,/g, '')),
              max: Number(match[2].replace(/,/g, '')),
            } : null;
          };
          const pair = (selector) => pairFromElement(document.querySelector(selector));
          const resourcePair = (resourceName) => {
            const row = Array.from(document.querySelectorAll('.player-resources .res-row')).find(candidate => {
              const label = candidate.querySelector('.res-label')?.textContent || '';
              return new RegExp('\\b' + resourceName + '\\b', 'i').test(label);
            });
            return pairFromElement(row?.querySelector('.res-meta'));
          };
          const staminaElement = document.querySelector('#stamina_span');
          const hasCloudflare = Boolean(
            document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
            document.querySelector('.cf-turnstile') ||
            document.querySelector('#challenge-stage') ||
            document.title.includes('Just a moment...') ||
            document.title.includes('Attention Required! | Cloudflare')
          );
          const path = window.location.pathname;
          return {
            isConnected: true,
            url: window.location.href,
            title: document.title,
            hasCloudflare,
            isLoginPage: path.includes('signin.php') || Boolean(document.querySelector('input[type="password"]')),
            stamina: pairFromElement(staminaElement?.parentElement),
            hp: pair('#pHpText') || resourcePair('hp'),
            mp: pair('#pManaText') || resourcePair('mana'),
            monsterHp: pair('#hpText'),
            monsterHpPercent: Number.parseFloat(document.querySelector('#hpFill')?.style?.width || '') || null,
            battleId: new URLSearchParams(window.location.search).get('id'),
          };
        })();
      `);

      const updates = {};
      // The hidden page may keep showing its pre-reaction stamina until the
      // site reloads. Only a verified MutationObserver event may let that DOM
      // value replace the authoritative Stats response.
      if (syncStamina && domState.stamina) {
        updates.stamina = domState.stamina;
        updates.totalStamina = domState.stamina.max;
      }
      if (domState.hp) updates.hp = domState.hp;
      if (domState.mp) updates.mp = domState.mp;
      stateStore.update({ isConnected: true });
      if (this.statsService) {
        this.statsService.observePartial(updates, {
          observedAt,
          source: syncStamina ? 'verified companion DOM mutation' : 'verified companion DOM resources',
        });
      } else {
        stateStore.update(updates);
      }
      const stored = stateStore.getState();
      return {
        ...domState,
        player: {
          hp: stored.hp,
          mp: stored.mp,
          level: stored.level,
          stamina: stored.stamina,
          attack: stored.attack,
          defense: stored.defense,
          totalStamina: stored.totalStamina,
          hourlyRefill: stored.hourlyRefill,
          twelveHourRefill: stored.twelveHourRefill,
          nextStaminaIncrease: stored.nextStaminaIncrease,
          gold: stored.gold,
          gems: stored.gems,
          exp: stored.exp,
          expCurrent: stored.expCurrent,
          expRequired: stored.expRequired,
          expPercent: stored.expPercent,
          farmedEnergy: stored.farmedEnergy,
          hpPercent: stored.hp.max > 0 ? Math.round((stored.hp.current / stored.hp.max) * 100) : 100,
          mpPercent: stored.mp.max > 0 ? Math.round((stored.mp.current / stored.mp.max) * 100) : 100,
        },
      };
    } catch (error) {
      Logger.logClient(this.accountName, `Live state read failed: ${error.message}`);
      stateStore.update({ isConnected: false });
      return { isConnected: false, error: error.message };
    }
  }

  observeStats(partial, source = 'verified game action response', options = {}) {
    if (this.statsService) return this.statsService.observePartial(partial, { ...options, source });
    stateStore.update(partial);
    return { applied: true };
  }

  observeResources(resources, source = 'verified authenticated page resources', options = {}) {
    return this.observeStats(resources, source, options);
  }
}

module.exports = { GameReader };
