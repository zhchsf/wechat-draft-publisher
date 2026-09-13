const fs = require("fs");
const path = require("path");

const { promises: fileSystem } = fs;
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

function isHtmlPath(filePath) {
  return HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function walkForHtml(directoryPath) {
  const entries = await fileSystem.readdir(directoryPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkForHtml(entryPath)));
    } else if (entry.isFile() && isHtmlPath(entryPath)) {
      files.push(path.resolve(entryPath));
    }
  }
  return files;
}

async function discoverHtmlFiles(inputPaths) {
  const discovered = new Set();
  for (const inputPath of inputPaths || []) {
    const absolutePath = path.resolve(inputPath);
    const stats = await fileSystem.stat(absolutePath);
    if (stats.isDirectory()) {
      for (const htmlPath of await walkForHtml(absolutePath)) discovered.add(htmlPath);
    } else if (stats.isFile() && isHtmlPath(absolutePath)) {
      discovered.add(absolutePath);
    }
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

async function readHtmlFile(filePath) {
  return fileSystem.readFile(path.resolve(filePath), "utf8");
}

module.exports = {
  discoverHtmlFiles,
  isHtmlPath,
  readHtmlFile,
  walkForHtml
};
