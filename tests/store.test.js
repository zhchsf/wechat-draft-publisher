const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { StateStore } = require("../src/store");

describe("state store", () => {
  const directory = path.join(__dirname, "..", ".store-test");

  beforeEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("persists normalized state with private file permissions", async () => {
    const store = new StateStore(directory);
    await store.save({ settings: { appid: "wx-test", appsecret: "secret" }, queue: [], history: [] });
    const state = await store.load();
    const mode = fs.statSync(path.join(directory, "state.json")).mode & 0o777;
    assert.equal(state.settings.appid, "wx-test");
    assert.equal(mode, 0o600);
  });

  it("tightens permissions on an existing state file when loading", async () => {
    const store = new StateStore(directory);
    await store.save({ settings: { appid: "wx-test", appsecret: "secret" }, queue: [], history: [] });
    fs.chmodSync(path.join(directory, "state.json"), 0o644);
    const restarted = new StateStore(directory);
    await restarted.load();
    assert.equal(fs.statSync(path.join(directory, "state.json")).mode & 0o777, 0o600);
  });

  it("backs up a corrupt state file and exposes a warning", async () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "state.json"), "{broken", "utf8");
    const store = new StateStore(directory);
    const state = await store.load();
    const backups = fs.readdirSync(directory).filter((name) => name.startsWith("state.json.corrupt-"));
    assert.deepEqual(state.queue, []);
    assert.ok(store.getLoadWarning().includes("已备份"));
    assert.equal(backups.length, 1);
    assert.equal(fs.existsSync(path.join(directory, "state.json")), false);
  });

  it("turns an interrupted publishing article into a persisted failure", async () => {
    const initial = new StateStore(directory);
    await initial.save({
      settings: { appid: "wx-test", appsecret: "secret" },
      queue: [{ id: "article-1", status: "publishing", title: "文章" }],
      history: []
    });
    const restarted = new StateStore(directory);
    const state = await restarted.load();
    assert.equal(state.queue[0].status, "failed");
    assert.equal(state.queue[0].lastError.code, "INTERRUPTED");
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).queue[0].status, "failed");
  });

  it("allows a later save after a previous save failed", async () => {
    fs.mkdirSync(directory, { recursive: true });
    const blockedPath = path.join(directory, "blocked");
    fs.writeFileSync(blockedPath, "file");
    const store = new StateStore(blockedPath);
    await assert.rejects(() => store.save({ settings: {}, queue: [], history: [] }));
    store.filePath = path.join(directory, "recovered", "state.json");
    await store.save({ settings: {}, queue: [], history: [] });
    assert.equal(fs.existsSync(store.filePath), true);
  });
});
