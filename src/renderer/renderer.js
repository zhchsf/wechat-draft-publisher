(function () {
  "use strict";

  const api = window.publisherApi;
  const app = document.getElementById("app");
  const ui = {
    view: "queue",
    activeArticleId: null,
    selectedIds: new Set(),
    sourceCandidates: [],
    modal: null,
    toast: null,
    busy: false,
    progress: null,
  };
  let state = { settings: { appid: "", appsecret: "" }, queue: [], history: [] };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
  }

  function basename(filePath) {
    return String(filePath || "").split(/[\\/]/).pop() || filePath;
  }

  function shortPath(filePath) {
    const pathValue = String(filePath || "");
    return pathValue.length > 58 ? `…${pathValue.slice(-55)}` : pathValue;
  }

  function statusLabel(status) {
    return {
      ready: "待检查",
      queued: "待发布",
      publishing: "发布中",
      success: "已创建草稿",
      failed: "发布失败"
    }[status] || "待处理";
  }

  function issueCount(article) {
    const ignored = new Set(article.ignoredIssueIds || []);
    return (article.issues || []).filter((item) => item.canIgnore === false || !ignored.has(item.id)).length;
  }

  function currentArticle() {
    return state.queue.find((article) => article.id === ui.activeArticleId) || state.queue[0] || null;
  }

  function showToast(message, tone = "info") {
    ui.toast = { message, tone };
    render();
    window.setTimeout(() => {
      if (ui.toast?.message === message) {
        ui.toast = null;
        render();
      }
    }, 4200);
  }

  async function persistQueue() {
    state = await api.saveQueue(state.queue);
  }

  async function importSources() {
    if (ui.busy) return;
    try {
      const candidates = await api.selectSources();
      if (!candidates.length) {
        showToast("所选位置中没有找到 HTML 文件", "warning");
        return;
      }
      ui.sourceCandidates = candidates;
      if (candidates.length === 1) {
        await inspectSelectedSources(candidates);
      } else {
        ui.modal = "source-picker";
        render();
      }
    } catch (error) {
      showToast(error.message || "读取文章失败", "error");
    }
  }

  async function inspectSelectedSources(paths) {
    ui.busy = true;
    ui.progress = null;
    ui.modal = null;
    render();
    try {
      const articles = await api.inspectSources(paths);
      const knownSources = new Set(state.queue.map((article) => article.sourcePath));
      const additions = articles.filter((article) => {
        if (knownSources.has(article.sourcePath)) return false;
        knownSources.add(article.sourcePath);
        return true;
      });
      state.queue.push(...additions);
      additions.forEach((article) => ui.selectedIds.add(article.id));
      if (!ui.activeArticleId && additions[0]) ui.activeArticleId = additions[0].id;
      await persistQueue();
      showToast(additions.length ? `已导入 ${additions.length} 篇文章` : "所选文章已在队列中", additions.length ? "success" : "warning");
    } catch (error) {
      showToast(error.message || "解析文章失败", "error");
    } finally {
      ui.busy = false;
      ui.progress = null;
      render();
    }
  }

  function selectedArticleIds() {
    return state.queue
      .filter((article) => ui.selectedIds.has(article.id))
      .filter((article) => isPublishable(article))
      .map((article) => article.id);
  }

  function isPublishable(article) {
    return ["ready", "queued", "failed"].includes(article.status);
  }

  function publishableArticles() {
    return state.queue.filter(isPublishable);
  }

  async function publishSelected() {
    if (ui.busy) return;
    const ids = selectedArticleIds();
    if (!ids.length) {
      showToast("请先勾选要发布的文章", "warning");
      return;
    }
    if (!state.settings.appid || !state.settings.appsecret) {
      showToast("请先在设置中填写公众号 AppID 和 AppSecret", "warning");
      ui.view = "settings";
      render();
      return;
    }
    const invalid = state.queue.filter((article) => ids.includes(article.id)).filter((article) => {
      const ignored = new Set(article.ignoredIssueIds || []);
      const coverExists = Boolean(article.coverAssetId && (article.assets || []).some((asset) => asset.id === article.coverAssetId));
      return (article.issues || []).some((issue) => issue.canIgnore === false || !ignored.has(issue.id)) || !String(article.title || "").trim() || !coverExists;
    });
    if (invalid.length) {
      showToast(`有 ${invalid.length} 篇文章仍有未处理问题`, "warning");
      ui.activeArticleId = invalid[0].id;
      render();
      return;
    }
    if (!window.confirm(`确定将 ${ids.length} 篇文章分别创建到公众号草稿箱吗？`)) return;
    ui.busy = true;
    ui.progress = { index: 0, total: ids.length, title: "" };
    render();
    try {
      const response = await api.publishArticles(ids);
      state = response.state;
      response.results.filter((item) => item.status === "success").forEach((item) => ui.selectedIds.delete(item.articleId));
      const successCount = response.results.filter((item) => item.status === "success").length;
      const failedCount = response.results.filter((item) => item.status === "failed").length;
      showToast(`发布任务完成：成功 ${successCount} 篇，失败 ${failedCount} 篇`, failedCount ? "warning" : "success");
    } catch (error) {
      showToast(error.message || "发布任务失败", "error");
    } finally {
      ui.busy = false;
      ui.progress = null;
      render();
    }
  }

  async function retryHistory(historyId) {
    if (ui.busy) return;
    ui.busy = true;
    ui.progress = { index: 0, total: 1, title: "" };
    render();
    try {
      const response = await api.retryHistory(historyId);
      state = response.state;
      response.results.filter((item) => item.status === "success").forEach((item) => ui.selectedIds.delete(item.articleId));
      ui.view = "queue";
      const failed = response.results.find((item) => item.status === "failed");
      showToast(failed ? `重试失败：${failed.error?.message || "请检查发布历史"}` : "重试成功，草稿已创建", failed ? "error" : "success");
    } catch (error) {
      showToast(error.message || "重试失败", "error");
    } finally {
      ui.busy = false;
      ui.progress = null;
      render();
    }
  }

  async function saveSettings(form) {
    const settings = {
      appid: form.querySelector("[name=appid]").value.trim(),
      appsecret: form.querySelector("[name=appsecret]").value.trim()
    };
    state.settings = await api.saveSettings(settings);
    showToast("公众号配置已保存", "success");
  }

  async function testConnection() {
    ui.busy = true;
    ui.progress = null;
    render();
    try {
      const result = await api.testConnection();
      showToast(result.ok ? result.message : `${result.message}（${result.code}）`, result.ok ? "success" : "error");
    } catch (error) {
      showToast(error.message || "测试接口失败", "error");
    } finally {
      ui.busy = false;
      ui.progress = null;
      render();
    }
  }

  async function updateArticleField(article, field, value) {
    const previousValue = article[field];
    const previousStatus = article.status;
    const previousDraftMediaId = article.draftMediaId;
    const previousUpdatedAt = article.updatedAt;
    article[field] = value;
    if (article.status === "success") {
      article.status = "ready";
      article.draftMediaId = "";
    }
    article.updatedAt = new Date().toISOString();
    try {
      await persistQueue();
    } catch (error) {
      article[field] = previousValue;
      article.status = previousStatus;
      article.draftMediaId = previousDraftMediaId;
      article.updatedAt = previousUpdatedAt;
      throw error;
    }
  }

  async function toggleIssue(article, issueId, checked) {
    const issue = (article.issues || []).find((item) => item.id === issueId);
    if (!issue || issue.canIgnore === false) return;
    const previousIgnoredIssueIds = article.ignoredIssueIds;
    const previousStatus = article.status;
    const previousUpdatedAt = article.updatedAt;
    const ignored = new Set(article.ignoredIssueIds || []);
    if (checked) ignored.add(issueId);
    else ignored.delete(issueId);
    article.ignoredIssueIds = [...ignored];
    article.status = "ready";
    try {
      await persistQueue();
    } catch (error) {
      article.ignoredIssueIds = previousIgnoredIssueIds;
      article.status = previousStatus;
      article.updatedAt = previousUpdatedAt;
      throw error;
    }
    render();
  }

  function previewDocument(article, assetData) {
    let content = article.contentHtml || "";
    for (const asset of article.assets || []) content = content.replaceAll(`asset://${asset.id}`, assetData[asset.id] || "");
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"><style>body{margin:0;padding:24px 22px;color:#263247;background:#fff;font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;word-break:break-word}h1,h2,h3,h4{line-height:1.35;color:#16263f}img{display:block;max-width:100%;height:auto;margin:18px auto}a{color:#1769aa}table{width:100%;border-collapse:collapse}td,th{border:1px solid #dce3ed;padding:8px}blockquote{margin:16px 0;padding:10px 16px;border-left:3px solid #4c9f70;background:#f4faf6}</style></head><body>${content}</body></html>`;
  }

  async function refreshPreview(article) {
    const frame = document.querySelector("[data-preview-frame]");
    if (!frame || !article) return;
    const assetData = {};
    const assetErrors = [];
    for (const asset of article.assets || []) {
      try {
        assetData[asset.id] = await api.readAsset(article.id, asset.id);
      } catch (error) {
        assetData[asset.id] = "";
        assetErrors.push(asset.path || asset.id);
      }
    }
    if (document.querySelector("[data-preview-frame]") === frame) {
      frame.srcdoc = previewDocument(article, assetData);
      const status = document.querySelector("[data-preview-status]");
      if (status) {
        status.hidden = !assetErrors.length;
        status.textContent = assetErrors.length ? `有 ${assetErrors.length} 张图片无法读取，发布前请检查源文件是否被移动或删除。` : "";
      }
    }
  }

  function renderHeader() {
    const configured = Boolean(state.settings.appid && state.settings.appsecret);
    return `<header class="topbar"><div class="brand-mark"><span class="brand-symbol">微</span><div><strong>草稿发布器</strong><small>HTML · 微信公众号</small></div></div><nav class="topnav"><button class="nav-button ${ui.view === "queue" ? "active" : ""}" data-view="queue">文章队列 <span>${state.queue.length}</span></button><button class="nav-button ${ui.view === "history" ? "active" : ""}" data-view="history">发布历史 <span>${state.history.length}</span></button><button class="nav-button ${ui.view === "settings" ? "active" : ""}" data-view="settings">公众号设置</button></nav><div class="connection-state ${configured ? "is-ready" : "is-missing"}"><i></i>${configured ? "已配置账号" : "未配置账号"}</div></header>`;
  }

  function renderQueueSidebar() {
    const selectedCount = selectedArticleIds().length;
    const selectableCount = publishableArticles().length;
    return `<aside class="queue-sidebar"><div class="sidebar-heading"><div><span class="eyebrow">WORKSPACE</span><h1>文章队列</h1></div><button class="icon-button" data-import title="选择 HTML 文件或目录" aria-label="选择 HTML 文件或目录">＋</button></div><div class="sidebar-actions"><button class="primary-button" data-import>导入文章</button><button class="quiet-button" data-select-all>${selectedCount === selectableCount && selectableCount ? "取消全选" : "全选"}</button></div><div class="queue-summary"><span>${selectedCount} 篇已选</span><span>${state.queue.filter((article) => issueCount(article)).length} 篇待处理</span></div><div class="queue-list">${state.queue.length ? state.queue.map((article) => `<button class="queue-item ${article.id === ui.activeArticleId ? "active" : ""}" data-article-id="${article.id}"><span class="queue-check ${ui.selectedIds.has(article.id) ? "checked" : ""}" data-select-check="${article.id}">${ui.selectedIds.has(article.id) ? "✓" : ""}</span><span class="queue-item-copy"><strong>${escapeHtml(article.title || basename(article.sourcePath))}</strong><small>${escapeHtml(basename(article.sourcePath))}</small></span><span class="queue-item-status status-${article.status}">${statusLabel(article.status)}</span></button>`).join("") : `<div class="empty-sidebar"><div class="empty-icon">＋</div><strong>还没有文章</strong><p>从 HTML 文件或文章目录开始</p></div>`}</div><div class="sidebar-footnote"><span class="status-dot"></span>本地处理 · 数据保存在本机</div></aside>`;
  }

  function renderIssues(article) {
    const issues = article.issues || [];
    if (!issues.length) return `<div class="clean-state"><span>✓</span><div><strong>资源检查通过</strong><small>正文图片和 HTML 结构可以提交</small></div></div>`;
    const ignored = new Set(article.ignoredIssueIds || []);
    const isIgnored = (issue) => issue.canIgnore !== false && ignored.has(issue.id);
    return `<div class="issues-box"><div class="section-label"><span>资源检查</span><em>${issues.filter((issue) => !isIgnored(issue)).length} 项待处理</em></div>${issues.map((issue) => `<label class="issue-row ${isIgnored(issue) ? "ignored" : ""}"><input type="checkbox" data-issue-toggle="${issue.id}" ${isIgnored(issue) ? "checked" : ""} ${issue.canIgnore ? "" : "disabled"}/><span class="issue-icon">${issue.canIgnore ? "!" : "×"}</span><span><strong>${escapeHtml(issue.message)}</strong><small>${issue.canIgnore ? "勾选后忽略并移除问题资源" : "必须修复后才能发布"}</small></span></label>`).join("")}</div>`;
  }

  function renderEditor(article) {
    const coverOptions = (article.assets || []).map((asset, index) => `<option value="${asset.id}" ${asset.id === article.coverAssetId ? "selected" : ""}>图片 ${index + 1} · ${escapeHtml(basename(asset.path))}</option>`).join("");
    const validation = issueCount(article) === 0 && (article.assets || []).some((asset) => asset.id === article.coverAssetId) && String(article.title || "").trim();
    return `<section class="editor-panel"><div class="panel-heading"><div><span class="eyebrow">ARTICLE DETAILS</span><h2>发布信息</h2></div><button class="text-button" data-open-source>打开源文件夹</button></div><div class="source-path" title="${escapeHtml(article.sourcePath)}">${escapeHtml(shortPath(article.sourcePath))}</div><div class="field-group"><label>标题 <span>必填</span></label><input data-field="title" value="${escapeHtml(article.title)}" maxlength="64" placeholder="文章标题"/></div><div class="field-row"><div class="field-group"><label>作者</label><input data-field="author" value="${escapeHtml(article.author)}" maxlength="32" placeholder="作者名称"/></div><div class="field-group"><label>封面</label><select data-field="coverAssetId" ${coverOptions ? "" : "disabled"}>${coverOptions || "<option>没有可用图片</option>"}</select></div></div><div class="field-group"><label>摘要 <span>可选</span></label><textarea data-field="digest" maxlength="120" placeholder="文章摘要">${escapeHtml(article.digest)}</textarea><small class="field-hint">默认读取 HTML 的 description，可在这里调整。</small></div><div class="field-group"><label>原文链接 <span>可选</span></label><input data-field="sourceUrl" value="${escapeHtml(article.sourceUrl)}" placeholder="https://"/></div><div class="toggle-row"><label><input type="checkbox" data-field="needOpenComment" ${article.needOpenComment ? "checked" : ""}/>允许留言</label><label><input type="checkbox" data-field="onlyFansCanComment" ${article.onlyFansCanComment ? "checked" : ""}/>仅粉丝可留言</label></div>${renderIssues(article)}<div class="editor-footer"><div class="article-meta"><span class="asset-count">${article.assets?.length || 0} 张本地图片</span><span>${validation ? "可以提交" : "需要处理"}</span></div><button class="danger-quiet" data-remove-article="${article.id}">移出队列</button></div></section>`;
  }

  function renderPreview(article) {
    return `<section class="preview-panel"><div class="panel-heading"><div><span class="eyebrow">SAFE PREVIEW</span><h2>正文预览</h2></div><span class="preview-badge">沙箱预览</span></div><div class="preview-meta"><strong>${escapeHtml(article.title || "未命名文章")}</strong><span>${escapeHtml(article.author || "未设置作者")} · ${article.assets?.length || 0} 张图片</span></div><div class="preview-status" data-preview-status hidden></div><iframe data-preview-frame title="文章正文预览" sandbox=""></iframe></section>`;
  }

  function renderQueueView() {
    const article = currentArticle();
    const selectedCount = selectedArticleIds().length;
    return `<div class="workspace-layout">${renderQueueSidebar()}<main class="main-panel"><div class="queue-toolbar"><div><span class="eyebrow">DRAFT ACTION</span><strong>${selectedCount ? `已选择 ${selectedCount} 篇文章` : "请选择文章"}</strong><small>每篇文章将单独创建为一条微信草稿</small></div><button class="primary-button" data-publish ${selectedCount && !ui.busy ? "" : "disabled"}>发布到草稿箱</button></div>${article ? `${renderEditor(article)}${renderPreview(article)}` : `<div class="empty-main"><div class="empty-main-art">HTML</div><h2>准备发布第一篇文章</h2><p>选择 HTML 文件或包含文章资源的目录，应用会自动读取正文和本地图片。</p><button class="primary-button" data-import>选择文章</button></div>`}</main></div>`;
  }

  function renderHistoryView() {
    const successCount = state.history.filter((item) => item.status === "success").length;
    const failedCount = state.history.filter((item) => item.status === "failed").length;
    return `<main class="simple-page"><div class="page-heading"><div><span class="eyebrow">ACTIVITY</span><h1>发布历史</h1><p>查看草稿创建结果，并从失败记录发起重试。</p></div><div class="history-stats"><span><strong>${successCount}</strong>成功</span><span><strong>${failedCount}</strong>失败</span></div></div>${state.history.length ? `<div class="history-table"><div class="history-head"><span>文章</span><span>状态</span><span>时间</span><span>结果</span><span></span></div>${state.history.map((item) => `<div class="history-row"><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(shortPath(item.sourcePath))}</small></div><span class="history-status ${item.status}">${item.status === "success" ? "已创建草稿" : "失败"}</span><span>${formatTime(item.updatedAt)}</span><span>${item.status === "success" ? `<code>${escapeHtml(item.draftMediaId)}</code>` : `<small class="error-text">${escapeHtml(item.errorMessage || item.errorCode)}</small>`}</span><span>${item.status === "failed" ? `<button class="outline-button" data-retry="${item.id}">重试</button>` : ""}</span></div>`).join("")}</div>` : `<div class="empty-state"><div class="empty-main-art">记录</div><h2>还没有发布记录</h2><p>完成一次草稿创建后，结果会显示在这里。</p></div>`}</main>`;
  }

  function renderSettingsView() {
    const hasSettings = Boolean(state.settings.appid && state.settings.appsecret);
    return `<main class="simple-page settings-page"><div class="page-heading"><div><span class="eyebrow">ACCOUNT</span><h1>公众号设置</h1><p>配置一个微信公众号账号，用于创建草稿。</p></div><span class="settings-pill ${hasSettings ? "ready" : "pending"}">${hasSettings ? "配置已保存" : "等待配置"}</span></div><form class="settings-form" data-settings-form><div class="form-section"><div class="form-section-title"><span class="section-number">01</span><div><h2>接口凭据</h2><p>凭据仅保存在当前电脑的本地配置文件中。</p></div></div><div class="field-group"><label>AppID</label><input name="appid" value="${escapeHtml(state.settings.appid)}" autocomplete="off" placeholder="微信公众号 AppID"/></div><div class="field-group"><label>AppSecret</label><input type="password" name="appsecret" value="${escapeHtml(state.settings.appsecret)}" autocomplete="off" placeholder="微信公众号 AppSecret"/></div></div><div class="form-section network-note"><div class="form-section-title"><span class="section-number">02</span><div><h2>接口要求</h2><p>微信接口会校验调用机器的公网出口 IP。</p></div></div><ul><li>将当前电脑的公网出口 IP 加入公众号后台 IP 白名单。</li><li>本软件只调用草稿接口，不会直接发布或群发文章。</li><li>AppSecret 以本地文件形式保存，请勿将配置文件分享给他人。</li></ul></div><div class="form-actions"><button type="submit" class="primary-button">保存配置</button><button type="button" class="outline-button" data-test-connection ${ui.busy ? "disabled" : ""}>测试接口连接</button></div></form></main>`;
  }

  function renderModal() {
    if (ui.modal !== "source-picker") return "";
    return `<div class="modal-backdrop" data-close-modal><section class="modal" role="dialog" aria-modal="true" aria-labelledby="source-picker-title"><div class="modal-heading"><div><span class="eyebrow">SOURCE FILES</span><h2 id="source-picker-title">选择要导入的 HTML</h2><p>目录中找到 ${ui.sourceCandidates.length} 个 HTML 文件，每个文件会创建一条独立草稿。</p></div><button class="icon-button" data-close-modal aria-label="关闭">×</button></div><div class="source-picker-list">${ui.sourceCandidates.map((sourcePath, index) => `<label class="source-choice"><input type="checkbox" data-source-choice value="${escapeHtml(sourcePath)}" checked/><span class="source-choice-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${escapeHtml(basename(sourcePath))}</strong><small>${escapeHtml(shortPath(sourcePath))}</small></span></label>`).join("")}</div><div class="modal-actions"><button class="quiet-button" data-close-modal>取消</button><button class="primary-button" data-confirm-sources>导入选中文章</button></div></section></div>`;
  }

  function render() {
    const view = ui.view === "history" ? renderHistoryView() : ui.view === "settings" ? renderSettingsView() : renderQueueView();
    const busyLabel = ui.progress ? `正在发布 ${ui.progress.index}/${ui.progress.total}${ui.progress.title ? `：${escapeHtml(ui.progress.title)}` : ""}` : "正在处理…";
    app.innerHTML = `${renderHeader()}${view}${ui.busy ? `<div class="busy-indicator"><span></span>${busyLabel}</div>` : ""}${ui.toast ? `<div class="toast toast-${ui.toast.tone}">${escapeHtml(ui.toast.message)}</div>` : ""}${renderModal()}`;
    if (ui.view === "queue" && currentArticle()) refreshPreview(currentArticle());
  }

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button, [data-article-id], [data-close-modal]");
    if (!target) return;
    if (target.matches("[data-close-modal]") && !target.matches("button") && event.target.closest(".modal")) return;
    if (target.matches("[data-view]")) {
      ui.view = target.dataset.view;
      render();
      return;
    }
    if (target.matches("[data-import]")) {
      await importSources();
      return;
    }
    if (target.matches("[data-publish]")) {
      await publishSelected();
      return;
    }
    if (target.matches("[data-article-id]")) {
      if (event.target.closest("[data-select-check]")) {
        const articleId = target.dataset.articleId;
        const article = state.queue.find((item) => item.id === articleId);
        if (!article || !isPublishable(article)) {
          ui.selectedIds.delete(articleId);
          render();
          return;
        }
        if (ui.selectedIds.has(articleId)) ui.selectedIds.delete(articleId);
        else ui.selectedIds.add(articleId);
        render();
        return;
      }
      ui.activeArticleId = target.dataset.articleId;
      render();
      return;
    }
    if (target.matches("[data-select-all]")) {
      const selectable = publishableArticles();
      if (selectedArticleIds().length === selectable.length) selectable.forEach((article) => ui.selectedIds.delete(article.id));
      else selectable.forEach((article) => ui.selectedIds.add(article.id));
      render();
      return;
    }
    if (target.matches("[data-open-source]")) {
      const article = currentArticle();
      if (article) {
        try {
          await api.openSourceFolder(article.sourcePath);
        } catch (error) {
          showToast(error.message || "无法打开源文件夹", "error");
        }
      }
      return;
    }
    if (target.matches("[data-remove-article]")) {
      const articleId = target.dataset.removeArticle;
      const previousQueue = state.queue;
      const previousActiveArticleId = ui.activeArticleId;
      const wasSelected = ui.selectedIds.has(articleId);
      state.queue = state.queue.filter((article) => article.id !== articleId);
      ui.selectedIds.delete(articleId);
      ui.activeArticleId = state.queue.some((article) => article.id === previousActiveArticleId) ? previousActiveArticleId : state.queue[0]?.id || null;
      try {
        await persistQueue();
      } catch (error) {
        state.queue = previousQueue;
        if (wasSelected) ui.selectedIds.add(articleId);
        ui.activeArticleId = previousActiveArticleId;
        showToast(error.message || "移出队列失败", "error");
      }
      render();
      return;
    }
    if (target.matches("[data-retry]")) {
      await retryHistory(target.dataset.retry);
      return;
    }
    if (target.matches("[data-test-connection]")) {
      await testConnection();
      return;
    }
    if (target.matches("[data-confirm-sources]")) {
      const paths = [...document.querySelectorAll("[data-source-choice]:checked")].map((input) => input.value);
      if (!paths.length) {
        showToast("至少选择一个 HTML 文件", "warning");
        return;
      }
      await inspectSelectedSources(paths);
      return;
    }
    if (target.matches("[data-close-modal]")) {
      ui.modal = null;
      render();
    }
  });

  document.addEventListener("change", async (event) => {
    const target = event.target;
    const article = currentArticle();
    if (!article) return;
    if (target.matches("[data-select-check]")) return;
    if (target.matches("[data-issue-toggle]")) {
      try {
        await toggleIssue(article, target.dataset.issueToggle, target.checked);
      } catch (error) {
        showToast(error.message || "保存资源处理结果失败", "error");
      }
      return;
    }
    if (target.matches("[data-field]")) {
      const value = target.type === "checkbox" ? target.checked : target.value;
      try {
        await updateArticleField(article, target.dataset.field, value);
      } catch (error) {
        showToast(error.message || "保存文章信息失败", "error");
        return;
      }
      render();
    }
  });

  document.addEventListener("submit", async (event) => {
    if (event.target.matches("[data-settings-form]")) {
      event.preventDefault();
      try {
        await saveSettings(event.target);
        render();
      } catch (error) {
        showToast(error.message || "保存设置失败", "error");
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.modal) {
      ui.modal = null;
      render();
    }
  });

  api.onPublishProgress((progress) => {
    ui.progress = { index: progress.index, total: progress.total, title: progress.title || "" };
    const article = state.queue.find((item) => item.id === progress.articleId);
    if (article) {
      article.status = progress.status;
      if (progress.status === "success") {
        article.draftMediaId = progress.mediaId;
        ui.selectedIds.delete(article.id);
      }
      if (progress.status === "failed") article.lastError = progress.error;
      render();
    }
  });

  api.getState().then((loadedState) => {
    state = loadedState;
    if (state.queue[0]) {
      ui.activeArticleId = state.queue[0].id;
      state.queue.filter((article) => article.status === "ready" || article.status === "queued" || article.status === "failed").forEach((article) => ui.selectedIds.add(article.id));
    }
    render();
    if (loadedState.loadWarning) showToast(loadedState.loadWarning, "warning");
  }).catch((error) => {
    showToast(error.message || "读取本地状态失败", "error");
  });
}());
