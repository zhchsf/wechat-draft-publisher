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
    queue: Array.isArray(source.queue) ? source.queue.filter((article) => article && typeof article === "object").map((article) => {
      if (article && article.status === "publishing") {
        return {
          ...article,
          status: "failed",
          lastError: {
            code: "INTERRUPTED",
            message: "上一次发布任务在应用退出前未完成，请检查后重试"
          }
        };
      }
      return article;
    }) : [],
    history: Array.isArray(source.history) ? source.history : []
  };
}

class StateStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "state.json");
    this.state = null;
    this.loadWarning = "";
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.state) return this.state;
    let shouldPersist = false;
    try {
      const raw = await fileSystem.readFile(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(raw));
      shouldPersist = this.state.queue.some((article) => article.lastError?.code === "INTERRUPTED");
    } catch (error) {
      if (error.code === "ENOENT") {
        this.state = defaultState();
      } else {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          await fileSystem.rename(this.filePath, backupPath);
          this.loadWarning = `本地状态文件无法读取，已备份为 ${path.basename(backupPath)}，已恢复空状态`;
        } catch (backupError) {
          this.loadWarning = "本地状态文件无法读取，已恢复空状态；原文件未能自动备份";
        }
        this.state = defaultState();
      }
    }
    if (shouldPersist) await this.save(this.state);
    return this.state;
  }

  getLoadWarning() {
    return this.loadWarning;
  }

  async save(nextState) {
    this.state = normalizeState(nextState);
    const serialized = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
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
