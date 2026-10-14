const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('vilraDesktop', Object.freeze({
  runtime: 'electron',
  pickFolder(defaultPath) {
    return ipcRenderer.invoke(
      'vilra:pick-folder',
      typeof defaultPath === 'string' ? defaultPath : '',
    );
  },
  revealPath(targetPath) {
    return ipcRenderer.invoke('vilra:reveal-path', targetPath);
  },
  diagnosticsBegin() {
    return ipcRenderer.invoke('vilra:diagnostics:begin');
  },
  diagnosticsCheckpoint(sessionId, reportJson) {
    return ipcRenderer.invoke('vilra:diagnostics:checkpoint', sessionId, reportJson);
  },
  diagnosticsFinalize(sessionId, reportJson) {
    return ipcRenderer.invoke('vilra:diagnostics:finalize', sessionId, reportJson);
  },
  diagnosticsStatus() {
    return ipcRenderer.invoke('vilra:diagnostics:status');
  },
}));
