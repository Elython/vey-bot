/**
 * Session Manager
 * Handles multi-account serialization, persistence, and restoration of session cookies for demonicscans.org
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./dataPaths');

class SessionManager {
  /**
   * @param {string} [storagePath]
   */
  constructor(storagePath) {
    this.storagePath = storagePath || path.join(getDataDir(), 'sessions.json');
    if (fs.existsSync(this.storagePath) && process.platform !== 'win32') {
      try {
        fs.chmodSync(this.storagePath, 0o600);
      } catch (error) {
        console.warn(`Could not restrict session file permissions: ${error.message}`);
      }
    }
  }

  /**
   * Ensures data directory exists
   */
  _ensureDir() {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Loads all stored account data
   * @returns {{ accounts: Record<string, { savedAt: string, cookies: any[] }>, lastActive?: string }}
   */
  _loadData() {
    if (!fs.existsSync(this.storagePath)) {
      return { accounts: {} };
    }
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const data = JSON.parse(raw);
      // Backward compatibility if single account format was stored
      if (Array.isArray(data.cookies)) {
        return {
          accounts: {
            'Default Account': {
              savedAt: data.savedAt || new Date().toISOString(),
              cookies: data.cookies,
            },
          },
          lastActive: 'Default Account',
        };
      }
      return data.accounts ? data : { accounts: {} };
    } catch (err) {
      console.error('Failed to parse sessions.json:', err);
      return { accounts: {} };
    }
  }

  /**
   * Writes data back to disk
   */
  _saveData(data) {
    this._ensureDir();
    const tempPath = `${this.storagePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.storagePath);
    try {
      fs.chmodSync(this.storagePath, 0o600);
    } catch (error) {
      if (process.platform !== 'win32') console.warn(`Could not restrict session file permissions: ${error.message}`);
    }
  }

  /**
   * Lists all saved accounts
   * @returns {Array<{ name: string, savedAt: string, cookieCount: number }>}
   */
  listAccounts() {
    const data = this._loadData();
    return Object.entries(data.accounts || {}).map(([name, account]) => ({
      name,
      savedAt: account.savedAt,
      cookieCount: Array.isArray(account.cookies) ? account.cookies.length : 0,
    }));
  }

  getLastActiveAccount() {
    const data = this._loadData();
    return data.lastActive || Object.keys(data.accounts || {})[0] || null;
  }

  /**
   * Saves cookies for a specific account name
   * @param {import('electron').Session} session
   * @param {string} accountName
   * @param {string|object} [domainOrFilter]
   * @returns {Promise<number>}
   */
  async saveAccountSession(session, accountName, domainOrFilter = null) {
    this._ensureDir();
    try {
      const filter = typeof domainOrFilter === 'string' ? { domain: domainOrFilter } : (domainOrFilter || {});
      const now = Date.now() / 1000;
      const cookies = (await session.cookies.get(filter))
        .filter(cookie => !cookie.expirationDate || cookie.expirationDate > now);
      const data = this._loadData();
      data.accounts[accountName] = {
        savedAt: new Date().toISOString(),
        cookies,
      };
      data.lastActive = accountName;
      this._saveData(data);
      return cookies.length;
    } catch (err) {
      console.error('Failed to save account session:', err);
      throw err;
    }
  }

  /**
   * Restores stored cookies for an account into an Electron session
   * @param {import('electron').Session} session
   * @param {string} [accountName]
   * @returns {Promise<{ success: boolean, restoredCount: number, name: string }>}
   */
  async restoreAccountSession(session, accountName) {
    const data = this._loadData();
    const targetName = accountName || data.lastActive || Object.keys(data.accounts)[0];
    if (!targetName || !data.accounts[targetName]) {
      return { success: false, restoredCount: 0, name: targetName || '' };
    }

    const account = data.accounts[targetName];
    if (!Array.isArray(account.cookies) || account.cookies.length === 0) {
      return { success: false, restoredCount: 0, name: targetName };
    }

    const now = Date.now() / 1000;
    const existingCookies = await session.cookies.get({});
    const cookieKey = cookie => `${cookie.name}|${cookie.domain || ''}|${cookie.path || '/'}|${cookie.hostOnly === true ? 'host' : 'domain'}`;
    const existing = new Map(
      existingCookies
        .filter(cookie => !cookie.expirationDate || cookie.expirationDate > now)
        .map(cookie => [cookieKey(cookie), cookie])
    );

    let restoredCount = 0;
    let preservedCount = 0;
    let skippedExpired = 0;
    for (const cookie of account.cookies) {
      if (cookie.expirationDate && cookie.expirationDate <= now) {
        skippedExpired++;
        continue;
      }
      if (existing.has(cookieKey(cookie))) {
        preservedCount++;
        continue;
      }
      const protocol = cookie.secure ? 'https://' : 'http://';
      const cookieDomain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
      const url = `${protocol}${cookieDomain}${cookie.path || ''}`;

      try {
        const details = {
          url,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expirationDate,
          sameSite: cookie.sameSite,
        };
        // Passing domain converts a host-only cookie into a domain cookie.
        // Preserve the original scope so document.cookie updates replace the
        // same cookie instead of creating a competing variant.
        if (cookie.hostOnly !== true) details.domain = cookie.domain;
        await session.cookies.set(details);
        restoredCount++;
      } catch (setErr) {
        console.warn(`Could not restore cookie ${cookie.name}:`, setErr.message);
      }
    }

    data.lastActive = targetName;
    this._saveData(data);
    return {
      success: restoredCount + preservedCount > 0,
      restoredCount,
      preservedCount,
      skippedExpired,
      name: targetName,
    };
  }

  /**
   * Deletes a saved account
   * @param {string} accountName
   * @returns {boolean}
   */
  deleteAccount(accountName) {
    const data = this._loadData();
    if (data.accounts[accountName]) {
      delete data.accounts[accountName];
      if (data.lastActive === accountName) {
        data.lastActive = Object.keys(data.accounts)[0] || null;
      }
      this._saveData(data);
      return true;
    }
    return false;
  }

  /**
   * Checks if there are any saved accounts
   * @returns {boolean}
   */
  hasSavedSession() {
    const data = this._loadData();
    return Object.keys(data.accounts || {}).length > 0;
  }

  /**
   * Clears all session files
   */
  clearSession() {
    if (fs.existsSync(this.storagePath)) {
      fs.unlinkSync(this.storagePath);
    }
  }
}

module.exports = { SessionManager };
