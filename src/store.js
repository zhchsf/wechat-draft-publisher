const fs = require("fs");
const path = require("path");

const { promises: fileSystem } = fs;

function defaultState() {
  return {
    settings: {
      appid: "",
      appsecret: ""
    },
    queue: [],
    history: []
  };
}

function normalizeState(value) {
  const fallback = defaultState();
  const source = value && typeof value === "object" ? value : {};
  return {
    settings: {
      appid: typeof source.settings?.appid === "string" ? source.settings.appid : fallback.settings.appid,
      appsecret: typeof source.settings?.appsecret === "string" ? source.settings.appsecret : fallback.settings.appsecret
    },
    queue: Array.isArray(source.queue) ? source.queue : [],
    history: Array.isArray(source.history) ? source.history : []
  };
}

class StateStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "state.json");
    this.state = null;
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.state) return this.state;
    try {
      const raw = await fileSystem.readFile(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.state = defaultState();
      } else {
        this.state = defaultState();
      }
    }
    return this.state;
  }

  async save(nextState) {
    this.state = normalizeState(nextState);
    const serialized = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fileSystem.mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await fileSystem.writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
      await fileSystem.chmod(tempPath, 0o600);
      await fileSystem.rename(tempPath, this.filePath);
      await fileSystem.chmod(this.filePath, 0o600);
    });
    await this.writeChain;
    return this.state;
  }

  async update(mutator) {
    const state = await this.load();
    const result = await mutator(state);
    await this.save(result || state);
    return this.state;
  }
}

module.exports = {
  StateStore,
  defaultState,
  normalizeState
};
