/**
 * Centralized data directory resolution.
 *
 * In a packaged Electron application the writable data directory is
 * resolved from app.getPath('userData'), which on Windows maps to
 * %APPDATA%/Veybot.  During development or in test environments the
 * directory falls back to <project root>/data.
 *
 * All modules that persist user data must resolve their file paths
 * through the directory exported here so that packaged builds write
 * to a location that survives application updates and does not
 * require elevated permissions.
 */

const path = require('path');

let resolvedDataDir = null;

/**
 * Initializes the data directory.  Must be called once from the main
 * process after Electron's `app.whenReady()` resolves.
 *
 * @param {import('electron').App} electronApp
 */
function initDataDir(electronApp) {
  if (resolvedDataDir) return resolvedDataDir;
  resolvedDataDir = path.join(electronApp.getPath('userData'), 'data');
  return resolvedDataDir;
}

/**
 * Returns the resolved data directory.  Falls back to
 * `<cwd>/data` when called before initialization (tests, scripts).
 *
 * @returns {string}
 */
function getDataDir() {
  if (resolvedDataDir) return resolvedDataDir;
  return path.join(process.cwd(), 'data');
}

module.exports = { initDataDir, getDataDir };
