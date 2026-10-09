const os = require('node:os');
const path = require('node:path');

const APP_IDENTIFIER = 'app.tagimage.desktop';
const DATABASE_FILENAME = 'tagimage.sqlite';

function tauriDataRoot({platform = process.platform, env = process.env, home = os.homedir()} = {}) {
  if (platform === 'win32') {
    return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return env.XDG_DATA_HOME || path.join(home, '.local', 'share');
}

function resolveTauriAppData(options = {}) {
  return path.join(tauriDataRoot(options), APP_IDENTIFIER);
}

function resolveSqlitePath(options = {}) {
  const env = options.env || process.env;
  const appData = resolveTauriAppData(options);
  const configured = String(env.TAGIMAGE_SQLITE_PATH || '').trim();
  if (!configured) return path.join(appData, DATABASE_FILENAME);
  return path.isAbsolute(configured) ? configured : path.join(appData, configured);
}

module.exports = {
  APP_IDENTIFIER,
  DATABASE_FILENAME,
  resolveSqlitePath,
  resolveTauriAppData,
  tauriDataRoot,
};
