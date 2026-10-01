/**
 * Encrypted credential persistence for the optional login-form autocomplete.
 * Plaintext credentials exist only in memory while encrypting/decrypting and
 * are never written to disk or logged.
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./dataPaths');

class CredentialManager {
  constructor(safeStorage, storagePath) {
    this.safeStorage = safeStorage;
    this.storagePath = storagePath || path.join(getDataDir(), 'credentials.json');
    this._restrictExistingFile();
  }

  isAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) return false;
    let backend = null;
    try {
      backend = this.safeStorage.getSelectedStorageBackend?.();
    } catch {
      backend = null;
    }
    return backend !== 'basic_text';
  }

  _restrictExistingFile() {
    if (!fs.existsSync(this.storagePath) || process.platform === 'win32') return;
    try {
      fs.chmodSync(this.storagePath, 0o600);
    } catch {
      // Encryption remains the primary protection; permission errors are
      // handled without exposing file contents.
    }
  }

  _loadData() {
    if (!fs.existsSync(this.storagePath)) return { accounts: {}, lastAccount: null };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.accounts
        ? parsed
        : { accounts: {}, lastAccount: null };
    } catch {
      return { accounts: {}, lastAccount: null };
    }
  }

  _saveData(data) {
    const directory = path.dirname(this.storagePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${this.storagePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.storagePath);
    this._restrictExistingFile();
  }

  save(accountName, email, password) {
    const name = String(accountName || '').trim();
    const normalizedEmail = String(email || '').trim();
    const normalizedPassword = String(password || '');
    if (!name || !normalizedEmail || !normalizedPassword || !this.isAvailable()) return false;

    const encrypted = this.safeStorage.encryptString(JSON.stringify({
      email: normalizedEmail,
      password: normalizedPassword,
    }));
    const data = this._loadData();
    data.accounts[name] = {
      encrypted: Buffer.from(encrypted).toString('base64'),
      savedAt: new Date().toISOString(),
    };
    data.lastAccount = name;
    this._saveData(data);
    return true;
  }

  get(accountName = null) {
    if (!this.isAvailable()) return null;
    const data = this._loadData();
    const name = accountName || data.lastAccount;
    const record = name ? data.accounts?.[name] : null;
    if (!record?.encrypted) return null;
    try {
      const plaintext = this.safeStorage.decryptString(Buffer.from(record.encrypted, 'base64'));
      const credentials = JSON.parse(plaintext);
      if (typeof credentials.email !== 'string' || typeof credentials.password !== 'string') return null;
      return { accountName: name, email: credentials.email, password: credentials.password };
    } catch {
      return null;
    }
  }

  delete(accountName) {
    const data = this._loadData();
    if (!data.accounts?.[accountName]) return false;
    delete data.accounts[accountName];
    if (data.lastAccount === accountName) {
      data.lastAccount = Object.keys(data.accounts)[0] || null;
    }
    this._saveData(data);
    return true;
  }
}

module.exports = { CredentialManager };
