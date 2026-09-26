// BiliTaster content script —— 注入页面浮窗 + 抓取视频上下文
(function () {
  "use strict";
  if (window.__BILITASTER_LOADED__) return;
  window.__BILITASTER_LOADED__ = true;

  /* ============ 工具 ============ */
  function getBvidFromUrl() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
  }

  // 在页面上下文读取 __INITIAL_STATE__（content script 隔离环境读不到页面 window）
  function readPageState() {
    return new Promise((resolve) => {
      const evt = "bilitaster-state-" + Date.now();
      const script = document.createElement("script");
      script.textContent = "window.dispatchEvent(new CustomEvent('" + evt + "', { detail: JSON.stringify((window.__INITIAL_STATE__ && ({videoData: window.__INITIAL_STATE__.videoData, p: window.__INITIAL_STATE__.p, cid: window.__INITIAL_STATE__.cid})) || null) }));";
      (document.head || document.documentElement).appendChild(script);
      script.remove();
      const handler = (e) => {
        window.removeEventListener(evt, handler);
        try { resolve(JSON.parse(e.detail)); } catch (err) { resolve(null); }
      };
      window.addEventListener(evt, handler);
      setTimeout(() => resolve(null), 1000);
    });
  }
  async function getPageInfo() {
    const bvid = getBvidFromUrl();
    const info = {
      bvid, aid: null, cid: null,
      title: document.title.replace(/_哔哩哔哩.*$/, "").trim(),
      desc: "", duration: null, owner: "", url: location.href,
    };
    // 优先从页面状态补全
    const st = await readPageState();
    if (st && st.videoData) {
      const vd = st.videoData;
      info.aid = vd.aid || null;
      info.title = vd.title || info.title;
      info.desc = vd.desc || "";
      info.duration = vd.duration || null;
      info.owner = vd.owner ? vd.owner.name : "";
      if (st.p && Array.isArray(vd.pages)) {
        const page = vd.pages.find((x) => x.page === st.p);
        if (page) info.cid = page.cid;
      }
      if (!info.cid) info.cid = vd.cid || null;
    }
    // 兜底：用 bvid 调接口补 aid/cid/标题
    if (bvid && (!info.cid || !info.aid)) {
      try {
        const r = await biliFetch("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid);
        if (r.ok) {
          const d = JSON.parse(r.text);
          if (d && d.code === 0 && d.data) {
            info.aid = info.aid || d.data.aid;
            info.cid = info.cid || d.data.cid;
            info.title = info.title || d.data.title;
            info.desc = info.desc || d.data.desc;
            info.owner = info.owner || (d.data.owner && d.data.owner.name) || "";
            info.duration = info.duration || d.data.duration;
          }
        }
      } catch (e) {}
    }
    return info;
  }

  // Edge 109 的 chrome.storage 只支持回调，不支持 Promise
  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (v) => resolve(v || {}));
    });
  }
  function storageSet(obj) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  // 评论区（首页若干条热评）
  async function getComments(info) {
    if (!info.aid) return "";
    try {
      const api = "https://api.bilibili.com/x/v2/reply?type=1&oid=" + info.aid + "&sort=2&ps=20&pn=1";
      const r = await biliFetch(api);
      if (!r.ok) return "";
      const data = JSON.parse(r.text);
      const replies = (data && data.data && data.data.replies) || [];
      if (!replies.length) return "";
      return replies.map((rep) => {
        const msg = (rep.content && rep.content.message) || "";
        const like = rep.like || 0;
        return "[" + like + "赞] " + msg.replace(/\n/g, " ");
      }).join("\n");
    } catch (e) {
      return "";
    }
  }

  function biliFetch(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "BILI_FETCH", url }, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false });
      });
    });
  }

  // AI 请求也走 background，避免页面 CSP 拦截
  function aiFetch(url, headers, bodyObj) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "AI_FETCH", url, headers, body: JSON.stringify(bodyObj) },
        (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false });
        }
      );
    });
  }

  async function getSubtitles(info) {
    const domText = grabSubtitleFromDom();
    if (domText) return domText;
    if (!info.bvid || !info.cid) return "";
    try {
      const api = "https://api.bilibili.com/x/player/v2?bvid=" + info.bvid + "&cid=" + info.cid;
      const r1 = await biliFetch(api);
      if (!r1.ok) return "";
      const data = JSON.parse(r1.text);
      const tracks = (data && data.data && data.data.subtitle && data.data.subtitle.subtitles) || [];
      if (!tracks.length) return "";
      const track = tracks.find((t) => /zh|cn|ai/i.test(t.lan)) || tracks[0];
      let url = track.subtitle_url || track.url || "";
      if (url.startsWith("//")) url = "https:" + url;
      if (!url) return "";
      const r2 = await biliFetch(url);
      if (!r2.ok) return "";
      const body = JSON.parse(r2.text).body || [];
      return body.map((x) => x.content).join("\n");
    } catch (e) { return ""; }
  }

  function grabSubtitleFromDom() {
    const nodes = document.querySelectorAll(".bpx-player-subtitle-panel-text, .subtitle-item-text");
    if (!nodes.length) return "";
    return Array.from(nodes).map((n) => n.textContent.trim()).filter(Boolean).join("\n");
  }

  // 从 performance entries 里扒 bilivideo 的 m4s 直链（视频轨）
  function findVideoDirectUrl() {
    const names = performance.getEntriesByType("resource").map((e) => e.name);
    const cands = names.filter((n) => /bilivideo\.com\/upgcxcode/.test(n) && /\.m4s|mime_type=video/.test(n));
    if (!cands.length) return null;
    // 选最长的一条（通常带完整参数），去重后优先视频轨
    const uniq = Array.from(new Set(cands));
    const videoTrack = uniq.find((n) => /mime_type=video_mp4|30280|30232|30216|10002|10003|10004/.test(n));
    return videoTrack || uniq[0];
  }

  // 按时长分档决定帧数
  function frameCountByDuration(durationSec) {
    if (!durationSec || !isFinite(durationSec)) return 30;
    if (durationSec < 60) return 30;      // <1min
    if (durationSec < 180) return 36;     // 1-3min
    if (durationSec < 600) return 45;     // 3-10min
    if (durationSec < 1800) return 55;    // 10-30min
    return 60;                            // >30min
  }

  // 后台隐藏 video 抽帧，不影响正在观看的播放器
  // 返回 [{ dataUrl, time }]，已做空白帧过滤 + aHash 去重
  async function captureFrames(maxWidth) {
    maxWidth = maxWidth || 384;
    const v = document.querySelector("video");
    if (!v || !isFinite(v.duration) || v.duration <= 0) return [];

    const vw = v.videoWidth || maxWidth;
    const vh = v.videoHeight || Math.round(maxWidth * 0.5625);
    const scale = Math.min(1, maxWidth / vw);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext("2d");

    // aHash 用的小画布
    const hashCanvas = document.createElement("canvas");
    hashCanvas.width = 8; hashCanvas.height = 8;
    const hashCtx = hashCanvas.getContext("2d");

    const count = frameCountByDuration(v.duration);
    const times = [];
    for (let k = 0; k < count; k++) times.push((v.duration * (k + 0.5)) / count);

    const savedTime = v.currentTime;
    const savedPaused = v.paused;
    const frames = [];
    const seenHashes = [];
    for (const t of times) {
      try {
        await seekHidden(v, t);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL("image/jpeg", 0.6);
        if (await isBlankDataUrl(url)) continue;

        // aHash：灰度 8x8，与已有哈希比较
        hashCtx.drawImage(v, 0, 0, 8, 8);
        const px = hashCtx.getImageData(0, 0, 8, 8).data;
        const gray = [];
        let avg = 0;
        for (let i = 0; i < px.length; i += 4) {
          const g = (px[i] + px[i + 1] + px[i + 2]) / 3;
          gray.push(g); avg += g;
        }
        avg /= 64;
        let bits = "";
        for (let i = 0; i < 64; i++) bits += gray[i] >= avg ? "1" : "0";
        let dup = false;
        for (const h of seenHashes) {
          let dist = 0;
          for (let i = 0; i < 64; i++) if (bits[i] !== h[i]) dist++;
          if (dist < 5) { dup = true; break; }
        }
        if (dup) continue;
        seenHashes.push(bits);
        frames.push({ dataUrl: url, time: t });
      } catch (err) {}
    }
    // 恢复播放位置与状态
    try {
      v.currentTime = savedTime;
      if (!savedPaused) v.play().catch(() => {});
    } catch (err) {}
    return frames;
  }
  function waitEvent(el, type, timeout) {
    return new Promise((resolve, reject) => {
      let done = false;
      const ok = () => { if (done) return; done = true; cleanup(); resolve(); };
      const fail = () => { if (done) return; done = true; cleanup(); reject(new Error(type + " timeout")); };
      const cleanup = () => { el.removeEventListener(type, ok); clearTimeout(timer); };
      const timer = setTimeout(fail, timeout);
      el.addEventListener(type, ok);
    });
  }

  function isBlankDataUrl(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = 32; c.height = 18;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0, 32, 18);
          const d = cx.getImageData(0, 0, 32, 18).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i+1] + d[i+2];
          resolve(sum / (d.length / 4) / 3 < 8);
        } catch (e) { resolve(false); }
      };
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }

  function seekHidden(v, time) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        v.removeEventListener("seeked", onSeeked);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      };
      const onSeeked = () => {
        if (v.readyState >= 2) finish();
        else v.addEventListener("canplay", finish, { once: true });
      };
      v.addEventListener("seeked", onSeeked, { once: true });
      try { v.currentTime = time; } catch (e) { finish(); }
      setTimeout(finish, 2500);
    });
  }

  /* ============ AI 适配 ============ */
  function guessKind(base) { return /gemini/i.test(base) ? "gemini" : "openai"; }
  function normBase(b) { return (b || "").trim().replace(/\/+$/, ""); }

  async function callAI(cfg, messages) {
    if (cfg.kind === "gemini") return chatGemini(cfg, messages);
    return chatOpenAI(cfg, messages);
  }

  async function chatOpenAI(cfg, messages) {
    const r = await aiFetch(
      cfg.base + "/chat/completions",
      { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
      { model: cfg.model, messages, stream: false }
    );
    if (r.error) throw new Error("请求失败：" + r.error + " @ " + r.url);
    if (!r.ok) throw new Error("AI 接口错误 " + r.status + ": " + (r.text || "").slice(0, 300));
    const data = JSON.parse(r.text);
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "(空回复)";
  }

  async function chatGemini(cfg, messages) {
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const contents = messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: toGeminiParts(m.content),
    }));
    const body = { contents };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    const url = cfg.base + "/v1beta/models/" + cfg.model + ":generateContent?key=" + encodeURIComponent(cfg.apiKey);
    const r = await aiFetch(url, { "Content-Type": "application/json" }, body);
    if (r.error) throw new Error("请求失败：" + r.error);
    if (!r.ok) throw new Error("Gemini 接口错误 " + r.status + ": " + (r.text || "").slice(0, 300));
    const data = JSON.parse(r.text);
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    return parts.map((p) => p.text || "").join("") || "(空回复)";
  }

  function toGeminiParts(content) {
    if (typeof content === "string") return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: String(content) }];
    return content.map((c) => {
      if (c.type === "text") return { text: c.text };
      if (c.type === "image_url") {
        const url = (c.image_url && c.image_url.url) || "";
        const m = url.match(/^data:(.+?);base64,(.*)$/);
        if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
        return { text: "[图片] " + url };
      }
      return { text: "" };
    });
  }

  /* ============ 浮窗 UI ============ */
  const state = {
    cfg: null,
    history: [],
    videoContext: null,
    open: false,
    opts: { title: true, subtitle: true, frames: false, comments: false, owner: false },
  };

  function buildPanel() {
    const root = document.createElement("div");
    root.id = "bilitaster-root";
    root.innerHTML = [
      '<div class="bt-toggle" title="BiliTaster">🍭</div>',
      '<div class="bt-panel hidden">',
      '  <header class="bt-header"><span class="bt-brand">BiliTaster</span>',
      '    <div><button class="bt-icon" data-act="settings" title="设置">⚙</button>',
      '    <button class="bt-icon" data-act="close" title="关闭">✕</button></div>',
      '  </header>',
      '  <div class="bt-video"><div class="bt-vtitle">…</div><div class="bt-vmeta"></div>',
      '    <button class="bt-primary" data-act="summarize">总结视频</button></div>',
      '  <div class="bt-chat"></div>',
      '  <footer class="bt-composer"><textarea class="bt-input" rows="1" placeholder="就这个视频问点什么…"></textarea>',
      '    <button class="bt-primary" data-act="send">发送</button></footer>',
      '  <div class="bt-settings hidden">',
      '    <h3>设置</h3>',
      '    <label>Base URL<input class="bt-base" placeholder="https://api.openai.com/v1 或 Gemini 地址"></label>',
      '    <label>API Key<input class="bt-key" type="password" placeholder="sk-... 或 Gemini Key"></label>',
      '    <label>Model<input class="bt-model" placeholder="gpt-4o / gemini-2.0-flash"></label>',
      '    <div class="bt-opts">',
      '      <div class="bt-opts-title">允许读取的内容</div>',
      '      <label class="bt-check"><input type="checkbox" class="opt-title"> 标题 / 简介</label>',
      '      <label class="bt-check"><input type="checkbox" class="opt-subtitle"> 字幕</label>',
      '      <label class="bt-check"><input type="checkbox" class="opt-frames"> 画面帧（后台抽帧）</label>',
      '      <label class="bt-check"><input type="checkbox" class="opt-comments"> 评论区热评</label>',
      '      <label class="bt-check"><input type="checkbox" class="opt-owner"> UP主</label>',
      '    </div>',
      '    <div class="bt-srow"><button class="bt-primary" data-act="save">保存</button>',
      '      <button class="bt-ghost" data-act="back">返回</button>',
      '      <span class="bt-status"></span></div>',
      '  </div>',
      '</div>',
    ].join("");
    document.body.appendChild(root);

    const $ = (sel) => root.querySelector(sel);
    root.querySelector(".bt-toggle").onclick = () => togglePanel();
    $(".bt-header").addEventListener("click", async (e) => {
      const act = e.target.getAttribute("data-act");
      if (act === "settings") {
        const panel = $(".bt-settings");
        panel.classList.toggle("hidden");
        if (!panel.classList.contains("hidden")) await loadSettings();
      }
      if (act === "close") togglePanel(false);
    });
    $(".bt-video").addEventListener("click", (e) => {
      if (e.target.getAttribute("data-act") === "summarize") summarize();
    });
    $(".bt-composer").addEventListener("click", (e) => {
      if (e.target.getAttribute("data-act") === "send") send();
    });
    $(".bt-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $(".bt-settings").addEventListener("click", (e) => {
      const act = e.target.getAttribute("data-act");
      if (act === "save") saveSettings();
      if (act === "back") $(".bt-settings").classList.add("hidden");
    });
    return root;
  }

  function togglePanel(force) {
    state.open = typeof force === "boolean" ? force : !state.open;
    const panel = document.querySelector(".bt-panel");
    if (panel) panel.classList.toggle("hidden", !state.open);
    if (state.open) refreshInfo();
  }

  // 极简 Markdown 渲染（转义 HTML 后再处理常用语法）
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function renderMarkdown(text) {
    let h = escapeHtml(text);
    // 代码块
    h = h.replace(/```([\s\S]*?)```/g, (m, code) => "<pre><code>" + code.replace(/^\w*\n/, "") + "</code></pre>");
    // 行内代码
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    // 加粗 / 斜体
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // 标题
    h = h.replace(/^#{1,6}\s+(.*)$/gm, "<strong>$1</strong>");
    // 无序列表
    h = h.replace(/^\s*[-*]\s+(.*)$/gm, "<li>$1</li>");
    h = h.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
    // 有序列表
    h = h.replace(/^\s*\d+\.\s+(.*)$/gm, "<li>$1</li>");
    // 段落 / 换行
    h = h.replace(/\n{2,}/g, "</p><p>");
    h = h.replace(/\n/g, "<br>");
    return "<p>" + h + "</p>";
  }

  function addMsg(role, text, isMarkdown) {
    const chat = document.querySelector(".bt-chat");
    if (!chat) return null;
    const div = document.createElement("div");
    div.className = "bt-msg " + role;
    if (isMarkdown && role === "ai") {
      div.innerHTML = renderMarkdown(text);
    } else {
      div.textContent = text;
    }
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  async function refreshInfo() {
    const info = await getPageInfo();
    const t = document.querySelector(".bt-vtitle");
    const m = document.querySelector(".bt-vmeta");
    if (t) t.textContent = info.title || "(无标题)";
    if (m) m.textContent = [info.owner, info.bvid].filter(Boolean).join(" · ");
  }

  async function loadSettings() {
    const s = await storageGet(["baseUrl", "apiKey", "model", "opts"]);
    const base = normBase(s.baseUrl || "");
    state.cfg = base ? { kind: guessKind(base), base, apiKey: s.apiKey || "", model: s.model || "" } : null;
    if (s.opts) state.opts = Object.assign(state.opts, s.opts);
    const root = document.querySelector("#bilitaster-root");
    if (root) {
      root.querySelector(".bt-base").value = s.baseUrl || "";
      root.querySelector(".bt-key").value = s.apiKey || "";
      root.querySelector(".bt-model").value = s.model || "";
      root.querySelector(".opt-title").checked = !!state.opts.title;
      root.querySelector(".opt-subtitle").checked = !!state.opts.subtitle;
      root.querySelector(".opt-frames").checked = !!state.opts.frames;
      root.querySelector(".opt-comments").checked = !!state.opts.comments;
      root.querySelector(".opt-owner").checked = !!state.opts.owner;
    }
  }

  async function saveSettings() {
    const root = document.querySelector("#bilitaster-root");
    const baseUrl = normBase(root.querySelector(".bt-base").value);
    const apiKey = root.querySelector(".bt-key").value.trim();
    const model = root.querySelector(".bt-model").value.trim();
    const status = root.querySelector(".bt-status");
    const opts = {
      title: root.querySelector(".opt-title").checked,
      subtitle: root.querySelector(".opt-subtitle").checked,
      frames: root.querySelector(".opt-frames").checked,
      comments: root.querySelector(".opt-comments").checked,
      owner: root.querySelector(".opt-owner").checked,
    };
    try {
      await storageSet({ baseUrl, apiKey, model, opts });
      const back = await storageGet(["baseUrl", "apiKey", "model", "opts"]);
      if (back.baseUrl !== baseUrl) throw new Error("写入后回读不一致");
      state.cfg = { kind: guessKind(baseUrl), base: baseUrl, apiKey, model };
      state.opts = opts;
      status.textContent = "已保存 ✓";
      status.style.color = "#2a9d5c";
      setTimeout(() => { root.querySelector(".bt-settings").classList.add("hidden"); status.textContent = ""; }, 600);
    } catch (e) {
      status.textContent = "保存失败：" + (e && e.message || e);
      status.style.color = "#d94848";
    }
  }

  function buildVideoPrompt(ctx) {
    const info = ctx.info;
    const o = state.opts;
    const parts = ["请分析以下 B 站视频。", "链接：" + (info.url || "")];
    if (o.title) {
      parts.push("标题：" + (info.title || ""));
      parts.push("简介：" + (info.desc || "(无)"));
    }
    if (o.owner) parts.push("UP主：" + (info.owner || ""));
    parts.push("");
    if (o.subtitle && ctx.subtitle) {
      parts.push("【字幕/文字稿】");
      parts.push(ctx.subtitle.slice(0, 12000));
      parts.push("");
    }
    if (o.comments && ctx.comments) {
      parts.push("【评论区热评】");
      parts.push(ctx.comments.slice(0, 4000));
      parts.push("");
    }
    return parts.join("\n");
  }

  function buildUserContent(prompt, frames) {
    if (!frames || !frames.length) return prompt;
    // 硬上限 60 帧：超出则等间隔降采样
    const MAX_FRAMES = 60;
    if (frames.length > MAX_FRAMES) {
      const step = frames.length / MAX_FRAMES;
      const picked = [];
      for (let k = 0; k < MAX_FRAMES; k++) picked.push(frames[Math.floor(k * step)]);
      frames = picked;
    }
    const timesText = frames.map((f) => formatTime(f.time)).join(", ");
    const text = prompt +
      "\n\n（另附 " + frames.length + " 张按时间均匀抽取的视频画面帧，" +
      "时间点依次为：" + timesText + "。" +
      "这些是稀疏采样的单帧，不代表视频全部内容；画面之间的大量信息由字幕/文字稿承载，请勿仅凭个别帧推断全程状态。）";
    const content = [{ type: "text", text }];
    for (const f of frames) content.push({ type: "image_url", image_url: { url: f.dataUrl } });
    return content;
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return "?";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  async function ensureContext() {
    if (state.videoContext) return state.videoContext;
    const info = await getPageInfo();
    const o = state.opts;
    const tasks = [];
    if (o.subtitle) tasks.push("字幕");
    if (o.frames) tasks.push("画面");
    if (o.comments) tasks.push("评论");
    addMsg("sys", "正在抓取：" + (tasks.join("、") || "标题") + "…");

    async function safe(label, fn) {
      try { return await fn(); }
      catch (e) { addMsg("sys", label + "失败：" + (e && e.message || e)); return null; }
    }

    const subtitle = o.subtitle ? (await safe("字幕", () => getSubtitles(info))) || "" : "";
    const frames = o.frames ? (await safe("画面", () => captureFrames(384))) || [] : [];
    const comments = o.comments ? (await safe("评论", () => getComments(info))) || "" : "";

    const got = [];
    if (subtitle) got.push("字幕 " + subtitle.length + " 字");
    if (frames.length) got.push(frames.length + " 帧画面");
    if (comments) got.push("评论 " + comments.split("\n").length + " 条");
    addMsg("sys", "已获取：" + (got.join("，") || "仅标题/简介"));
    state.videoContext = { info, subtitle, frames, comments };
    return state.videoContext;
  }
  async function summarize() {
    if (!state.cfg) { document.querySelector(".bt-settings").classList.remove("hidden"); addMsg("sys", "请先完成设置"); return; }
    const btn = document.querySelector('[data-act="summarize"]');
    if (btn) { btn.disabled = true; btn.textContent = "处理中…"; }
    addMsg("user", "总结这个视频");
    try {
      const ctx = await ensureContext();
      const prompt = buildVideoPrompt(ctx);
      state.history = [
        { role: "system", content: "你是视频内容分析助手，用中文简明作答。" },
        { role: "user", content: buildUserContent(prompt, ctx.frames) },
      ];
      const reply = await callAI(state.cfg, state.history);
      state.history.push({ role: "assistant", content: reply });
      addMsg("ai", reply, true);
    } catch (e) {
      addMsg("sys", "❌ " + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "总结视频"; }
    }
  }

  async function send() {
    const input = document.querySelector(".bt-input");
    const text = input.value.trim();
    if (!text) return;
    if (!state.cfg) { document.querySelector(".bt-settings").classList.remove("hidden"); addMsg("sys", "请先完成设置"); return; }
    input.value = "";
    addMsg("user", text);
    if (state.history.length === 0) {
      const ctx = await ensureContext();
      const prompt = buildVideoPrompt(ctx);
      state.history = [
        { role: "system", content: "你是视频内容分析助手，用中文简明作答。" },
        { role: "user", content: buildUserContent(prompt, ctx.frames) },
        { role: "assistant", content: "好的，我已了解这个视频，请问你想了解什么？" },
      ];
    }
    state.history.push({ role: "user", content: text });
    const btn = document.querySelector('[data-act="send"]');
    if (btn) btn.disabled = true;
    const bubble = addMsg("ai", "…");
    try {
      const reply = await callAI(state.cfg, state.history);
      state.history.push({ role: "assistant", content: reply });
      bubble.innerHTML = renderMarkdown(reply);
    } catch (e) {
      bubble.textContent = "❌ " + e.message;
    } finally {
      if (btn) btn.disabled = false;
      const chat = document.querySelector(".bt-chat");
      if (chat) chat.scrollTop = chat.scrollHeight;
    }
  }

  /* ============ 启动 ============ */
  buildPanel();
  loadSettings();
  refreshInfo();
})();