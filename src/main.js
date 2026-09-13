const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const { StateStore } = require("./store");
const { discoverHtmlFiles } = require("./file-service");
const { inspectHtmlFile } = require("./content-service");
const { WechatApiError, WechatClient } = require("./wechat-client");
const { publishArticleIds, serializeError } = require("./publish-service");

let mainWindow;
let stateStore;
let publishing = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#f4f6fb",
    title: "微信公众号草稿发布器",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function sendProgress(sender, payload) {
  if (sender && !sender.isDestroyed()) sender.send("publish-progress", payload);
}

async function runPublishArticleIds(articleIds, sender) {
  if (publishing) throw new WechatApiError("已有发布任务正在进行，请等待当前任务完成", "PUBLISHING");
  publishing = true;
  try {
    return await publishArticleIds({ stateStore, articleIds, sender });
  } finally {
    publishing = false;
  }
}

async function readAssetData(article, asset) {
  const fileSystem = require("fs").promises;
  const sourceDirectory = path.dirname(await fileSystem.realpath(article.sourcePath));
  const assetPath = await fileSystem.realpath(asset.path);
  const relativePath = path.relative(sourceDirectory, assetPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new WechatApiError("文章图片不在源文件目录内", "ASSET_OUTSIDE_ROOT");
  }
  const content = await fileSystem.readFile(assetPath);
  return `data:${asset.mimeType};base64,${content.toString("base64")}`;
}

function registerIpc() {
  ipcMain.handle("get-state", async () => {
    const state = await stateStore.load();
    return { ...state, loadWarning: stateStore.getLoadWarning() };
  });

  ipcMain.handle("select-sources", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 HTML 文件或文章目录",
      properties: ["openFile", "openDirectory", "multiSelections"],
      filters: [{ name: "HTML 文件", extensions: ["html", "htm"] }]
    });
    if (result.canceled) return [];
    return discoverHtmlFiles(result.filePaths);
  });

  ipcMain.handle("inspect-sources", async (_, sourcePaths) => {
    const articles = [];
    for (const sourcePath of sourcePaths || []) {
      articles.push(await inspectHtmlFile(sourcePath));
    }
    return articles;
  });

  ipcMain.handle("read-asset", async (_, { articleId, assetId }) => {
    const state = await stateStore.load();
    const article = state.queue.find((item) => item.id === articleId);
    const asset = article?.assets?.find((item) => item.id === assetId);
    if (!asset) throw new WechatApiError("找不到文章图片资源", "ASSET_NOT_FOUND");
    try {
      return await readAssetData(article, asset);
    } catch (error) {
      if (error instanceof WechatApiError) throw error;
      throw new WechatApiError(`图片文件无法读取：${asset.path}`, "FILE_ERROR", { cause: error.code || error.message });
    }
  });

  ipcMain.handle("save-queue", async (_, queue) => {
    const state = await stateStore.load();
    state.queue = Array.isArray(queue) ? queue : [];
    await stateStore.save(state);
    return state;
  });

  ipcMain.handle("save-settings", async (_, settings) => {
    const state = await stateStore.load();
    state.settings = {
      appid: String(settings?.appid || "").trim(),
      appsecret: String(settings?.appsecret || "").trim()
    };
    await stateStore.save(state);
    return state.settings;
  });

  ipcMain.handle("test-connection", async () => {
    const state = await stateStore.load();
    try {
      const client = new WechatClient(state.settings);
      await client.getAccessToken();
      return { ok: true, message: "微信接口连接成功，IP 白名单和凭据有效" };
    } catch (error) {
      return { ok: false, ...serializeError(error) };
    }
  });

  ipcMain.handle("publish-articles", async (event, articleIds) => runPublishArticleIds(articleIds, event.sender));

  ipcMain.handle("retry-history", async (event, historyId) => {
    const state = await stateStore.load();
    const history = state.history.find((item) => item.id === historyId);
    if (!history) throw new WechatApiError("找不到发布历史", "HISTORY_NOT_FOUND");
    if (history.status !== "failed") throw new WechatApiError("只有失败记录可以重试", "HISTORY_NOT_RETRYABLE");
    const article = state.queue.find((item) => item.id === history.articleId);
    if (!article) throw new WechatApiError("原文章不在当前队列中，请重新导入源文件", "ARTICLE_NOT_FOUND");
    if (article.status === "success") throw new WechatApiError("文章已经创建过草稿，无需重试", "ALREADY_PUBLISHED");
    article.status = "queued";
    article.lastError = null;
    await stateStore.save(state);
    return runPublishArticleIds([article.id], event.sender);
  });

  ipcMain.handle("open-source-folder", async (_, sourcePath) => {
    await shell.showItemInFolder(sourcePath);
    return true;
  });
}

app.whenReady().then(async () => {
  stateStore = new StateStore(app.getPath("userData"));
  await stateStore.load();
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
