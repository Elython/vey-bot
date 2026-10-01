/**
 * Window Manager
 * Handles creation and lifecycle of all Electron windows:
 * - Main client box (compact UI)
 * - Background game browser window
 * - Add-account login window
 */

const { BrowserWindow, session, app } = require('electron');
const { icons: lucideIcons } = require('lucide');
const path = require('path');
const { Logger } = require('./logger');
const { SessionManager } = require('./sessionManager');
const { installZoomShortcuts } = require('./zoomController');

const DEFAULT_GAME_URL = 'https://demonicscans.org/game_dash.php';
const GAME_ORIGIN = 'https://demonicscans.org/';
const LOGIN_URL = 'https://demonicscans.org/signin.php';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const ALLOWED_REMOTE_HOSTS = new Set(['demonicscans.org', 'www.demonicscans.org', 'challenges.cloudflare.com']);

function isAllowedRemoteUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && ALLOWED_REMOTE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function normalizeBattleUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 300) return null;
  try {
    const url = new URL(rawUrl, GAME_ORIGIN);
    if (url.origin !== new URL(GAME_ORIGIN).origin || url.pathname !== '/battle.php' || url.hash) return null;
    const id = url.searchParams.get('id');
    const dgmid = url.searchParams.get('dgmid');
    const instanceId = url.searchParams.get('instance_id');
    if (/^\d+$/.test(String(id || '')) && !dgmid && !instanceId) {
      return `${GAME_ORIGIN}battle.php?id=${encodeURIComponent(id)}`;
    }
    if (!id && /^\d+$/.test(String(dgmid || '')) && /^\d+$/.test(String(instanceId || ''))) {
      return `${GAME_ORIGIN}battle.php?dgmid=${encodeURIComponent(dgmid)}&instance_id=${encodeURIComponent(instanceId)}`;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeCubePvpMatchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, GAME_ORIGIN);
    if (url.origin !== new URL(GAME_ORIGIN).origin || url.pathname !== '/pvp_style_battle.php' || url.searchParams.get('source') !== 'cube') return null;
    for (const field of ['instance_id', 'node_id', 'match_no']) {
      if (!/^\d+$/.test(String(url.searchParams.get(field) || ''))) return null;
    }
    return `${GAME_ORIGIN}pvp_style_battle.php?source=cube&instance_id=${encodeURIComponent(url.searchParams.get('instance_id'))}&node_id=${encodeURIComponent(url.searchParams.get('node_id'))}&match_no=${encodeURIComponent(url.searchParams.get('match_no'))}`;
  } catch {
    return null;
  }
}

function normalizeMonsterPhasePvpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, GAME_ORIGIN);
    const activeId = url.searchParams.get('active_id');
    if (url.origin !== new URL(GAME_ORIGIN).origin || url.pathname !== '/pvp_style_battle.php'
      || url.searchParams.get('source') !== 'monster_phase' || !/^\d+$/.test(String(activeId || ''))) return null;
    return `${GAME_ORIGIN}pvp_style_battle.php?source=monster_phase&active_id=${encodeURIComponent(activeId)}`;
  } catch {
    return null;
  }
}

class WindowManager {
  /**
   * @param {SessionManager} sessionManager
   * @param {import('./credentialManager').CredentialManager|null} credentialManager
   */
  constructor(sessionManager, credentialManager = null) {
    this.sessionManager = sessionManager;
    this.credentialManager = credentialManager;
    this.mainWindow = null;
    this.gameWindow = null;
    this.gameWindowAccount = null;
    this.gameSetupPromise = null;
    this.gameSetupAccount = null;
    this.addAccountWindow = null;
    this.cubePvpWatcher = null;
    this.cubePvpWatcherAccount = null;
    this.cubePvpWatcherUrl = null;
    this.monsterPhasePvpWatcher = null;
    this.monsterPhasePvpWatcherAccount = null;
    this.monsterPhasePvpWatcherUrl = null;
    this.capturedLoginAccount = null;
    this.mainZoomCleanup = null;
  }

  /**
   * Create the main compact client box window
   * @returns {BrowserWindow}
   */
  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 660,
      height: 520,
      minWidth: 560,
      minHeight: 420,
      resizable: true,
      backgroundColor: '#1b1b1b',
      title: 'Veybot',
      frame: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    this.mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file:')) event.preventDefault();
    });
    this.mainZoomCleanup?.();
    this.mainZoomCleanup = installZoomShortcuts(this.mainWindow.webContents);

    this.mainWindow.on('closed', () => {
      this.mainZoomCleanup?.();
      this.mainZoomCleanup = null;
      if (this.gameWindow && !this.gameWindow.isDestroyed()) {
        this.gameWindow.destroy();
      }
      if (this.addAccountWindow && !this.addAccountWindow.isDestroyed()) {
        this.addAccountWindow.destroy();
      }
      this.destroyCubePvpWatcher();
      this.destroyMonsterPhasePvpWatcher();
      this.mainWindow = null;
      app.quit();
    });

    return this.mainWindow;
  }

  /**
   * Creates or reuses the persistent hidden game window for an account.
   * Concurrent requests for the same account share one setup operation.
   * @param {string} accountName
   * @returns {Promise<BrowserWindow>}
   */
  async setupGameWindow(accountName) {
    while (this.gameSetupPromise) {
      if (this.gameSetupAccount === accountName) return this.gameSetupPromise;
      await this.gameSetupPromise.catch(() => null);
    }

    this.gameSetupAccount = accountName;
    const setupPromise = this._setupGameWindow(accountName);
    this.gameSetupPromise = setupPromise;
    try {
      return await setupPromise;
    } finally {
      if (this.gameSetupPromise === setupPromise) {
        this.gameSetupPromise = null;
        this.gameSetupAccount = null;
      }
    }
  }

  async _setupGameWindow(accountName) {
    const hasReusableWindow = this.gameWindow && !this.gameWindow.isDestroyed() && this.gameWindowAccount === accountName;
    if (this.gameWindow && !this.gameWindow.isDestroyed() && !hasReusableWindow) {
      this.gameWindow.destroy();
      this.gameWindow = null;
      this.gameWindowAccount = null;
    }

    const partitionName = `persist:veyra_${encodeURIComponent(accountName)}`;
    const gameSession = session.fromPartition(partitionName);
    gameSession.setUserAgent(USER_AGENT);

    // Restore only missing, non-expired cookies. The persistent partition may
    // contain newer cookies refreshed during the previous application run.
    const restoreResult = await this.sessionManager.restoreAccountSession(gameSession, accountName);
    Logger.logClient(
      accountName,
      `Session prepared: restored=${restoreResult.restoredCount || 0}, preserved=${restoreResult.preservedCount || 0}, expired-skipped=${restoreResult.skippedExpired || 0}`
    );
    await this._normalizeWavePreferenceCookies(gameSession, accountName);

    if (!hasReusableWindow) {
      this.gameWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        title: `Veybot Browser - [${accountName}]`,
        webPreferences: {
          session: gameSession,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // Keep the authenticated renderer alive while hidden, but let
          // Chromium throttle the site's recurring timers and status polls.
          backgroundThrottling: true,
        },
      });
      this.gameWindowAccount = accountName;

      this.gameWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.gameWindow.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedRemoteUrl(url)) {
          event.preventDefault();
          Logger.logClient(accountName, `Blocked unexpected game navigation to ${url}`);
        }
      });

      // Closing the viewer only hides it; its account session stays alive.
      this.gameWindow.on('close', (event) => {
        if (!app.isQuitting && this.mainWindow && !this.mainWindow.isDestroyed()) {
          event.preventDefault();
          this.gameWindow.hide();
          this.sendToMain('bot:log', { level: 'INFO', message: 'Game browser view hidden in background.' });
        }
      });
    }

    await this.gameWindow.loadURL(DEFAULT_GAME_URL);
    await this._assertAuthenticatedGamePage(accountName, 'Dashboard');
    await this.injectGameBrowserControls();
    await this.sessionManager.saveAccountSession(gameSession, accountName);
    this.gameWindow.hide();
    return this.gameWindow;
  }

  /**
   * Older builds could create host-only and domain variants of the wave filter
   * cookies while performing loot discovery. Duplicate names make the site's
   * document.cookie toggle ambiguous. Collapse duplicates once at login while
   * preserving the browser-writable host-only value when one exists.
   */
  async _normalizeWavePreferenceCookies(gameSession, accountName) {
    for (const name of ['hide_dead_monsters', 'show_dead_bosses_only']) {
      const matches = await gameSession.cookies.get({ url: GAME_ORIGIN, name });
      if (matches.length <= 1) continue;
      const preferred = matches.find(cookie => cookie.hostOnly && (cookie.path || '/') === '/') || matches[0];
      const value = preferred.value === '1' ? '1' : '0';
      let remaining = matches;
      for (let attempt = 0; attempt < 8 && remaining.length > 0; attempt += 1) {
        await gameSession.cookies.remove(GAME_ORIGIN, name);
        remaining = await gameSession.cookies.get({ url: GAME_ORIGIN, name });
      }
      if (remaining.length > 0) throw new Error(`Could not normalize duplicate ${name} cookies`);
      await gameSession.cookies.set({
        url: GAME_ORIGIN,
        name,
        value,
        path: '/',
        secure: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60),
      });
      const normalized = await gameSession.cookies.get({ url: GAME_ORIGIN, name });
      if (normalized.length !== 1) throw new Error(`Could not create a canonical ${name} cookie`);
      Logger.logClient(accountName, `Normalized duplicate ${name} browser preference cookies`);
    }
  }

  async _assertAuthenticatedGamePage(accountName, pageLabel) {
    if (!this.gameWindow || this.gameWindow.isDestroyed()) {
      throw new Error('Game browser closed while preparing the account session');
    }
    const state = await this.gameWindow.webContents.executeJavaScript(`
      (() => ({
        username: document.querySelector('.small-name')?.textContent?.trim() || null,
        isLogin: /signin\\.php|\\/login/i.test(location.href) || Boolean(document.querySelector('input[type="password"]')),
        isChallenge: Boolean(
          document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
          document.querySelector('.cf-turnstile') ||
          document.querySelector('#challenge-stage') ||
          document.title.includes('Just a moment...')
        ),
      }))()
    `);
    if (state.isChallenge) {
      this.gameWindow.show();
      throw new Error(`Cloudflare verification is required on the ${pageLabel} page. Complete it in the opened game browser, then log in again.`);
    }
    if (state.isLogin || !state.username) {
      throw new Error(`Saved session is not authenticated on the ${pageLabel} page. Please add the account again.`);
    }
    Logger.logClient(accountName, `${pageLabel} authentication verified for the active session`);
    return state;
  }

  async _replacePersistentAccountSession(accountName) {
    const partitionName = `persist:veyra_${encodeURIComponent(accountName)}`;
    const accountSession = session.fromPartition(partitionName);
    await accountSession.clearStorageData({ storages: ['cookies'] });
    const restored = await this.sessionManager.restoreAccountSession(accountSession, accountName);
    if (!restored.success) {
      throw new Error('Fresh account cookies could not be copied into the persistent game session');
    }
  }

  /**
   * Opens a visible browser window for the user to log in and capture cookies
   */
  openAddAccountWindow() {
    if (this.addAccountWindow && !this.addAccountWindow.isDestroyed()) {
      this.addAccountWindow.show();
      this.addAccountWindow.focus();
      return;
    }

    const tempSession = session.fromPartition(`persist:veyra_temp_login_${Date.now()}`);
    tempSession.setUserAgent(USER_AGENT);

    this.addAccountWindow = new BrowserWindow({
      width: 1000,
      height: 750,
      title: 'Veybot Account Login',
      webPreferences: {
        session: tempSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    this.addAccountWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.addAccountWindow.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedRemoteUrl(url)) {
        event.preventDefault();
        Logger.logClient('NewAccount', `Blocked unexpected login navigation to ${url}`);
      }
    });

    let isSaved = false;
    let isRedirectingToDash = false;
    let isChecking = false;
    let pendingCredentials = null;

    const fillSavedCredentials = async () => {
      if (!this.addAccountWindow || this.addAccountWindow.isDestroyed()) return;
      let pageUrl;
      try {
        pageUrl = new URL(this.addAccountWindow.webContents.getURL());
      } catch {
        return;
      }
      if (pageUrl.hostname !== 'demonicscans.org' || pageUrl.pathname !== '/signin.php') return;
      const saved = this.credentialManager?.get();
      if (!saved) return;
      await this.addAccountWindow.webContents.executeJavaScript(`
        (() => {
          const email = document.querySelector('input[name="email"][type="email"]');
          const password = document.querySelector('input[name="password"][type="password"]');
          if (!email || !password || email.value || password.value) return false;
          email.value = ${JSON.stringify(saved.email)};
          password.value = ${JSON.stringify(saved.password)};
          for (const field of [email, password]) {
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return true;
        })();
      `);
    };

    const checkAndSaveLogin = async () => {
      if (isSaved || isChecking || !this.addAccountWindow || this.addAccountWindow.isDestroyed()) return;
      isChecking = true;
      try {
        const loginState = await this.addAccountWindow.webContents.executeJavaScript(`
          (function() {
            const el = document.querySelector('.small-name');
            const username = el && el.innerText.trim() ? el.innerText.trim() : null;
            const emailField = document.querySelector('input[name="email"][type="email"]');
            const passwordField = document.querySelector('input[name="password"][type="password"]');
            return {
              username,
              isAuthenticated: Boolean(username) && !document.querySelector('input[type="password"]'),
              isDash: window.location.href.includes('game_dash.php'),
              credentials: emailField && passwordField && emailField.value && passwordField.value
                ? { email: emailField.value, password: passwordField.value }
                : null,
            };
          })();
        `);

        if (!loginState) return;
        if (loginState.credentials) pendingCredentials = loginState.credentials;

        // Authentication can complete on index.php behind a site popup. Direct
        // navigation does not depend on the user dismissing that page overlay.
        if (loginState.isAuthenticated && !loginState.isDash && !isRedirectingToDash) {
          isRedirectingToDash = true;
          Logger.logClient(loginState.username || 'NewAccount', 'User authenticated at signin.php. Auto-redirecting to game_dash.php for cookie acquisition...');
          try {
            await this.addAccountWindow.loadURL(DEFAULT_GAME_URL);
          } finally {
            isRedirectingToDash = false;
          }
          return;
        }

        // If on game_dash.php or login detected with username
        if (loginState.isDash && loginState.isAuthenticated) {
          const cookies = await tempSession.cookies.get({});
          const finalName = loginState.username || `Account_${Date.now().toString().slice(-4)}`;
          if (cookies.length > 0 && loginState.username) {
            await this.sessionManager.saveAccountSession(tempSession, finalName);
            await this._replacePersistentAccountSession(finalName);
            isSaved = true;
            this.capturedLoginAccount = finalName;
            if (pendingCredentials) {
              try {
                const savedCredentials = this.credentialManager?.save(
                  finalName,
                  pendingCredentials.email,
                  pendingCredentials.password
                );
                Logger.logClient(finalName, savedCredentials
                  ? 'Encrypted login autocomplete was saved locally'
                  : 'Login autocomplete was not saved because OS encryption is unavailable');
              } catch {
                Logger.logClient(finalName, 'Login autocomplete could not be saved securely');
              }
              pendingCredentials = null;
            }
            Logger.logClient(finalName, `Successfully captured ${cookies.length} session cookies from game_dash.php`);
            this.sendToMain('account:added', { name: finalName, count: cookies.length });
            this.sendToMain('bot:log', { level: 'INFO', message: `Added new account: ${finalName}` });
          }
          if (isSaved && this.addAccountWindow && !this.addAccountWindow.isDestroyed()) {
            // The named persistent game window is prepared by the single login
            // request. Keep this authenticated browser alive (hidden) until
            // that handoff succeeds so there is never a browser-less gap.
            this.addAccountWindow.hide();
          }
        }
      } catch (err) {
        Logger.logClient('NewAccount', `Login state check deferred during navigation: ${err.message}`);
      } finally {
        isChecking = false;
      }
    };

    // Poll with jitter and also check on navigation.
    let checkTimer = null;
    const scheduleCheck = () => {
      if (!this.addAccountWindow || this.addAccountWindow.isDestroyed()) return;
      const delay = 650 + Math.floor(Math.random() * 300);
      checkTimer = setTimeout(async () => {
        await checkAndSaveLogin();
        scheduleCheck();
      }, delay);
    };
    scheduleCheck();
    this.addAccountWindow.webContents.on('did-navigate', checkAndSaveLogin);
    this.addAccountWindow.webContents.on('did-finish-load', async () => {
      try {
        await fillSavedCredentials();
      } catch {
        Logger.logClient('NewAccount', 'Login autocomplete could not be applied securely');
      }
      await checkAndSaveLogin();
    });

    this.addAccountWindow.on('close', async () => {
      clearTimeout(checkTimer);
      if (!isSaved) this.sendToMain('bot:log', { level: 'WARN', message: 'Login browser closed before authenticated game content was detected.' });
      this.addAccountWindow = null;
    });

    this.addAccountWindow.loadURL(LOGIN_URL);
  }

  finalizeAddAccountLogin(accountName, success) {
    if (!this.addAccountWindow || this.addAccountWindow.isDestroyed() || this.capturedLoginAccount !== accountName) return;
    if (success) {
      this.addAccountWindow.destroy();
      this.addAccountWindow = null;
      this.capturedLoginAccount = null;
    } else {
      this.addAccountWindow.show();
      this.addAccountWindow.focus();
    }
  }

  /**
   * Add local navigation controls to the companion page. The control is
   * recreated after every navigation and only uses the browser's own history.
   */
  async injectGameBrowserControls() {
    const webContents = this.getGameWebContents();
    if (!webContents || webContents.isDestroyed()) return false;
    try {
      const arrowLeftIcon = JSON.stringify(lucideIcons.ArrowLeft);
      return await webContents.executeJavaScript(`
        (() => {
          if (document.getElementById('__veyraBrowserBack')) return true;
          const button = document.createElement('button');
          button.id = '__veyraBrowserBack';
          button.type = 'button';
          button.title = 'Go to the previous page';
          button.setAttribute('aria-label', 'Go to the previous page');
          const svgNamespace = 'http://www.w3.org/2000/svg';
          const icon = document.createElementNS(svgNamespace, 'svg');
          Object.entries({
            width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          }).forEach(([name, value]) => icon.setAttribute(name, value));
          icon.setAttribute('aria-hidden', 'true');
          for (const [tagName, attributes] of ${arrowLeftIcon}) {
            const child = document.createElementNS(svgNamespace, tagName);
            Object.entries(attributes).forEach(([name, value]) => child.setAttribute(name, String(value)));
            icon.appendChild(child);
          }
          button.append(icon, document.createTextNode('Back'));
          Object.assign(button.style, {
            position: 'fixed',
            top: '12px',
            right: '12px',
            zIndex: '2147483647',
            padding: '8px 12px',
            border: '1px solid rgba(255,255,255,.28)',
            borderRadius: '6px',
            background: 'rgba(24,24,24,.92)',
            color: '#fff',
            font: '600 13px system-ui, sans-serif',
            lineHeight: '1',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,.45)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
          });
          button.addEventListener('mouseenter', () => { button.style.background = 'rgba(50,50,50,.96)'; });
          button.addEventListener('mouseleave', () => { button.style.background = 'rgba(24,24,24,.92)'; });
          button.addEventListener('click', () => window.history.back());
          (document.body || document.documentElement).appendChild(button);
          return true;
        })();
      `);
    } catch (error) {
      Logger.logClient(this.gameWindowAccount, `Browser Back control could not be added: ${error.message}`);
      return false;
    }
  }

  /**
   * Show the game window (View in Browser)
   * @returns {{ success: boolean, error?: string }}
   */
  showGameWindow() {
    if (this.gameWindow && !this.gameWindow.isDestroyed()) {
      this.gameWindow.show();
      this.gameWindow.focus();
      return { success: true };
    }
    return { success: false, error: 'No active game session' };
  }

  async openGameBattle(rawUrl) {
    const url = normalizeBattleUrl(rawUrl);
    if (!url) return { success: false, error: 'Invalid battle history URL' };
    if (!this.gameWindow || this.gameWindow.isDestroyed()) return { success: false, error: 'No active game session' };
    await this.gameWindow.loadURL(url);
    await this.injectGameBrowserControls();
    this.gameWindow.show();
    this.gameWindow.focus();
    return { success: true };
  }

  hideGameWindow() {
    if (this.gameWindow && !this.gameWindow.isDestroyed()) {
      this.gameWindow.hide();
      return true;
    }
    return false;
  }

  /**
   * Destroy the game window
   */
  destroyGameWindow(accountName = null) {
    if (accountName && this.gameWindowAccount !== accountName) return false;
    if (this.gameWindow && !this.gameWindow.isDestroyed()) {
      this.gameWindow.destroy();
      this.gameWindow = null;
      this.gameWindowAccount = null;
      return true;
    }
    return false;
  }

  async ensureCubePvpWatcher(accountName, rawUrl) {
    const url = normalizeCubePvpMatchUrl(rawUrl);
    if (!accountName || !url) throw new Error('Invalid Cube PvP watcher target');
    if (this.cubePvpWatcher && !this.cubePvpWatcher.isDestroyed()
      && this.cubePvpWatcherAccount === accountName && this.cubePvpWatcherUrl === url) return this.cubePvpWatcher;
    this.destroyCubePvpWatcher();
    const accountSession = session.fromPartition(`persist:veyra_${encodeURIComponent(accountName)}`);
    accountSession.setUserAgent(USER_AGENT);
    this.cubePvpWatcher = new BrowserWindow({
      width: 1100, height: 760, show: false, title: `Veybot Cube PvP - [${accountName}]`,
      webPreferences: {
        session: accountSession, contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.cubePvpWatcherAccount = accountName;
    this.cubePvpWatcherUrl = url;
    this.cubePvpWatcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.cubePvpWatcher.webContents.on('will-navigate', (event, nextUrl) => {
      if (normalizeCubePvpMatchUrl(nextUrl) !== this.cubePvpWatcherUrl) event.preventDefault();
    });
    this.cubePvpWatcher.on('closed', () => {
      this.cubePvpWatcher = null;
      this.cubePvpWatcherAccount = null;
      this.cubePvpWatcherUrl = null;
    });
    await this.cubePvpWatcher.loadURL(url);
    return this.cubePvpWatcher;
  }

  destroyCubePvpWatcher(accountName = null) {
    if (accountName && this.cubePvpWatcherAccount !== accountName) return false;
    const watcher = this.cubePvpWatcher;
    this.cubePvpWatcher = null;
    this.cubePvpWatcherAccount = null;
    this.cubePvpWatcherUrl = null;
    if (watcher && !watcher.isDestroyed()) {
      watcher.destroy();
      return true;
    }
    return false;
  }

  openCubePvpMatch(accountName, rawUrl) {
    const url = normalizeCubePvpMatchUrl(rawUrl);
    if (!url || this.cubePvpWatcherAccount !== accountName || !this.cubePvpWatcher || this.cubePvpWatcher.isDestroyed()) return false;
    this.cubePvpWatcher.show();
    this.cubePvpWatcher.focus();
    return true;
  }

  async ensureMonsterPhasePvpWatcher(accountName, rawUrl) {
    const url = normalizeMonsterPhasePvpUrl(rawUrl);
    if (!accountName || !url) throw new Error('Invalid monster-phase PvP watcher target');
    if (this.monsterPhasePvpWatcher && !this.monsterPhasePvpWatcher.isDestroyed()
      && this.monsterPhasePvpWatcherAccount === accountName && this.monsterPhasePvpWatcherUrl === url) {
      return this.monsterPhasePvpWatcher;
    }
    this.destroyMonsterPhasePvpWatcher();
    const accountSession = session.fromPartition(`persist:veyra_${encodeURIComponent(accountName)}`);
    accountSession.setUserAgent(USER_AGENT);
    this.monsterPhasePvpWatcher = new BrowserWindow({
      width: 1100, height: 760, show: false, title: `Veybot Monster Phase PvP - [${accountName}]`,
      webPreferences: {
        session: accountSession, contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.monsterPhasePvpWatcherAccount = accountName;
    this.monsterPhasePvpWatcherUrl = url;
    this.monsterPhasePvpWatcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.monsterPhasePvpWatcher.webContents.on('will-navigate', (event, nextUrl) => {
      if (normalizeMonsterPhasePvpUrl(nextUrl) !== this.monsterPhasePvpWatcherUrl) event.preventDefault();
    });
    this.monsterPhasePvpWatcher.on('closed', () => {
      this.monsterPhasePvpWatcher = null;
      this.monsterPhasePvpWatcherAccount = null;
      this.monsterPhasePvpWatcherUrl = null;
    });
    await this.monsterPhasePvpWatcher.loadURL(url);
    return this.monsterPhasePvpWatcher;
  }

  destroyMonsterPhasePvpWatcher(accountName = null) {
    if (accountName && this.monsterPhasePvpWatcherAccount !== accountName) return false;
    const watcher = this.monsterPhasePvpWatcher;
    this.monsterPhasePvpWatcher = null;
    this.monsterPhasePvpWatcherAccount = null;
    this.monsterPhasePvpWatcherUrl = null;
    if (watcher && !watcher.isDestroyed()) {
      watcher.destroy();
      return true;
    }
    return false;
  }

  async purgeAccountStorage(accountName) {
    if (!accountName) return false;
    this.destroyGameWindow(accountName);
    this.destroyCubePvpWatcher(accountName);
    this.destroyMonsterPhasePvpWatcher(accountName);
    const partitionName = `persist:veyra_${encodeURIComponent(accountName)}`;
    const accountSession = session.fromPartition(partitionName);
    await accountSession.clearCache();
    await accountSession.clearStorageData();
    accountSession.flushStorageData();
    return true;
  }

  /**
   * Send an IPC message to the main window renderer
   * @param {string} channel
   * @param {*} data
   */
  sendToMain(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Flash the main window taskbar (e.g. captcha alert)
   */
  flashMainWindow() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.flashFrame(true);
    }
  }

  /**
   * Get the game window's webContents
   * @returns {import('electron').WebContents|null}
   */
  getGameWebContents() {
    if (this.gameWindow && !this.gameWindow.isDestroyed()) {
      return this.gameWindow.webContents;
    }
    return null;
  }
}

module.exports = { WindowManager, normalizeBattleUrl, normalizeCubePvpMatchUrl };
