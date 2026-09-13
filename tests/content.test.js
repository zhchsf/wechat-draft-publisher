const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  inspectHtmlFile,
  replaceAssetTokens,
  resolveLocalAsset,
  validateArticle
} = require("../src/content-service");

const onePixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const testRoot = path.join(__dirname, "..", ".test-tmp");

describe("content service", () => {
  let fixtureDirectory;
  let articlePath;

  beforeEach(() => {
    fs.mkdirSync(testRoot, { recursive: true });
    fixtureDirectory = fs.mkdtempSync(path.join(testRoot, "content-"));
    fs.mkdirSync(path.join(fixtureDirectory, "images"));
    fs.writeFileSync(path.join(fixtureDirectory, "images", "cover.png"), onePixel);
    fs.writeFileSync(path.join(fixtureDirectory, "article.html"), `<!doctype html><html><head><title>本地文章</title><meta name="description" content="文章摘要"><meta name="author" content="作者"><script>alert(1)</script></head><body><h1>正文标题</h1><p>文章内容<img src="images/cover.png" onerror="alert(1)"><img src="images/cover.png"><img src="images/missing.png"></p><script>bad()</script></body></html>`);
    articlePath = path.join(fixtureDirectory, "article.html");
  });

  afterEach(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));

  it("extracts metadata, sanitizes HTML and deduplicates images", async () => {
    const article = await inspectHtmlFile(articlePath);
    assert.equal(article.title, "本地文章");
    assert.equal(article.author, "作者");
    assert.equal(article.digest, "文章摘要");
    assert.equal(article.assets.length, 1);
    assert.equal(article.assets[0].sha256, crypto.createHash("sha256").update(onePixel).digest("hex"));
    assert.equal((article.contentHtml.match(/asset:\/\//g) || []).length, 2);
    assert.equal(article.contentHtml.includes("onerror"), false);
    assert.equal(article.contentHtml.includes("alert"), false);
    assert.ok(article.issues.some((issue) => issue.type === "missing-image"));
    assert.ok(article.issues.some((issue) => issue.type === "unsupported-tag"));
    assert.equal(validateArticle(article).valid, false);

    article.ignoredIssueIds = article.issues.map((issue) => issue.id);
    assert.equal(validateArticle(article).valid, true);
  });

  it("rejects remote and outside-root image paths", () => {
    assert.equal(resolveLocalAsset(fixtureDirectory, "https://example.com/a.png").error, "仅支持文章目录内的本地图片");
    assert.equal(resolveLocalAsset(fixtureDirectory, "../cover.png").error, "图片路径超出文章目录范围");
    assert.equal(resolveLocalAsset(fixtureDirectory, "images%2Fcover.png").path, path.join(fixtureDirectory, "images", "cover.png"));
  });

  it("replaces asset tokens with uploaded URLs", () => {
    assert.equal(replaceAssetTokens("<img src=\"asset://asset-a\"><img src=\"asset://missing\">", { "asset-a": "https://cdn.example/a.png" }), "<img src=\"https://cdn.example/a.png\"><img src=\"\">");
  });
});
