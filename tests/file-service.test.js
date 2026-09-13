const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { discoverHtmlFiles } = require("../src/file-service");
const testRoot = path.join(__dirname, "..", ".test-tmp");

describe("file service", () => {
  let directory;

  beforeEach(() => {
    fs.mkdirSync(testRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(testRoot, "files-"));
    fs.mkdirSync(path.join(directory, "nested"));
    fs.writeFileSync(path.join(directory, "one.html"), "<p>one</p>");
    fs.writeFileSync(path.join(directory, "readme.txt"), "ignore");
    fs.writeFileSync(path.join(directory, "nested", "two.htm"), "<p>two</p>");
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("discovers HTML files from files and directories", async () => {
    const files = await discoverHtmlFiles([directory, path.join(directory, "one.html")]);
    assert.deepEqual(files, [path.join(directory, "nested", "two.htm"), path.join(directory, "one.html")].sort());
  });
});
