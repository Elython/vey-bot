/**
 * Centralized path resolver for writable data files.
 *
 * In development (`electron .`), data lives alongside the project root.
 * In a packaged app, `__dirname` and `process.cwd()` are unreliable
 * (ASAR archive / System32), so we use Electron's `app.getPath('userData')`
 * which resolves to a writable, per-user directory such as:
 *   Windows:  %APPDATA%\Veybot\
 *   Linux:    ~/.config/Veybot/
 *   macOS:    ~/Library/Application Support/Veybot/
 */

const path = require('path');
const { app } = require('electron');

/**
 * Returns the root directory for all writable data files.
 * Safe to call at module-load time (before `app.whenReady()`).
 */
function getDataDir() {
  // In a packaged app, app.isPackaged is true.
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  // During development, keep using the local `data/` folder at the project root.
  return path.join(process.cwd(), 'data');
}

module.exports = { getDataDir };
