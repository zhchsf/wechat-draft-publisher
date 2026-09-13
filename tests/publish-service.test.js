const assert = require("assert");

const { WechatApiError } = require("../src/wechat-client");
const { articleHistory, publishArticleIds } = require("../src/publish-service");

function makeArticle(id, status = "ready") {
  return {
    id,
    sourcePath: `/articles/${id}.html`,
    title: `文章 ${id}`,
    author: "作者",
    digest: "摘要",
    sourceUrl: "",
    contentHtml: `<p>正文<img src="asset://${id}-asset"></p>`,
    coverAssetId: `${id}-asset`,
    needOpenComment: true,
    onlyFansCanComment: false,
    assets: [{ id: `${id}-asset`, path: `/articles/${id}.png`, sha256: `${id}-hash`, mimeType: "image/png" }],
    issues: [],
    ignoredIssueIds: [],
    status,
    draftMediaId: "",
    lastError: null
  };
}

function makeStore(state) {
  return {
    state,
    saves: 0,
    async load() {
      return this.state;
    },
    async save(nextState) {
      this.state = nextState;
      this.saves += 1;
      return this.state;
    }
  };
}

describe("publish service", () => {
  it("continues publishing after one article fails and reports progress", async () => {
    const first = makeArticle("first");
    const second = makeArticle("second");
    const store = makeStore({
      settings: { appid: "wx-test", appsecret: "secret" },
      queue: [first, second],
      history: []
    });
    const progress = [];
    const client = {
      async createDraft(article) {
        if (article.id === "first") throw new WechatApiError("接口拒绝", 40013);
        return { mediaId: "draft-second" };
      }
    };

    const response = await publishArticleIds({
      stateStore: store,
      articleIds: ["first", "second"],
      sender: { isDestroyed: () => false, send: (_, payload) => progress.push(payload) },
      clientFactory: () => client
    });

    assert.deepEqual(response.results.map((item) => item.status), ["failed", "success"]);
    assert.equal(first.status, "failed");
    assert.equal(first.lastError.code, 40013);
    assert.equal(second.status, "success");
    assert.equal(second.draftMediaId, "draft-second");
    assert.deepEqual(progress.map((item) => `${item.articleId}:${item.status}`), [
      "first:publishing", "first:failed", "second:publishing", "second:success"
    ]);
    assert.deepEqual(store.state.history.map((item) => item.status), ["success", "failed"]);
  });

  it("does not hash random asset token ids as content changes", () => {
    const first = makeArticle("first");
    const second = { ...makeArticle("second"), title: first.title, contentHtml: `<p>正文<img src="asset://another-id"></p>`, coverAssetId: "another-id", assets: [{ id: "another-id", path: "/articles/second.png", sha256: "first-hash", mimeType: "image/png" }] };
    assert.equal(articleHistory(first, "failed").contentHash, articleHistory(second, "failed").contentHash);
    second.onlyFansCanComment = true;
    assert.notEqual(articleHistory(first, "failed").contentHash, articleHistory(second, "failed").contentHash);
  });

  it("does not republish an article that already has a successful draft", async () => {
    const store = makeStore({
      settings: { appid: "wx-test", appsecret: "secret" },
      queue: [makeArticle("done", "success")],
      history: []
    });
    await assert.rejects(
      () => publishArticleIds({ stateStore: store, articleIds: ["done"], clientFactory: () => ({}) }),
      (error) => error.code === "EMPTY_QUEUE"
    );
  });
});
