const fs = require('fs');
const path = require('path');

const EventEmitter = require('events');
const { getDataDir } = require('./dataPaths');

class Logger extends EventEmitter {
  constructor() {
    super();
    this.logsDir = path.join(getDataDir(), 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
    this.maxLogBytes = 2 * 1024 * 1024;
    this.pendingWrites = new Set();
  }

  getServerTimeString() {
    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    // UTC+5:30
    const serverDate = new Date(utcTime + (330 * 60000));
    return serverDate.toISOString().replace('T', ' ').substring(0, 19) + ' (UTC+5:30)';
  }

  logUser(accountName, action) {
    if (!accountName) return;
    const safeName = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(this.logsDir, `${safeName}_user.log`);
    const safeAction = this._redact(action);
    const line = `[${this.getServerTimeString()}] [USER] ${safeAction}\n`;
    this._append(filePath, line);
    this.emit('log', { type: 'user', accountName, action: safeAction, line: line.trim() });
  }

  logClient(accountName, action) {
    if (!accountName) return;
    const safeName = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(this.logsDir, `${safeName}_client.log`);
    const safeAction = this._redact(action);
    const line = `[${this.getServerTimeString()}] [CLIENT] ${safeAction}\n`;
    this._append(filePath, line);
    this.emit('log', { type: 'client', accountName, action: safeAction, line: line.trim() });
  }

  logApi(accountName, method, endpoint, status, resultText = '') {
    if (!accountName) return;
    const extra = resultText ? ` - ${resultText}` : '';
    const statusText = status ? `[Status: ${status}]` : '';
    const action = `[API] ${method.toUpperCase()} ${endpoint} ${statusText}${extra}`;
    this.logClient(accountName, action);
  }

  logAuto(accountName, action) {
    // Write to client.log as unified client/auto log
    this.logClient(accountName, action);
  }

  getUserLogs(accountName) {
    try {
      if (!accountName) {
        // Read all user log files combined
        const files = fs.readdirSync(this.logsDir).filter(f => f.endsWith('_user.log'));
        let combined = '';
        files.forEach(f => {
          combined += `=== ${f} ===\n` + fs.readFileSync(path.join(this.logsDir, f), 'utf-8') + '\n';
        });
        return combined || 'No user logs recorded yet.';
      }
      const safeName = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(this.logsDir, `${safeName}_user.log`);
      if (!fs.existsSync(filePath)) return 'No user logs recorded yet.';
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return `Error reading user logs: ${err.message}`;
    }
  }

  getClientLogs(accountName) {
    try {
      if (!accountName) {
        // Read all client and legacy auto log files combined
        const files = fs.readdirSync(this.logsDir).filter(f => f.endsWith('_client.log') || f.endsWith('_auto.log'));
        let combined = '';
        files.forEach(f => {
          combined += `=== ${f} ===\n` + fs.readFileSync(path.join(this.logsDir, f), 'utf-8') + '\n';
        });
        return combined || 'No client logs recorded yet.';
      }
      const safeName = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const clientFilePath = path.join(this.logsDir, `${safeName}_client.log`);
      const autoFilePath = path.join(this.logsDir, `${safeName}_auto.log`);
      
      let logs = '';
      if (fs.existsSync(clientFilePath)) {
        logs += fs.readFileSync(clientFilePath, 'utf-8');
      }
      if (fs.existsSync(autoFilePath)) {
        logs += (logs ? '\n--- Legacy Logs ---\n' : '') + fs.readFileSync(autoFilePath, 'utf-8');
      }
      return logs || 'No client logs recorded yet.';
    } catch (err) {
      return `Error reading client logs: ${err.message}`;
    }
  }

  getAutoLogs(accountName) {
    return this.getClientLogs(accountName);
  }

  async whenIdle() {
    while (this.pendingWrites.size > 0) {
      await Promise.all([...this.pendingWrites]);
    }
  }

  async deleteAccountLogs(accountName) {
    if (!accountName) return 0;
    await this.whenIdle();
    const safeName = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
    let removed = 0;
    for (const suffix of ['user.log', 'user.log.1', 'client.log', 'client.log.1', 'auto.log', 'auto.log.1']) {
      const filePath = path.join(this.logsDir, `${safeName}_${suffix}`);
      if (!fs.existsSync(filePath)) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    }
    return removed;
  }

  _redact(value) {
    return String(value ?? '')
      .replace(/((?:cookie|authorization|csrf(?:_token)?|request_token|useruid)\s*[:=]\s*)[^\s,;&]+/gi, '$1[REDACTED]');
  }

  _append(filePath, line) {
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size >= this.maxLogBytes) {
        const rotatedPath = `${filePath}.1`;
        if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
        fs.renameSync(filePath, rotatedPath);
      }
      const pending = new Promise(resolve => {
        fs.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 }, err => {
          if (err) console.error('Failed to write log:', err);
          resolve();
        });
      });
      this.pendingWrites.add(pending);
      pending.finally(() => this.pendingWrites.delete(pending));
    } catch (error) {
      console.error('Failed to rotate log:', error);
    }
  }
  /**
   * Reinitialize the logs directory after app.getPath becomes available.
   * @param {string} [dataDir]
   */
  init(dataDir) {
    this.logsDir = path.join(dataDir || getDataDir(), 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }
}

module.exports = { Logger: new Logger() };
