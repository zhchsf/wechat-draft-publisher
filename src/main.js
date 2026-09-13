const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const { StateStore } = require("./store");
const { discoverHtmlFiles, readHtmlFile } = require("./file-service");
const { inspectHtmlFile, validateArticle } = require("./content-service");
const { WechatApiError, WechatClient } = require("./wechat-client");

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

function serializeError(error) {
  return {
    code: error.code || "UNKNOWN_ERROR",
    message: error.message || "操作失败",
    details: error.details || null
  };
}

function articleHistory(article, status, error = null) {
  return {
    id: `history-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    articleId: article.id,
    sourcePath: article.sourcePath,
    title: article.title,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contentHash: article.assets?.map((asset) => asset.sha256).join(":") || "",
    draftMediaId: article.draftMediaId || "",
    errorCode: error?.code || "",
    errorMessage: error?.message || ""
  };
}

async function persistState() {
  await stateStore.save(await stateStore.load());
}

async function publishArticleIds(articleIds, sender) {
  if (publishing) throw new WechatApiError("已有发布任务正在进行，请等待当前任务完成", "PUBLISHING");
  const state = await stateStore.load();
  const ids = [...new Set(articleIds || [])];
  const selectedArticles = ids.map((id) => state.queue.find((article) => article.id === id)).filter(Boolean);
  if (!selectedArticles.length) throw new WechatApiError("没有可发布的文章", "EMPTY_QUEUE");
  if (!state.settings.appid || !state.settings.appsecret) {
    throw new WechatApiError("请先在设置中填写公众号 AppID 和 AppSecret", "MISSING_CREDENTIALS");
  }

  publishing = true;
  const client = new WechatClient(state.settings);
  const results = [];
  try {
    for (let index = 0; index < selectedArticles.length; index += 1) {
      const article = selectedArticles[index];
      article.status = "publishing";
      article.lastError = null;
      article.updatedAt = new Date().toISOString();
      await persistState();
      sendProgress(sender, { articleId: article.id, index: index + 1, total: selectedArticles.length, status: "publishing", title: article.title });
      try {
        const validation = validateArticle(article);
        if (!validation.valid) {
          throw new WechatApiError(
            `文章校验未通过：${validation.unresolvedIssues.map((item) => item.message).join("；") || "缺少封面或标题"}`,
            "VALIDATION_ERROR",
            { issues: validation.unresolvedIssues }
          );
        }
        const result = await client.createDraft(article);
        article.status = "success";
        article.draftMediaId = result.mediaId;
        article.lastError = null;
        state.history.unshift(articleHistory(article, "success"));
        results.push({ articleId: article.id, status: "success", mediaId: result.mediaId });
        sendProgress(sender, { articleId: article.id, index: index + 1, total: selectedArticles.length, status: "success", title: article.title, mediaId: result.mediaId });
      } catch (error) {
        const normalizedError = serializeError(error);
        article.status = "failed";
        article.lastError = normalizedError;
        state.history.unshift(articleHistory(article, "failed", normalizedError));
        results.push({ articleId: article.id, status: "failed", error: normalizedError });
        sendProgress(sender, { articleId: article.id, index: index + 1, total: selectedArticles.length, status: "failed", title: article.title, error: normalizedError });
      }
      article.updatedAt = new Date().toISOString();
      await persistState();
    }
  } finally {
    publishing = false;
  }
  return { results, state };
}

function registerIpc() {
  ipcMain.handle("get-state", async () => stateStore.load());

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

  ipcMain.handle("read-source", async (_, sourcePath) => readHtmlFile(sourcePath));

  ipcMain.handle("read-asset", async (_, { articleId, assetId }) => {
    const state = await stateStore.load();
    const article = state.queue.find((item) => item.id === articleId);
    const asset = article?.assets?.find((item) => item.id === assetId);
    if (!asset) throw new WechatApiError("找不到文章图片资源", "ASSET_NOT_FOUND");
    const file = require("fs").promises;
    const content = await file.readFile(asset.path);
    return `data:${asset.mimeType};base64,${content.toString("base64")}`;
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

  ipcMain.handle("publish-articles", async (event, articleIds) => publishArticleIds(articleIds, event.sender));

  ipcMain.handle("retry-history", async (event, historyId) => {
    const state = await stateStore.load();
    const history = state.history.find((item) => item.id === historyId);
    if (!history) throw new WechatApiError("找不到发布历史", "HISTORY_NOT_FOUND");
    const article = state.queue.find((item) => item.id === history.articleId);
    if (!article) throw new WechatApiError("原文章不在当前队列中，请重新导入源文件", "ARTICLE_NOT_FOUND");
    article.status = "queued";
    article.lastError = null;
    await stateStore.save(state);
    return publishArticleIds([article.id], event.sender);
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
