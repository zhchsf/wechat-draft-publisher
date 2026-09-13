const crypto = require("crypto");

const { validateArticle } = require("./content-service");
const { WechatApiError, WechatClient } = require("./wechat-client");

function serializeError(error) {
  return {
    code: error.code || "UNKNOWN_ERROR",
    message: error.message || "操作失败",
    details: error.details || null
  };
}

function articleHistory(article, status, error = null) {
  const assetsById = new Map((article.assets || []).map((asset) => [asset.id, asset]));
  const content = String(article.contentHtml || "").replace(/asset:\/\/([a-zA-Z0-9-]+)/g, (_, assetId) => {
    const asset = assetsById.get(assetId);
    return `asset:${asset?.sha256 || assetId}`;
  });
  const contentHash = crypto.createHash("sha256").update(JSON.stringify({
    title: article.title || "",
    author: article.author || "",
    digest: article.digest || "",
    sourceUrl: article.sourceUrl || "",
    content,
    cover: assetsById.get(article.coverAssetId)?.sha256 || article.coverAssetId || "",
    needOpenComment: Boolean(article.needOpenComment),
    onlyFansCanComment: Boolean(article.onlyFansCanComment),
    assets: (article.assets || []).map((asset) => asset.sha256 || asset.path || "")
  })).digest("hex");
  return {
    id: `history-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    articleId: article.id,
    sourcePath: article.sourcePath,
    title: article.title,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contentHash,
    draftMediaId: article.draftMediaId || "",
    errorCode: error?.code || "",
    errorMessage: error?.message || ""
  };
}

function sendProgress(sender, payload) {
  if (sender && typeof sender.isDestroyed === "function" && !sender.isDestroyed()) sender.send("publish-progress", payload);
}

async function publishArticleIds({ stateStore, articleIds, sender, clientFactory = (settings) => new WechatClient(settings) }) {
  const state = await stateStore.load();
  const ids = [...new Set(articleIds || [])];
  const selectedArticles = ids.map((id) => state.queue.find((article) => article.id === id))
    .filter((article) => article && article.status !== "success" && article.status !== "publishing");
  if (!selectedArticles.length) throw new WechatApiError("没有可发布的文章", "EMPTY_QUEUE");
  if (!state.settings.appid || !state.settings.appsecret) {
    throw new WechatApiError("请先在设置中填写公众号 AppID 和 AppSecret", "MISSING_CREDENTIALS");
  }

  const client = clientFactory(state.settings);
  const results = [];
  const persist = () => stateStore.save(state);
  for (let index = 0; index < selectedArticles.length; index += 1) {
    const article = selectedArticles[index];
    article.status = "publishing";
    article.lastError = null;
    article.updatedAt = new Date().toISOString();
    await persist();
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
    await persist();
  }
  return { results, state };
}

module.exports = {
  articleHistory,
  publishArticleIds,
  serializeError
};
