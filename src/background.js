// BiliTaster background —— 代理请求（绕 CORS / CSP / Referer 限制）
function doFetch(url, options) {
  return fetch(url, options).then(async (resp) => {
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  }).catch((e) => ({ ok: false, error: String((e && e.message) || e), url }));
}

// 抓取视频分片，返回 base64（dataURL）
// 只抓视频头部一段（带 Referer），返回 dataURL，避免下载整片
function fetchVideoDataUrl(url, maxBytes) {
  maxBytes = maxBytes || 3000000;
  const headers = {
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Range": "bytes=0-" + maxBytes,
  };
  return fetch(url, { headers })
    .then(async (resp) => {
      if (!resp.ok && resp.status !== 206) return { ok: false, status: resp.status, error: "HTTP " + resp.status };
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(binary);
      return { ok: true, dataUrl: "data:video/mp4;base64," + b64, size: bytes.length };
    })
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "BILI_FETCH") {
    doFetch(msg.url, { credentials: "include", headers: msg.headers || {} }).then(sendResponse);
    return true;
  }
  if (msg.type === "AI_FETCH") {
    doFetch(msg.url, { method: "POST", headers: msg.headers || {}, body: msg.body }).then(sendResponse);
    return true;
  }
  if (msg.type === "BILI_VIDEO_BLOB") {
    fetchVideoDataUrl(msg.url).then(sendResponse);
    return true;
  }
});
