// 主世界(MAIN)脚本：把扩展 id 设置到页面的 window.__SHOPEE_RECORDER__ 上。
// 配合 bridge.js(isolated) 使用。
//
// 关键：Chrome 不保证 isolated 与 MAIN 两个 world 的执行顺序，
// 本脚本可能在 bridge.js 写 DOM 属性「之前」就跑完，此时必须轮询等待。
(function () {
  'use strict';
  try {
    const el = document.documentElement;
    if (!el) return;

    function trySet() {
      let id = el.getAttribute('data-shopee-recorder-id');
      if (!id) return false;
      const ver = el.getAttribute('data-shopee-recorder-version') || '?';
      // 已注入过就不再覆盖（避免重复工作）
      if (window.__SHOPEE_RECORDER__ && window.__SHOPEE_RECORDER__.id === id) return true;
      window.__SHOPEE_RECORDER__ = {
        id: id,
        version: ver,
        bridge: 1,
        ready: true,
      };
      return true;
    }

    // 先立刻试一次
    if (trySet()) return;

    // 监听属性变化（isolated 脚本写入时立刻触发）
    try {
      new MutationObserver(function () { trySet(); }).observe(el, { attributes: true });
    } catch (e) {}

    // 轮询兜底（最多约 3 秒），防止 MutationObserver 未覆盖到的时序
    let tries = 0;
    const t = setInterval(function () {
      if (trySet() || ++tries > 60) clearInterval(t);
    }, 50);

    // 再监听 isolated 脚本广播的事件
    try {
      window.addEventListener('shopee-recorder-bridge', function (ev) {
        const d = ev && ev.detail;
        if (d && d.id) {
          window.__SHOPEE_RECORDER__ = { id: d.id, version: d.version || '?', bridge: 1, ready: true };
          clearInterval(t);
        }
      });
    } catch (e) {}
  } catch (e) {}
})();
