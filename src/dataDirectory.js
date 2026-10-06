const fs = require('fs');
const path = require('path');

let configuredDataDirectory = null;
const LEGACY_DATA_ENTRIES = Object.freeze([
  'logs',
  'backups',
  'sessions.json',
  'credentials.json',
  'bot_config.json',
  'account_database.json',
  'activity_history.json',
  'damage_observations.json',
  'xp_observations.json',
  'loot_discovery.json',
  'monster_stats_cache.json',
  'manga_list.json',
  'account_manga.json',
  'manga.log',
]);

function normalizeDirectory(directory) {
  const value = String(directory || '').trim();
  return value ? path.resolve(value) : null;
}

function configureDataDirectory(directory) {
  const resolved = normalizeDirectory(directory);
  if (!resolved) throw new Error('A Veybot data directory is required');
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  configuredDataDirectory = resolved;
  return resolved;
}

function getDataDirectory() {
  return configuredDataDirectory || path.join(process.cwd(), 'data');
}

function getDataPath(...segments) {
  return path.join(getDataDirectory(), ...segments);
}

function copyMissingTree(source, destination) {
  let copied = 0;
  if (!fs.existsSync(source)) return copied;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return copied;
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) {
      copied += copyMissingTree(path.join(source, name), path.join(destination, name));
    }
    return copied;
  }
  if (!stat.isFile() || fs.existsSync(destination)) return copied;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(destination, 0o600);
    } catch {
      // Copying the data is more important than an unsupported chmod.
    }
  }
  return 1;
}

function migrateLegacyDataDirectories(sources, destination) {
  const target = normalizeDirectory(destination);
  if (!target) throw new Error('A Veybot migration destination is required');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  let copied = 0;
  const visited = new Set([target]);
  for (const source of sources || []) {
    const candidate = normalizeDirectory(source);
    if (!candidate || visited.has(candidate) || !fs.existsSync(candidate)) continue;
    visited.add(candidate);
    for (const entry of LEGACY_DATA_ENTRIES) {
      try {
        copied += copyMissingTree(path.join(candidate, entry), path.join(target, entry));
      } catch (error) {
        // An unreadable legacy file must not prevent a clean packaged startup.
        console.warn(`Could not migrate legacy Veybot data entry ${entry}: ${error.message}`);
      }
    }
  }
  return copied;
}

function initializeAppDataDirectory(electronApp) {
  if (!electronApp?.isPackaged) {
    return { directory: configureDataDirectory(path.join(process.cwd(), 'data')), copied: 0 };
  }

  const directory = configureDataDirectory(path.join(electronApp.getPath('userData'), 'data'));
  const executableDirectory = path.dirname(electronApp.getPath('exe'));
  const appPath = electronApp.getAppPath();
  const sources = [
    path.join(executableDirectory, 'data'),
    path.resolve(appPath, '..', '..', 'data'),
    path.join(process.cwd(), 'data'),
  ];
  const copied = migrateLegacyDataDirectories(sources, directory);
  return { directory, copied };
}

module.exports = {
  configureDataDirectory,
  getDataDirectory,
  getDataPath,
  initializeAppDataDirectory,
  migrateLegacyDataDirectories,
};
