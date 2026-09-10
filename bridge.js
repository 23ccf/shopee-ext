// 隔离世界(ISOLATED)脚本：唯一能用 chrome.* API 的地方。
// 目的：把扩展 id 送到页面的主世界(window)。
//
// 为什么需要这个：MV3 内容脚本默认在 isolated world，它的 window 与页面主世界隔离，
// 直接 `window.__SHOPEE_RECORDER__ = ...` 页面根本看不到。
//
// 多重兜底（消除 isolated / MAIN 两个 world 之间的执行顺序竞态——Chrome 不保证它们的先后顺序）：
//   ① 写 documentElement 的 data-* 属性（供 bridge_main.js 读取，含轮询兜底）
//   ② 直接向页面注入 <script> 在主世界执行赋值（最可靠；若站点有 CSP 限制会失败，但被 try/catch 吞掉）
//   ③ 通过 window.dispatchEvent 广播（再保险）
//   ④ 在 document 各阶段（start / interactive / complete / load）重复尝试
(function () {
  'use strict';
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  const id = chrome.runtime.id;
  let ver = '?';
  try { const m = chrome.runtime.getManifest && chrome.runtime.getManifest(); if (m && m.version) ver = m.version; } catch (e) {}

  function tryInject() {
    // ① 写 DOM 属性（供 MAIN world 的 bridge_main.js 读取）
    try {
      const el = document.documentElement || document.head || document.body;
      if (el && el.setAttribute) {
        el.setAttribute('data-shopee-recorder-id', id);
        el.setAttribute('data-shopee-recorder-version', ver);
        el.setAttribute('data-shopee-recorder-bridge', '1');
      }
    } catch (e) {}

    // ② 注入脚本到页面主世界（绕过 world 隔离，最直接）
    try {
      const payload = JSON.stringify({ id: id, version: ver, bridge: 1, ready: true });
      const s = document.createElement('script');
      s.textContent = 'window.__SHOPEE_RECORDER__=' + payload + ';' +
        '(function(){var e=document.documentElement||document.head||document.body;if(e&&e.setAttribute){e.setAttribute("data-shopee-recorder-id",' + JSON.stringify(id) + ');e.setAttribute("data-shopee-recorder-version",' + JSON.stringify(ver) + ');e.setAttribute("data-shopee-recorder-bridge","1");}})();';
      const parent = document.head || document.documentElement || document.body;
      if (parent) {
        parent.appendChild(s);
        if (s.parentNode) s.parentNode.removeChild(s);
      }
    } catch (e) {}

    // ③ 事件广播（再保险一层）
    try {
      window.dispatchEvent(new CustomEvent('shopee-recorder-bridge', { detail: { id: id, version: ver } }));
    } catch (e) {}
  }

  // 立即尝试一次
  tryInject();

  // 文档状态变化时再次尝试
  function onReadyState() {
    if (document.readyState === 'interactive' || document.readyState === 'complete') tryInject();
  }
  try {
    document.addEventListener('readystatechange', onReadyState);
  } catch (e) {}

  // load 后再来一次（页面脚本可能覆盖 window.__SHOPEE_RECORDER__）
  try {
    if (window.addEventListener) {
      window.addEventListener('load', tryInject);
    }
  } catch (e) {}

  // 轮询兜底：持续约 3 秒，确保不会漏掉
  let tries = 0;
  const t = setInterval(function () {
    tryInject();
    if (++tries > 30) clearInterval(t);
  }, 100);
})();
