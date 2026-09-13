const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { inspectHtmlFile } = require("../src/content-service");
const { WechatClient } = require("../src/wechat-client");
const testRoot = path.join(__dirname, "..", ".test-tmp");

describe("wechat client", () => {
  it("uploads inline assets and creates one draft", async () => {
    fs.mkdirSync(testRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(testRoot, "api-"));
    const imagePath = path.join(directory, "image.png");
    const articlePath = path.join(directory, "article.html");
    fs.writeFileSync(imagePath, Buffer.from("image"));
    fs.writeFileSync(articlePath, `<html><head><title>接口测试</title></head><body><p>测试<img src="image.png"></p></body></html>`);
    const article = await inspectHtmlFile(articlePath);
    const requests = [];
    const http = {
      async get(url) {
        requests.push(["get", url]);
        return { data: { access_token: "access-token", expires_in: 7200 } };
      },
      async post(url, body, options) {
        requests.push(["post", url, options?.params]);
        if (url.includes("material/add_material")) return { data: { media_id: "thumb-media-id" } };
        if (url.includes("media/uploadimg")) return { data: { url: "https://mmbiz.qpic.cn/inline.png" } };
        return { data: { media_id: "draft-media-id" } };
      }
    };
    const client = new WechatClient({ appid: "wx-test", appsecret: "secret" }, { http });
    const result = await client.createDraft(article);
    assert.equal(result.mediaId, "draft-media-id");
    assert.deepEqual(requests.map((request) => request[1]), [
      "/cgi-bin/token",
      "/cgi-bin/media/uploadimg",
      "/cgi-bin/material/add_material",
      "/cgi-bin/draft/add"
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("refreshes an expired token once", async () => {
    let tokenCalls = 0;
    let draftCalls = 0;
    const http = {
      async get() {
        tokenCalls += 1;
        return { data: { access_token: `token-${tokenCalls}`, expires_in: 7200 } };
      },
      async post(url) {
        if (url.includes("draft/add")) {
          draftCalls += 1;
          if (draftCalls === 1) return { data: { errcode: 40001, errmsg: "invalid credential" } };
          return { data: { media_id: "draft-after-refresh" } };
        }
        if (url.includes("material/add_material")) return { data: { media_id: "thumb-media-id" } };
        return { data: { url: "https://mmbiz.qpic.cn/inline.png" } };
      }
    };
    const article = {
      title: "令牌刷新",
      author: "",
      digest: "",
      sourceUrl: "",
      contentHtml: "<p>正文</p>",
      coverAssetId: "asset-cover",
      assets: [{ id: "asset-cover", path: __filename, mimeType: "image/png", sha256: "hash" }],
      issues: [],
      ignoredIssueIds: []
    };
    const client = new WechatClient({ appid: "wx-test", appsecret: "secret" }, { http });
    const result = await client.createDraft(article);
    assert.equal(result.mediaId, "draft-after-refresh");
    assert.equal(tokenCalls, 2);
    assert.equal(draftCalls, 2);
  });

  it("retries a transient network failure once", async () => {
    let coverCalls = 0;
    const http = {
      async get() {
        return { data: { access_token: "token", expires_in: 7200 } };
      },
      async post(url) {
        if (url.includes("material/add_material")) {
          coverCalls += 1;
          if (coverCalls === 1) {
            const error = new Error("timeout");
            error.code = "ETIMEDOUT";
            throw error;
          }
          return { data: { media_id: "thumb-media-id" } };
        }
        return { data: { media_id: "draft-media-id" } };
      }
    };
    const article = {
      title: "网络重试",
      contentHtml: "<p>正文</p>",
      coverAssetId: "cover",
      assets: [{ id: "cover", path: __filename, mimeType: "image/png", sha256: "hash" }],
      issues: [],
      ignoredIssueIds: []
    };
    const client = new WechatClient({ appid: "wx-test", appsecret: "secret" }, { http });
    const result = await client.createDraft(article);
    assert.equal(result.mediaId, "draft-media-id");
    assert.equal(coverCalls, 2);
  });

  it("preserves business errors returned through an HTTP rejection", async () => {
    const http = {
      async get() {
        return { data: { access_token: "token", expires_in: 7200 } };
      },
      async post(url) {
        if (url.includes("material/add_material")) return { data: { media_id: "thumb-media-id" } };
        const error = new Error("request failed");
        error.response = { data: { errcode: 40013, errmsg: "invalid appid" } };
        throw error;
      }
    };
    const article = {
      title: "业务错误",
      contentHtml: "<p>正文</p>",
      coverAssetId: "cover",
      assets: [{ id: "cover", path: __filename, mimeType: "image/png", sha256: "hash" }],
      issues: [],
      ignoredIssueIds: []
    };
    const client = new WechatClient({ appid: "wx-test", appsecret: "secret" }, { http });
    await assert.rejects(() => client.createDraft(article), (error) => error.code === 40013 && error.message === "invalid appid");
  });

  it("retries the temporary WeChat busy error once", async () => {
    let draftCalls = 0;
    const http = {
      async get() {
        return { data: { access_token: "token", expires_in: 7200 } };
      },
      async post(url) {
        if (url.includes("material/add_material")) return { data: { media_id: "thumb-media-id" } };
        if (url.includes("draft/add")) {
          draftCalls += 1;
          if (draftCalls === 1) return { data: { errcode: -1, errmsg: "system busy" } };
          return { data: { media_id: "draft-media-id" } };
        }
        return { data: { url: "https://mmbiz.qpic.cn/inline.png" } };
      }
    };
    const article = {
      title: "临时错误",
      contentHtml: "<p>正文</p>",
      coverAssetId: "cover",
      assets: [{ id: "cover", path: __filename, mimeType: "image/png", sha256: "hash" }],
      issues: [],
      ignoredIssueIds: []
    };
    const client = new WechatClient({ appid: "wx-test", appsecret: "secret" }, { http });
    const result = await client.createDraft(article);
    assert.equal(result.mediaId, "draft-media-id");
    assert.equal(draftCalls, 2);
  });

  it("uses a fallback token lifetime when expires_in is invalid", async () => {
    let tokenCalls = 0;
    const http = {
      async get() {
        tokenCalls += 1;
        return { data: { access_token: "token", expires_in: "invalid" } };
      }
    };
    const client = new WechatClient({ appid: "wx-test", appsecret: "secret" }, { http });
    await client.getAccessToken();
    await client.getAccessToken();
    assert.equal(tokenCalls, 1);
  });

  it("retries a connection test after a network failure", async () => {
    let tokenCalls = 0;
    const http = {
      async get() {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          const error = new Error("timeout");
          error.code = "ETIMEDOUT";
          throw error;
        }
        return { data: { access_token: "token", expires_in: 7200 } };
      }
    };
    const client = new WechatClient({ appid: "wx-test", appsecret: "secret" }, { http });
    assert.equal(await client.testConnection(), true);
    assert.equal(tokenCalls, 2);
  });
});
