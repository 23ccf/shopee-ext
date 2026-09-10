// mock_chrome.js — 供截图脚本注入，模拟扩展环境让 popup/options 正常渲染
window.chrome = {
  runtime: {
    sendMessage: (msg) => {
      if (msg && msg.type === 'getState') {
        return Promise.resolve({
          recording: true,
          pending: { a: 1, b: 2, c: 3 },
          lastSync: { ok: true, ts: Date.now() - 3600000, added: 5 },
          giteeCfg: {},
          lastGiteeSync: null
        });
      }
      if (msg && msg.type === 'setRecording') return Promise.resolve({ ok: true });
      if (msg && msg.type === 'manualSync') return Promise.resolve({ ok: true, added: 3, total: 414 });
      if (msg && msg.type === 'clearPending') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    },
    getURL: (p) => 'file:///C:/Users/1/shopee_ext/' + p,
    openOptionsPage: () => {},
    lastError: null
  },
  storage: {
    local: {
      get: (keys) => {
        const o = {};
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) {
          if (k === 'browseCapture') o[k] = true;
          else if (k === 'cfg') o[k] = { token: '', owner: '23ccf', repo: 'shopee-sync', branch: 'main', catalogPath: 'catalog.json', syncPath: 'sync.json' };
          else if (k === 'giteeCfg') o[k] = { enabled: false, owner: '', repo: 'shopee-sync', branch: 'master', token: '', catalogPath: 'catalog.json', syncPath: 'sync.json' };
          else if (k === 'backend') o[k] = { enabled: false, url: '', username: '', password: '' };
        }
        return Promise.resolve(o);
      },
      set: () => Promise.resolve()
    }
  },
  tabs: { create: (o, cb) => { if (cb) cb(); } }
};
