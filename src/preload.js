const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("publisherApi", {
  getState: () => ipcRenderer.invoke("get-state"),
  selectSources: () => ipcRenderer.invoke("select-sources"),
  inspectSources: (sourcePaths) => ipcRenderer.invoke("inspect-sources", sourcePaths),
  readSource: (sourcePath) => ipcRenderer.invoke("read-source", sourcePath),
  readAsset: (articleId, assetId) => ipcRenderer.invoke("read-asset", { articleId, assetId }),
  saveQueue: (queue) => ipcRenderer.invoke("save-queue", queue),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  testConnection: () => ipcRenderer.invoke("test-connection"),
  publishArticles: (articleIds) => ipcRenderer.invoke("publish-articles", articleIds),
  retryHistory: (historyId) => ipcRenderer.invoke("retry-history", historyId),
  openSourceFolder: (sourcePath) => ipcRenderer.invoke("open-source-folder", sourcePath),
  onPublishProgress: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on("publish-progress", listener);
    return () => ipcRenderer.removeListener("publish-progress", listener);
  }
});
