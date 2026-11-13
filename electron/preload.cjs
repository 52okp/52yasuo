/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Sandboxed Electron preload uses CommonJS */
const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopFiles', {
  getPath(file) {
    return webUtils.getPathForFile(file);
  }
});
