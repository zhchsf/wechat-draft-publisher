const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { StateStore } = require("../src/store");

describe("state store", () => {
  const directory = path.join(__dirname, "..", ".store-test");

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("persists normalized state with private file permissions", async () => {
    const store = new StateStore(directory);
    await store.save({ settings: { appid: "wx-test", appsecret: "secret" }, queue: [], history: [] });
    const state = await store.load();
    const mode = fs.statSync(path.join(directory, "state.json")).mode & 0o777;
    assert.equal(state.settings.appid, "wx-test");
    assert.equal(mode, 0o600);
  });
});
