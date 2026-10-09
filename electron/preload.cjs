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
}));
