"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const token = document.querySelector('meta[name="csrf-token"]')?.content || "";
  const controls = {
    discover: byId("discover-button"), save: byId("save-button"),
    preview: byId("preview-button"), toggle: byId("toggle-button"),
    sync: byId("sync-button"), retry: byId("retry-button"),
    recommend: byId("recommend-button"), clear: byId("clear-folders-button"),
    lookback: byId("lookback-days"), interval: byId("interval-minutes"),
    search: byId("folder-search"),
  };
  const activeStates = new Set(["queued", "running", "scanning", "syncing", "importing", "processing", "stopping"]);
  const stateLabels = {
    queued: "准备同步", running: "正在同步", scanning: "正在扫描", syncing: "正在同步",
    importing: "正在导入", processing: "正在处理", stopping: "正在暂停",
    paused: "已暂停", idle: "等待同步", ready: "等待同步",
    completed: "同步完成", complete: "同步完成", error: "同步出错",
    failed: "同步出错", account_changed: "账号已变化", blocked: "需要处理",
  };
  const reasonLabels = {
    "Candidate for Hindsight extraction": "待提取：由 Hindsight 判断是否保留记忆。",
    draft: "已跳过：草稿。",
    empty_or_courtesy: "已跳过：正文为空，或仅包含礼貌回复。",
    meeting_join_details: "已跳过：仅包含会议加入信息。",
    routine_monitor_notification: "已跳过：常规监控通知。",
  };
  const numberFormat = new Intl.NumberFormat("zh-CN");
  const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  let snapshot = null;
  let folders = [];
  let selected = new Set();
  let folderSignature = "";
  let dirty = false;
  let busy = false;
  let requestError = "";
  let connectionError = "";
  let statusController = null;
  let statusEpoch = 0;
  let pollTimer = null;
  const collapsed = new Set();

  function plainText(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
  }

  function errorText(value) {
    if (typeof value === "string") return value;
    if (value && typeof value.message === "string") return value.message;
    return "";
  }

  function isActive() {
    return activeStates.has(snapshot?.run?.state);
  }

  function folderIds(value) {
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  }

  function currentConfig() {
    const days = Number(controls.lookback.value);
    const minutes = Number(controls.interval.value);
    if (!controls.lookback.value || !Number.isSafeInteger(days) || days < 1 || days > 3650) {
      controls.lookback.focus();
      throw new Error("历史扫描范围需要填写 1 至 3650 的整数天数。");
    }
    if (!controls.interval.value || !Number.isSafeInteger(minutes) || minutes < 0 || minutes > 10080) {
      controls.interval.focus();
      throw new Error("同步间隔需要填写 0 至 10080 的整数分钟。");
    }
    if (!selected.size) throw new Error("请先选择至少一个邮件文件夹。");
    const available = new Set(folders.filter((folder) => !folder.excluded).map((folder) => folder.id));
    if ([...selected].some((id) => !available.has(id))) {
      throw new Error("已选文件夹中有项目无法读取，请重新读取邮箱文件夹并调整选择。");
    }
    return { folder_ids: [...selected], lookback_days: days, interval_minutes: minutes };
  }

  function updateDirty() {
    const saved = snapshot?.config;
    const savedIds = new Set(folderIds(saved?.folder_ids));
    dirty = !saved || !controls.lookback.value || !controls.interval.value || Number(controls.lookback.value) !== saved.lookback_days ||
      Number(controls.interval.value) !== saved.interval_minutes ||
      selected.size !== savedIds.size || [...selected].some((id) => !savedIds.has(id));
    byId("feedback").textContent = "";
    clearPreview();
    updateControls();
    renderWarnings();
  }

  function clearPreview() {
    byId("preview-panel").hidden = true;
    byId("preview-items").replaceChildren();
  }

  function updateControls() {
    const loaded = Boolean(snapshot);
    const connected = Boolean(snapshot?.account);
    const enabled = Boolean(snapshot?.config?.enabled);
    const canPause = enabled || isActive();
    const ready = loaded && connected && selected.size > 0;
    controls.discover.disabled = busy;
    controls.retry.disabled = busy;
    controls.lookback.disabled = !loaded || busy;
    controls.interval.disabled = !loaded || busy;
    controls.search.disabled = !folders.length;
    controls.recommend.disabled = busy || !folders.some((folder) => folder.recommended && !folder.excluded);
    controls.clear.disabled = busy || !selected.size;
    controls.save.disabled = busy || !loaded || !dirty;
    controls.preview.disabled = busy || !ready || isActive();
    controls.sync.disabled = busy || !ready || isActive();
    controls.toggle.disabled = busy || (!canPause && !ready) || snapshot?.run?.state === "stopping";
    controls.toggle.dataset.pausedAction = String(canPause);
    byId("toggle-label").textContent = canPause ? "暂停同步" : "开始同步";
    byId("toggle-icon").setAttribute("href", canPause ? "#icon-pause" : "#icon-play");
    byId("save-status").textContent = busy ? "正在处理，请稍候" : !loaded ? "尚未读取设置" : dirty ? "设置有改动，尚未保存" : "设置已保存";
    byId("save-dot").classList.toggle("dirty", dirty);
    byId("folder-count").textContent = `已选 ${numberFormat.format(selected.size)} 个`;
    document.querySelectorAll(".folder-label input").forEach((input) => { input.disabled = busy || input.dataset.excluded === "true"; });
    byId("config-form").setAttribute("aria-busy", String(busy));
  }

  function renderErrors() {
    const message = requestError || connectionError || errorText(snapshot?.run?.error);
    byId("error-text").textContent = message;
    byId("error-banner").hidden = !message;
  }

  function renderWarnings() {
    const warnings = Array.isArray(snapshot?.warnings) ? snapshot.warnings.filter((item) => typeof item === "string") : [];
    const available = new Set(folders.map((folder) => folder.id));
    const missing = [...selected].filter((id) => !available.has(id));
    if (missing.length) warnings.push(`有 ${missing.length} 个已选文件夹无法读取。请重新读取文件夹，或清空选择后重新勾选。`);
    const excludedIds = new Set(folders.filter((folder) => folder.excluded).map((folder) => folder.id));
    if (folderIds(snapshot?.config?.folder_ids).some((id) => excludedIds.has(id))) warnings.push("已移除排除范围内的选择，请保存设置。");
    byId("warning-text").textContent = warnings.join("\n");
    byId("warning-banner").hidden = !warnings.length;
  }

  function renderTime(id, value, fallback) {
    const element = byId(id);
    const date = typeof value === "string" ? new Date(value) : null;
    const valid = date && !Number.isNaN(date.getTime());
    element.textContent = valid ? dateFormat.format(date) : fallback;
    if (valid) {
      element.dateTime = date.toISOString();
      element.title = date.toLocaleString("zh-CN");
    } else {
      element.removeAttribute("datetime");
      element.removeAttribute("title");
    }
  }

  function renderStatus() {
    const account = snapshot.account;
    byId("account-address").textContent = account ? plainText(account.address, "当前 WorkIQ 账号") : "点击“读取邮箱文件夹”，连接当前 WorkIQ 账号。";
    byId("account-name").textContent = plainText(account?.name);
    byId("account-name").hidden = !account?.name || account.name === account.address;
    controls.discover.querySelector("span").textContent = folders.length ? "刷新文件夹" : "读取邮箱文件夹";
    const run = snapshot.run || {};
    const runState = plainText(run.state);
    const failed = ["error", "failed", "blocked", "account_changed"].includes(runState) || Boolean(run.error);
    let label = stateLabels[runState] || "等待同步";
    let tone = isActive() ? "active" : failed ? "error" : snapshot.config?.enabled ? "positive" : "neutral";
    if (!account) { label = "尚未连接"; tone = "neutral"; }
    else if (!isActive() && !failed && !snapshot.config?.enabled) label = "已暂停";
    else if (!isActive() && !failed && snapshot.config?.interval_minutes === 0) label = "手动同步";
    byId("status-label").textContent = label;
    byId("status-badge").dataset.tone = tone;
    for (const key of ["scanned", "imported", "skipped", "failed", "pending"]) {
      const value = run[key];
      byId(`stat-${key}`).textContent = Number.isFinite(value) && value >= 0 ? numberFormat.format(value) : "0";
    }
    byId("stat-failed").classList.toggle("has-failures", run.failed > 0);
    renderTime("last-success", run.last_success, "尚未完成同步");
    renderTime("next-run", run.next_run, snapshot.config?.enabled ? (snapshot.config?.interval_minutes === 0 ? "手动同步" : "等待安排") : "已暂停");
    let hindsightUrl = null;
    try {
      const url = new URL(snapshot.hindsight_url);
      if (["http:", "https:"].includes(url.protocol)) hindsightUrl = url.href;
    } catch { /* An unavailable link should not prevent configuration. */ }
    for (const id of ["hindsight-link", "sidebar-hindsight"]) {
      const link = byId(id);
      link.hidden = !hindsightUrl;
      if (hindsightUrl) link.href = hindsightUrl;
      else link.removeAttribute("href");
    }
    byId("connection-status").textContent = "已连接本地服务 · 每 5 秒更新";
    renderErrors();
    renderWarnings();
    updateControls();
  }

  function applyStatus(data, acceptConfig = false) {
    if (!data || typeof data !== "object" || !data.config || !Array.isArray(data.folders)) {
      throw new Error("本地服务返回的状态格式不正确，请刷新重试。");
    }
    const previousAccount = snapshot?.account?.address;
    const accountChanged = previousAccount && data.account?.address && previousAccount !== data.account.address;
    if (accountChanged) clearPreview();
    const replaceConfig = !snapshot || !dirty || acceptConfig || accountChanged;
    snapshot = data;
    const seen = new Set();
    folders = data.folders.filter((folder) => {
      if (!folder || typeof folder.id !== "string" || seen.has(folder.id)) return false;
      seen.add(folder.id);
      return true;
    });
    const signature = JSON.stringify(folders);
    let selectionChanged = false;
    if (replaceConfig) {
      const excludedIds = new Set(folders.filter((folder) => folder.excluded).map((folder) => folder.id));
      const incoming = new Set(folderIds(data.config.folder_ids).filter((id) => !excludedIds.has(id)));
      selectionChanged = incoming.size !== selected.size || [...incoming].some((id) => !selected.has(id));
      selected = incoming;
      controls.lookback.value = data.config.lookback_days ?? 7;
      controls.interval.value = data.config.interval_minutes ?? 60;
      dirty = incoming.size !== new Set(folderIds(data.config.folder_ids)).size;
    }
    for (const folder of folders) {
      if (folder.excluded && selected.delete(folder.id)) dirty = true;
    }
    if (signature !== folderSignature || selectionChanged || !treeHasState()) {
      folderSignature = signature;
      renderFolders();
    }
    renderStatus();
  }

  function treeHasState() {
    return byId("folder-container").getAttribute("aria-busy") === "false";
  }

  function renderFolders() {
    const tree = byId("folder-tree");
    const fragment = document.createDocumentFragment();
    const byFolderId = new Map(folders.map((folder) => [folder.id, folder]));
    const children = new Map();
    const roots = [];
    const query = controls.search.value.trim().toLocaleLowerCase();
    const visited = new Set();
    let matches = 0;
    for (const folder of folders) {
      if (folder.parent_id && folder.parent_id !== folder.id && byFolderId.has(folder.parent_id)) {
        if (!children.has(folder.parent_id)) children.set(folder.parent_id, []);
        children.get(folder.parent_id).push(folder);
      } else roots.push(folder);
    }
    const prioritized = new Set();
    for (const folder of folders) {
      if (!selected.has(folder.id) && !folder.recommended) continue;
      let current = folder;
      while (current && !prioritized.has(current.id)) {
        prioritized.add(current.id);
        current = byFolderId.get(current.parent_id);
      }
    }
    const prioritize = (a, b) => Number(prioritized.has(b.id)) - Number(prioritized.has(a.id));
    roots.sort(prioritize);
    children.forEach((group) => group.sort(prioritize));

    function makeFolder(folder) {
      if (visited.has(folder.id)) return null;
      visited.add(folder.id);
      const childElements = (children.get(folder.id) || []).map(makeFolder).filter(Boolean);
      const path = plainText(folder.path, plainText(folder.name));
      if (query && !`${folder.name || ""} ${path}`.toLocaleLowerCase().includes(query) && !childElements.length) return null;
      matches += 1;
      const item = document.createElement("li");
      const row = document.createElement("div");
      row.className = "folder-row";
      row.classList.toggle("selected", selected.has(folder.id));
      let group = null;
      if (childElements.length) {
        group = document.createElement("ul");
        group.className = "folder-children";
        group.append(...childElements);
        group.hidden = !query && collapsed.has(folder.id);
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "folder-toggle";
        toggle.setAttribute("aria-label", `${plainText(folder.name, "文件夹")}的子文件夹`);
        toggle.setAttribute("aria-expanded", String(!group.hidden));
        toggle.addEventListener("click", () => {
          group.hidden = !group.hidden;
          toggle.setAttribute("aria-expanded", String(!group.hidden));
          if (group.hidden) collapsed.add(folder.id);
          else collapsed.delete(folder.id);
        });
        row.append(toggle);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "folder-spacer";
        row.append(spacer);
      }
      const label = document.createElement("label");
      label.className = "folder-label";
      label.title = path;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(folder.id);
      input.dataset.excluded = String(Boolean(folder.excluded));
      input.disabled = busy || Boolean(folder.excluded);
      input.setAttribute("aria-label", path || plainText(folder.name, "未命名文件夹"));
      input.addEventListener("change", () => {
        if (input.checked) selected.add(folder.id);
        else selected.delete(folder.id);
        row.classList.toggle("selected", input.checked);
        updateDirty();
      });
      const name = document.createElement("span");
      name.className = "folder-name";
      name.textContent = plainText(folder.name, "未命名文件夹");
      label.append(input, name);
      row.append(label);
      if (folder.recommended || folder.excluded) {
        const tag = document.createElement("span");
        tag.className = folder.excluded ? "folder-excluded" : "folder-recommended";
        tag.textContent = folder.excluded ? "已排除" : "建议";
        row.append(tag);
      }
      item.append(row);
      if (group) item.append(group);
      return item;
    }

    for (const folder of roots) {
      const element = makeFolder(folder);
      if (element) fragment.append(element);
    }
    // Invalid parent links must not make real folders disappear.
    for (const folder of folders) {
      if (!visited.has(folder.id)) {
        const element = makeFolder(folder);
        if (element) fragment.append(element);
      }
    }
    tree.replaceChildren(fragment);
    byId("folder-empty").hidden = matches > 0;
    byId("folder-empty").textContent = folders.length ? "没有找到匹配的文件夹。" : "还没有文件夹。点击“读取邮箱文件夹”后选择同步范围。";
    byId("folder-container").setAttribute("aria-busy", "false");
    byId("folder-hint").textContent = folders.length ? `共 ${numberFormat.format(folders.length)} 个文件夹 · 已选项会单独扫描` : "建议范围会根据实际邮箱匹配。";
  }

  async function request(path, { method = "GET", body, signal, timeout = 30000 } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const headers = { Accept: "application/json" };
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
        headers["X-ProvenLoop-Token"] = token;
      }
      const response = await fetch(path, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined, signal: controller.signal, credentials: "same-origin", cache: "no-store" });
      let data;
      try { data = await response.json(); } catch { throw new Error(`本地服务返回了无法读取的响应（HTTP ${response.status}）。`); }
      if (!response.ok) throw new Error(errorText(data?.error) || errorText(data?.detail) || `请求未完成（HTTP ${response.status}）。`);
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        if (signal?.aborted) throw error;
        throw new Error("请求超时。操作可能仍在运行，请刷新状态后再试。");
      }
      if (error instanceof TypeError) throw new Error("无法连接本地服务。请确认 ProvenLoop 连接服务仍在运行，再刷新状态。");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!document.hidden) pollTimer = setTimeout(refreshStatus, 5000);
  }

  async function refreshStatus() {
    if (busy || statusController) { schedulePoll(); return; }
    const controller = new AbortController();
    statusController = controller;
    const epoch = statusEpoch;
    try {
      const data = await request("/api/status", { signal: controller.signal, timeout: 15000 });
      if (epoch !== statusEpoch) return;
      applyStatus(data);
      connectionError = "";
      renderErrors();
    } catch (error) {
      if (error.name !== "AbortError" && epoch === statusEpoch) {
        connectionError = error.message;
        renderErrors();
        byId("connection-status").textContent = "状态更新失败 · 将自动重试";
        if (!snapshot) {
          byId("status-label").textContent = "服务未连接";
          byId("status-badge").dataset.tone = "error";
          byId("account-address").textContent = "尚未读取账号";
          renderFolders();
        }
        updateControls();
      }
    } finally {
      if (statusController === controller) statusController = null;
      schedulePoll();
    }
  }

  async function saveIfNeeded() {
    const config = currentConfig();
    if (!dirty) return;
    const data = await request("/api/config", { method: "POST", body: config });
    applyStatus(data, true);
  }

  async function perform(button, action) {
    if (busy) return;
    busy = true;
    statusEpoch += 1;
    statusController?.abort();
    clearTimeout(pollTimer);
    requestError = "";
    byId("feedback").textContent = "";
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    updateControls();
    renderErrors();
    try {
      await action();
    } catch (error) {
      requestError = error.message || "操作未完成，请重试。";
      renderErrors();
      byId("error-banner").focus({ preventScroll: true });
      byId("error-banner").scrollIntoView({ block: "center" });
    } finally {
      busy = false;
      button.classList.remove("is-loading");
      button.removeAttribute("aria-busy");
      updateControls();
      schedulePoll();
    }
  }

  function renderPreview(data) {
    if (!data || !Array.isArray(data.items)) throw new Error("本地服务返回的预览格式不正确，请重试。");
    const container = byId("preview-items");
    const fragment = document.createDocumentFragment();
    data.items.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const detail = document.createElement("details");
      detail.className = "preview-item";
      detail.open = index === 0;
      const summary = document.createElement("summary");
      const number = document.createElement("span");
      number.className = "preview-index";
      number.textContent = String(index + 1).padStart(2, "0");
      const title = document.createElement("span");
      title.textContent = plainText(item.subject, "无主题邮件");
      summary.append(number, title);
      detail.append(summary);
      if (item.reason) {
        const reason = document.createElement("p");
        reason.className = "preview-reason";
        reason.textContent = reasonLabels[item.reason] || plainText(item.reason);
        detail.append(reason);
      }
      const columns = document.createElement("div");
      columns.className = "preview-columns";
      for (const [key, label] of [["source", "来源正文"], ["cleaned", "清理后的正文"]]) {
        const column = document.createElement("section");
        column.className = "preview-column";
        const heading = document.createElement("h3");
        heading.textContent = label;
        const text = document.createElement("pre");
        text.tabIndex = 0;
        text.setAttribute("aria-label", label);
        text.textContent = plainText(item[key]) || (key === "cleaned" ? "没有保留正文。" : "没有可预览的正文。");
        column.append(heading, text);
        columns.append(column);
      }
      detail.append(columns);
      fragment.append(detail);
    });
    container.replaceChildren(fragment);
    if (!data.items.length) {
      const empty = document.createElement("p");
      empty.className = "preview-empty";
      empty.textContent = "当前范围内没有可预览的邮件。可调整文件夹或历史扫描范围后重试。";
      container.append(empty);
    }
    byId("preview-count").textContent = `${data.items.length} 封样本`;
    byId("preview-panel").hidden = false;
    byId("preview-panel").focus({ preventScroll: true });
    byId("preview-panel").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  }

  byId("config-form").addEventListener("submit", (event) => {
    event.preventDefault();
    perform(controls.save, async () => { await saveIfNeeded(); byId("feedback").textContent = "设置已保存。"; });
  });
  controls.discover.addEventListener("click", () => perform(controls.discover, async () => {
    const data = await request("/api/discover", { method: "POST", timeout: 180000 });
    applyStatus(data);
    byId("feedback").textContent = "邮箱文件夹已更新。";
  }));
  controls.preview.addEventListener("click", () => perform(controls.preview, async () => {
    await saveIfNeeded();
    const data = await request("/api/preview", { method: "POST", timeout: 180000 });
    renderPreview(data);
    byId("feedback").textContent = "预览已生成，未写入记忆。";
  }));
  controls.toggle.addEventListener("click", () => perform(controls.toggle, async () => {
    const pause = Boolean(snapshot?.config?.enabled) || isActive();
    if (!pause) await saveIfNeeded();
    const data = await request(pause ? "/api/pause" : "/api/start", { method: "POST" });
    applyStatus(data);
    byId("feedback").textContent = pause ? "已请求暂停同步。" : "已开始同步，可在下方查看进度。";
  }));
  controls.sync.addEventListener("click", () => perform(controls.sync, async () => {
    await saveIfNeeded();
    const data = await request("/api/sync", { method: "POST" });
    applyStatus(data);
    byId("feedback").textContent = "已请求同步，可在下方查看进度。";
  }));
  controls.retry.addEventListener("click", () => { requestError = ""; refreshStatus(); });
  controls.search.addEventListener("input", renderFolders);
  controls.lookback.addEventListener("input", updateDirty);
  controls.interval.addEventListener("input", updateDirty);
  controls.recommend.addEventListener("click", () => {
    selected = new Set(folders.filter((folder) => folder.recommended && !folder.excluded).map((folder) => folder.id));
    renderFolders();
    updateDirty();
  });
  controls.clear.addEventListener("click", () => { selected.clear(); renderFolders(); updateDirty(); });
  byId("close-preview-button").addEventListener("click", () => { clearPreview(); controls.preview.focus(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(pollTimer);
    else refreshStatus();
  });
  window.addEventListener("pagehide", () => { clearTimeout(pollTimer); statusController?.abort(); });
  refreshStatus();
})();
