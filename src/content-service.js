const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const mime = require("mime-types");

const { promises: fileSystem } = fs;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

const SAFE_TAGS = new Set([
  "a", "article", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
  "dd", "div", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "li", "ol", "p", "pre", "q", "s", "small", "span", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul"
]);

const REMOVE_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "video", "audio"]);
const REMOVE_EMPTY = new Set(["link", "base", "meta", "title"]);

function makeId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

function issueId(type, index) {
  return `${type}-${index + 1}`;
}

function addIssue(issues, type, message, index, options = {}) {
  issues.push({
    id: issueId(type, index),
    type,
    severity: options.severity || "warning",
    blocking: options.blocking !== false,
    canIgnore: options.canIgnore !== false,
    message
  });
}

function metadataValue($, selectors) {
  for (const selector of selectors) {
    const value = $(selector).first().attr("content") || $(selector).first().text();
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function safeStyle(style) {
  const value = String(style || "");
  if (/url\s*\(|expression\s*\(|javascript\s*:|-moz-binding/i.test(value)) return "";
  return value.replace(/!important/gi, "").trim();
}

function resolveLocalAsset(sourceDirectory, sourceValue) {
  const rawValue = String(sourceValue || "").trim();
  if (!rawValue) return { error: "图片缺少 src 属性" };
  if (/^(https?:|data:|file:|blob:|\/\/)/i.test(rawValue)) {
    return { error: "仅支持文章目录内的本地图片" };
  }
  let relativePath;
  try {
    relativePath = decodeURIComponent(rawValue.split(/[?#]/, 1)[0]);
  } catch (error) {
    return { error: "图片路径编码无效" };
  }
  if (!relativePath || path.isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith("\\")) {
    return { error: "图片路径必须是目录内的相对路径" };
  }
  const normalizedPath = relativePath.replaceAll("\\", path.sep);
  if (normalizedPath.includes("\0")) return { error: "图片路径包含无效字符" };
  const resolvedPath = path.resolve(sourceDirectory, normalizedPath);
  const relativeToRoot = path.relative(path.resolve(sourceDirectory), resolvedPath);
  if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return { error: "图片路径超出文章目录范围" };
  }
  return { path: resolvedPath };
}

async function inspectHtmlFile(sourcePath) {
  const absolutePath = await fileSystem.realpath(path.resolve(sourcePath));
  const sourceDirectory = path.dirname(absolutePath);
  const sourceHtml = await fileSystem.readFile(absolutePath, "utf8");
  const $ = cheerio.load(sourceHtml, { decodeEntities: false });
  const issues = [];
  let issueCounter = 0;

  const title = metadataValue($, ["title"]) || path.basename(absolutePath, path.extname(absolutePath));
  const digest = metadataValue($, ['meta[name="description"]', 'meta[property="og:description"]']);
  const author = metadataValue($, ['meta[name="author"]', 'meta[property="article:author"]']);
  const sourceUrl = $("link[rel=canonical]").first().attr("href") || $("meta[property='og:url']").first().attr("content") || "";

  $("head").remove();
  $("html").children().not("body").remove();

  $("*").each((_, element) => {
    const tagName = String(element.name || "").toLowerCase();
    if (!tagName || tagName === "html" || tagName === "body") return;
    if (REMOVE_WITH_CONTENT.has(tagName)) {
      addIssue(issues, "unsupported-tag", `已移除不支持的 HTML 元素：${tagName}`, issueCounter++);
      $(element).remove();
      return;
    }
    if (REMOVE_EMPTY.has(tagName)) {
      addIssue(issues, "unsupported-tag", `已移除不支持的 HTML 元素：${tagName}`, issueCounter++);
      $(element).remove();
      return;
    }
    if (!SAFE_TAGS.has(tagName)) {
      addIssue(issues, "unsupported-tag", `已移除不支持的 HTML 元素：${tagName}`, issueCounter++);
      $(element).replaceWith($(element).contents());
      return;
    }
    for (const attributeName of Object.keys(element.attribs || {})) {
      if (/^on/i.test(attributeName)) {
        $(element).removeAttr(attributeName);
        continue;
      }
      if (attributeName.toLowerCase() === "style") {
        const cleanedStyle = safeStyle($(element).attr(attributeName));
        if (!cleanedStyle && $(element).attr(attributeName)) {
          $(element).removeAttr(attributeName);
          addIssue(issues, "unsupported-style", "已移除包含外部资源或脚本表达式的行内样式", issueCounter++);
        } else {
          $(element).attr(attributeName, cleanedStyle);
        }
      }
    }
    if (tagName === "a") {
      const href = $(element).attr("href");
      if (href && /^(javascript:|data:)/i.test(href)) $(element).removeAttr("href");
    }
  });

  const assets = [];
  const assetByHash = new Map();
  const imageElements = $("img").toArray();
  let firstAssetId = "";
  for (let index = 0; index < imageElements.length; index += 1) {
    const imageElement = imageElements[index];
    const imageSource = $(imageElement).attr("src");
    if ($(imageElement).attr("srcset")) {
      $(imageElement).removeAttr("srcset");
      addIssue(issues, "unsupported-srcset", "已移除图片的 srcset 属性，请使用单一图片地址", issueCounter++);
    }
    const resolved = resolveLocalAsset(sourceDirectory, imageSource);
    if (resolved.error) {
      $(imageElement).remove();
      addIssue(issues, "invalid-image", `${resolved.error}${imageSource ? `：${imageSource}` : ""}`, issueCounter++);
      continue;
    }
    let stats;
    let assetPath;
    try {
      assetPath = await fileSystem.realpath(resolved.path);
      const relativeAssetPath = path.relative(sourceDirectory, assetPath);
      if (!relativeAssetPath || relativeAssetPath.startsWith("..") || path.isAbsolute(relativeAssetPath)) {
        $(imageElement).remove();
        addIssue(issues, "invalid-image", `图片路径超出文章目录范围：${imageSource}`, issueCounter++);
        continue;
      }
      stats = await fileSystem.stat(assetPath);
    } catch (error) {
      $(imageElement).remove();
      addIssue(issues, "missing-image", `找不到图片：${imageSource}`, issueCounter++);
      continue;
    }
    if (!stats.isFile()) {
      $(imageElement).remove();
      addIssue(issues, "invalid-image", `图片路径不是文件：${imageSource}`, issueCounter++);
      continue;
    }
    let content;
    try {
      content = await fileSystem.readFile(assetPath);
    } catch (error) {
      $(imageElement).remove();
      addIssue(issues, "file-error", `图片文件无法读取：${imageSource}`, issueCounter++);
      continue;
    }
    const mimeType = mime.lookup(assetPath) || "";
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      $(imageElement).remove();
      addIssue(issues, "unsupported-image", `图片格式不支持：${imageSource}`, issueCounter++);
      continue;
    }
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    let asset = assetByHash.get(hash);
    if (!asset) {
      asset = {
        id: makeId("asset"),
        path: assetPath,
        mimeType,
        sha256: hash,
        usage: "inline"
      };
      assets.push(asset);
      assetByHash.set(hash, asset);
    }
    $(imageElement).attr("src", `asset://${asset.id}`);
    $(imageElement).attr("data-wx-asset-id", asset.id);
    if (!firstAssetId) firstAssetId = asset.id;
  }

  const bodyHtml = $("body").length ? $("body").html() || "" : $.root().html() || "";
  const bodyText = cheerio.load(bodyHtml).root().text().replace(/\s+/g, " ").trim();
  if (!bodyText && !assets.length) {
    addIssue(issues, "empty-content", "正文没有可发布的文本或图片", issueCounter++, { canIgnore: false });
  }
  if (!firstAssetId) {
    addIssue(issues, "missing-cover", "没有可用封面，请补充目录内的本地图片", issueCounter++, { canIgnore: false });
  }

  return {
    id: makeId("article"),
    sourcePath: absolutePath,
    title,
    author,
    digest,
    sourceUrl,
    contentHtml: bodyHtml,
    coverAssetId: firstAssetId,
    needOpenComment: true,
    onlyFansCanComment: false,
    assets,
    issues,
    ignoredIssueIds: [],
    status: "ready",
    draftMediaId: "",
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function validateArticle(article) {
  const ignored = new Set(article.ignoredIssueIds || []);
  const unresolvedIssues = (article.issues || []).filter((item) => !ignored.has(item.id));
  const coverExists = Boolean(article.coverAssetId && (article.assets || []).some((asset) => asset.id === article.coverAssetId));
  const missingCover = (article.issues || []).some((item) => item.type === "missing-cover");
  const assetIds = new Set((article.assets || []).map((asset) => asset.id));
  const unresolvedAssetIds = [...String(article.contentHtml || "").matchAll(/asset:\/\/([a-zA-Z0-9-]+)/g)]
    .map((match) => match[1])
    .filter((assetId, index, values) => !assetIds.has(assetId) && values.indexOf(assetId) === index);
  if (unresolvedAssetIds.length) {
    unresolvedIssues.push({
      id: "unresolved-asset-reference",
      type: "invalid-content",
      severity: "error",
      blocking: true,
      canIgnore: false,
      message: `正文引用了不存在的图片资源：${unresolvedAssetIds.join("、")}`
    });
  }
  return {
    valid: unresolvedIssues.length === 0 && coverExists && !missingCover && Boolean(String(article.title || "").trim()),
    unresolvedIssues,
    coverExists
  };
}

function replaceAssetTokens(contentHtml, replacements) {
  return String(contentHtml || "").replace(/asset:\/\/([a-zA-Z0-9-]+)/g, (_, assetId) => replacements[assetId] || "");
}

module.exports = {
  SUPPORTED_IMAGE_TYPES,
  inspectHtmlFile,
  replaceAssetTokens,
  resolveLocalAsset,
  safeStyle,
  validateArticle
};
