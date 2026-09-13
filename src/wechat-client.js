const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");

const { replaceAssetTokens, validateArticle } = require("./content-service");

const API_ROOT = "https://api.weixin.qq.com";
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001]);
const TRANSIENT_ERROR_CODES = new Set([-1]);

class WechatApiError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WechatApiError";
    this.code = code;
    this.details = details;
  }
}

function responseError(payload, fallbackMessage) {
  if (payload && Number(payload.errcode)) {
    return new WechatApiError(payload.errmsg || fallbackMessage, Number(payload.errcode), payload);
  }
  return null;
}

function requestError(error, fallbackMessage) {
  const apiError = responseError(error?.response?.data, fallbackMessage);
  if (apiError) return apiError;
  return new WechatApiError(`${fallbackMessage}：${error.message}`, "NETWORK_ERROR", { cause: error.code || error.message });
}

class WechatClient {
  constructor(settings, options = {}) {
    this.appid = String(settings?.appid || "").trim();
    this.appsecret = String(settings?.appsecret || "").trim();
    this.http = options.http || axios.create({ baseURL: API_ROOT, timeout: 20000 });
    this.token = null;
  }

  ensureCredentials() {
    if (!this.appid || !this.appsecret) {
      throw new WechatApiError("请先在设置中填写 AppID 和 AppSecret", "MISSING_CREDENTIALS");
    }
  }

  clearToken() {
    this.token = null;
  }

  async ensureReadableFile(filePath, label) {
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch (error) {
      throw new WechatApiError(`${label}文件无法读取：${filePath}`, "FILE_ERROR", { cause: error.code || error.message });
    }
  }

  async getAccessToken() {
    this.ensureCredentials();
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    let response;
    try {
      response = await this.http.get("/cgi-bin/token", {
        params: { grant_type: "client_credential", appid: this.appid, secret: this.appsecret }
      });
    } catch (error) {
      throw requestError(error, "微信接口连接失败");
    }
    const apiError = responseError(response.data, "获取微信接口令牌失败");
    if (apiError) throw apiError;
    if (!response.data?.access_token) throw new WechatApiError("微信接口未返回 access_token", "INVALID_RESPONSE", response.data);
    const expiresIn = Number(response.data.expires_in);
    const validSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200;
    this.token = {
      value: response.data.access_token,
      expiresAt: Date.now() + Math.max(60, validSeconds - 300) * 1000
    };
    return this.token.value;
  }

  async testConnection() {
    await this.executeWithTokenRetry(async () => true);
    return true;
  }

  async executeWithTokenRetry(operation) {
    let tokenRetryAvailable = true;
    let networkRetryAvailable = true;
    while (true) {
      try {
        const token = await this.getAccessToken();
        return await operation(token);
      } catch (error) {
        if (tokenRetryAvailable && TOKEN_ERROR_CODES.has(Number(error.code))) {
          tokenRetryAvailable = false;
          this.clearToken();
          continue;
        }
        if (networkRetryAvailable && (error.code === "NETWORK_ERROR" || TRANSIENT_ERROR_CODES.has(Number(error.code)))) {
          networkRetryAvailable = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw error;
      }
    }
  }

  async uploadPermanentImage(filePath, token) {
    await this.ensureReadableFile(filePath, "封面");
    const form = new FormData();
    form.append("media", fs.createReadStream(filePath));
    let response;
    try {
      response = await this.http.post("/cgi-bin/material/add_material", form, {
        params: { access_token: token, type: "image" },
        headers: form.getHeaders()
      });
    } catch (error) {
      throw requestError(error, "封面上传失败");
    }
    const apiError = responseError(response.data, "封面上传失败");
    if (apiError) throw apiError;
    if (!response.data?.media_id) throw new WechatApiError("微信接口未返回封面 media_id", "INVALID_RESPONSE", response.data);
    return response.data.media_id;
  }

  async uploadInlineImage(filePath, token) {
    await this.ensureReadableFile(filePath, "正文图片");
    const form = new FormData();
    form.append("media", fs.createReadStream(filePath));
    let response;
    try {
      response = await this.http.post("/cgi-bin/media/uploadimg", form, {
        params: { access_token: token },
        headers: form.getHeaders()
      });
    } catch (error) {
      throw requestError(error, "正文图片上传失败");
    }
    const apiError = responseError(response.data, "正文图片上传失败");
    if (apiError) throw apiError;
    if (!response.data?.url) throw new WechatApiError("微信接口未返回正文图片 URL", "INVALID_RESPONSE", response.data);
    return response.data.url;
  }

  async createDraft(article) {
    const validation = validateArticle(article);
    if (!validation.valid) {
      throw new WechatApiError(
        `文章校验未通过：${validation.unresolvedIssues.map((item) => item.message).join("；") || "缺少封面或标题"}`,
        "VALIDATION_ERROR",
        { issues: validation.unresolvedIssues }
      );
    }
    return this.executeWithTokenRetry(async (token) => {
      const replacements = {};
      const uniqueAssets = new Map();
      for (const asset of article.assets || []) uniqueAssets.set(asset.id, asset);
      for (const asset of uniqueAssets.values()) {
        if (article.contentHtml.includes(`asset://${asset.id}`)) {
          replacements[asset.id] = await this.uploadInlineImage(asset.path, token);
        }
      }
      const coverAsset = (article.assets || []).find((asset) => asset.id === article.coverAssetId);
      const thumbMediaId = await this.uploadPermanentImage(coverAsset.path, token);
      const payload = {
        articles: [{
          title: String(article.title || "").trim(),
          author: String(article.author || "").trim(),
          digest: String(article.digest || "").trim(),
          content: replaceAssetTokens(article.contentHtml, replacements),
          content_source_url: String(article.sourceUrl || "").trim(),
          thumb_media_id: thumbMediaId,
          need_open_comment: article.needOpenComment ? 1 : 0,
          only_fans_can_comment: article.onlyFansCanComment ? 1 : 0
        }]
      };
      let response;
      try {
        response = await this.http.post("/cgi-bin/draft/add", payload, {
          params: { access_token: token },
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        throw requestError(error, "创建草稿失败");
      }
      const apiError = responseError(response.data, "创建草稿失败");
      if (apiError) throw apiError;
      if (!response.data?.media_id) throw new WechatApiError("微信接口未返回草稿 media_id", "INVALID_RESPONSE", response.data);
      return { mediaId: response.data.media_id };
    });
  }
}

module.exports = {
  API_ROOT,
  TOKEN_ERROR_CODES,
  TRANSIENT_ERROR_CODES,
  WechatApiError,
  WechatClient,
  responseError,
  requestError
};
