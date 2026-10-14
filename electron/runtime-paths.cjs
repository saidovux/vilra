const os = require('node:os');
const path = require('node:path');

const APP_IDENTIFIER = 'app.tagimage.desktop';
const DATABASE_FILENAME = 'tagimage.sqlite';
const DIAGNOSTICS_DIRECTORY = 'diagnostics';

function vilraDataRoot({platform = process.platform, env = process.env, home = os.homedir()} = {}) {
  if (platform === 'win32') {
    return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return env.XDG_DATA_HOME || path.join(home, '.local', 'share');
}

function resolveVilraAppData(options = {}) {
  return path.join(vilraDataRoot(options), APP_IDENTIFIER);
}

function resolveSqlitePath(options = {}) {
  const env = options.env || process.env;
  const appData = resolveVilraAppData(options);
  const configured = String(env.TAGIMAGE_SQLITE_PATH || '').trim();
  if (!configured) return path.join(appData, DATABASE_FILENAME);
  return path.isAbsolute(configured) ? configured : path.join(appData, configured);
}

function resolveDiagnosticsPath(options = {}) {
  return path.join(resolveVilraAppData(options), DIAGNOSTICS_DIRECTORY);
}

module.exports = {
  APP_IDENTIFIER,
  DATABASE_FILENAME,
  DIAGNOSTICS_DIRECTORY,
  resolveDiagnosticsPath,
  resolveSqlitePath,
  resolveVilraAppData,
  vilraDataRoot,
};
