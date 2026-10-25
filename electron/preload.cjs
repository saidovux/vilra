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
  openOriginal(imageId) {
    return ipcRenderer.invoke('vilra:open-original', imageId);
  },
  revealImage(imageId) {
    return ipcRenderer.invoke('vilra:reveal-image', imageId);
  },
  sendGalleryArrowInput(direction, phase, repeat) {
    ipcRenderer.send(
      'vilra:gallery-arrow-input',
      direction,
      phase,
      Boolean(repeat),
    );
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
