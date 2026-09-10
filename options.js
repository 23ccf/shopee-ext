// options.js — GitHub 配置 + 自建后端配置
'use strict';

const els = {
  // 后端模式
  useBackend: document.getElementById('useBackend'),
  backendUrl: document.getElementById('backendUrl'),
  backendUsername: document.getElementById('backendUsername'),
  backendPassword: document.getElementById('backendPassword'),
  backendFields: document.getElementById('backendFields'),
  // GitHub
  token: document.getElementById('token'),
  owner: document.getElementById('owner'),
  repo: document.getElementById('repo'),
  branch: document.getElementById('branch'),
  catalogPath: document.getElementById('catalogPath'),
  syncPath: document.getElementById('syncPath'),
  githubFields: document.getElementById('githubFields'),
  // Gitee
  giteeEnabled: document.getElementById('giteeEnabled'),
  giteeOwner: document.getElementById('giteeOwner'),
  giteeRepo: document.getElementById('giteeRepo'),
  giteeBranch: document.getElementById('giteeBranch'),
  giteeToken: document.getElementById('giteeToken'),
  giteeCatalogPath: document.getElementById('giteeCatalogPath'),
  giteeSyncPath: document.getElementById('giteeSyncPath'),
  msg: document.getElementById('msg'),
};

function setMsg(t, cls) { els.msg.textContent = t; els.msg.className = cls || ''; }

function toggleUi() {
  const useB = !!els.useBackend.checked;
  els.backendFields.style.display = useB ? 'block' : 'none';
  els.githubFields.style.display = useB ? 'none' : 'block';
}

async function load() {
  const s = await chrome.storage.local.get(['cfg', 'giteeCfg', 'backend']);
  const cfg = s.cfg || {};
  const backend = s.backend || {};
  els.useBackend.checked = !!backend.enabled;
  els.backendUrl.value = backend.url || '';   // 不再预填任何地址：未填 = 保持 GitHub 模式
  els.backendUsername.value = backend.username || '';
  els.backendPassword.value = backend.password || '';
  // GitHub
  els.token.value = cfg.token || '';
  els.owner.value = cfg.owner || '23ccf';
  els.repo.value = cfg.repo || 'shopee-sync';
  els.branch.value = cfg.branch || 'main';
  els.catalogPath.value = cfg.catalogPath || 'catalog.json';
  els.syncPath.value = cfg.syncPath || 'sync.json';
  // Gitee
  const g = s.giteeCfg || {};
  els.giteeEnabled.checked = !!g.enabled;
  els.giteeOwner.value = g.owner || '';
  els.giteeRepo.value = g.repo || 'shopee-sync';
  els.giteeBranch.value = g.branch || 'master';
  els.giteeToken.value = g.token || '';
  els.giteeCatalogPath.value = g.catalogPath || 'catalog.json';
  els.giteeSyncPath.value = g.syncPath || 'sync.json';
  toggleUi();
}

els.useBackend.addEventListener('change', toggleUi);

document.getElementById('saveBtn').addEventListener('click', async () => {
  const useB = !!els.useBackend.checked;
  const backend = {
    enabled: useB,
    url: els.backendUrl.value.trim().replace(/\/$/, ''),   // 留空 = 不启用后端（保持 GitHub 模式）
    username: els.backendUsername.value.trim(),
    password: els.backendPassword.value,
  };
  if (useB && !backend.url) {
    setMsg('使用后端模式需填写后端地址（如 https://your-backend.example.com）', 'err'); return;
  }
  if (useB && (!backend.username || !backend.password)) {
    setMsg('使用后端模式需填写用户名和密码', 'err'); return;
  }
  if (useB) {
    // 保存前先登录后端，验证账号密码。
    // ★ 必须带超时：代理环境下请求可能永久挂起，会导致设置页「一直转圈」卡死。
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let r, d;
      try {
        r = await fetch(backend.url + '/api/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: backend.username, password: backend.password }),
          signal: ctrl.signal,
        });
        d = await r.json();
      } finally { clearTimeout(timer); }
      if (!d.ok) { setMsg('后端登录失败：' + (d.error || '未知'), 'err'); return; }
      backend.token = d.token;
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
      setMsg(aborted ? '后端无响应（8 秒超时）：请检查地址，或改用 GitHub 模式' : ('后端登录失败：' + e.message), 'err');
      return;
    }
  }

  const cfg = {
    token: els.token.value.trim(),
    owner: els.owner.value.trim() || '23ccf',
    repo: els.repo.value.trim() || 'shopee-sync',
    branch: els.branch.value.trim() || 'main',
    catalogPath: els.catalogPath.value.trim() || 'catalog.json',
    syncPath: els.syncPath.value.trim() || 'sync.json',
  };
  if (!useB && !cfg.token) { setMsg('GitHub 模式需填写 GitHub Token', 'err'); return; }
  const giteeCfg = {
    enabled: !!els.giteeEnabled.checked,
    owner: els.giteeOwner.value.trim(),
    repo: els.giteeRepo.value.trim() || 'shopee-sync',
    branch: els.giteeBranch.value.trim() || 'master',
    token: els.giteeToken.value.trim(),
    catalogPath: els.giteeCatalogPath.value.trim() || 'catalog.json',
    syncPath: els.giteeSyncPath.value.trim() || 'sync.json',
  };
  if (giteeCfg.enabled && (!giteeCfg.token || !giteeCfg.owner || !giteeCfg.repo)) {
    setMsg('启用 Gitee 需填写 用户名 / 仓库名 / 私人令牌', 'err');
    return;
  }
  await chrome.storage.local.set({ cfg, giteeCfg, backend });
  setMsg(useB ? '✓ 后端配置已保存并登录成功' : '✓ 已保存（GitHub + Gitee 镜像）', 'ok');
});

// 清空待同步队列（清掉本地未推送的录制，已上 GitHub 的商品不受影响）
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('确定清空待同步队列？\n（已同步到后端的商品不受影响，仅清除本机尚未推送的录制）')) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'clearPending' });
    if (r && r.ok) setMsg('✓ 待同步队列已清空', 'ok');
    else setMsg('清空失败：' + ((r && r.error) || '未知错误'), 'err');
  } catch (e) {
    setMsg('清空失败：' + e.message, 'err');
  }
});

load();
