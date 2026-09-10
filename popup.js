// popup.js — 录制开关面板
'use strict';

const recToggle = document.getElementById('recToggle');
const browseToggle = document.getElementById('browseToggle');
const stateText = document.getElementById('stateText');
const pendingCount = document.getElementById('pendingCount');
const lastSync = document.getElementById('lastSync');
const lastGitee = document.getElementById('lastGitee');
const syncBtn = document.getElementById('syncBtn');
const setBtn = document.getElementById('setBtn');
const clearBtn = document.getElementById('clearBtn');
const msg = document.getElementById('msg');

function setMsg(text, cls) {
  msg.textContent = text || '';
  msg.className = 'msg' + (cls ? ' ' + cls : '');
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'getState' });
  recToggle.checked = !!s.recording;
  try {
    const b = await chrome.storage.local.get(['browseCapture']);
    browseToggle.checked = (b.browseCapture !== false);
  } catch (e) { browseToggle.checked = true; }
  stateText.textContent = s.recording ? '● 录制中' : '○ 已停止';
  stateText.style.color = s.recording ? '#e74c3c' : '#888';
  const n = Object.keys(s.pending || {}).length;
  pendingCount.textContent = n;
  if (s.lastSync) {
    if (s.lastSync.ok) {
      lastSync.textContent = `${fmtTime(s.lastSync.ts)}（成功 +${s.lastSync.added}）`;
    } else {
      lastSync.textContent = `${fmtTime(s.lastSync.ts)}（失败）`;
    }
  } else {
    lastSync.textContent = '—';
  }
  // Gitee 镜像状态
  if (!s.giteeCfg || !s.giteeCfg.enabled) {
    lastGitee.textContent = '未启用';
    lastGitee.style.color = '#888';
  } else if (s.lastGiteeSync) {
    if (s.lastGiteeSync.ok) {
      lastGitee.textContent = `${fmtTime(s.lastGiteeSync.ts)}（成功 +${s.lastGiteeSync.added || 0}）`;
      lastGitee.style.color = '#27ae60';
    } else {
      lastGitee.textContent = `${fmtTime(s.lastGiteeSync.ts)}（失败）`;
      lastGitee.style.color = '#e74c3c';
    }
  } else {
    lastGitee.textContent = '待同步';
    lastGitee.style.color = '#888';
  }
}

recToggle.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'setRecording', value: recToggle.checked });
  await refresh();
});

browseToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ browseCapture: browseToggle.checked });
  setMsg(browseToggle.checked ? '✓ 浏览即录已开（不点进商品也能抓月/周销量）' : '已切换为仅录制点开的商品', 'ok');
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  setMsg('同步中…');
  const r = await chrome.runtime.sendMessage({ type: 'manualSync' });
  syncBtn.disabled = false;
  if (r && r.ok) {
    const skip = r.skipped ? `，已过滤周销0 ${r.skipped} 件` : '';
    setMsg(`✓ 已同步：新增 ${r.added || 0} 件，共 ${r.total || 0} 件${skip}`, 'ok');
  } else {
    setMsg('✗ ' + (r && r.error ? r.error : '同步失败'), 'err');
  }
  await refresh();
});

setBtn.addEventListener('click', () => {
  // 直接新开标签页打开选项页（兼容跨境卫士等魔改内核，避免 openOptionsPage 静默失效）
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }, () => {
    if (chrome.runtime.lastError) {
      // 极少数环境无 tabs 权限/被拦截时，退回 openOptionsPage
      chrome.runtime.openOptionsPage();
    }
  });
  window.close();
});

// 清空待同步队列：用于「错价数据已污染、需要先清干净再重新录制」的场景。
clearBtn.addEventListener('click', async () => {
  const s = await chrome.runtime.sendMessage({ type: 'getState' });
  const n = Object.keys(s.pending || {}).length;
  if (n === 0) { setMsg('✓ 待同步队列已经是空的', 'ok'); return; }
  if (!confirm(`确认清空 ${n} 件待同步数据？\n（清空后需重新浏览/录制商品，已推送到 GitHub 的数据不受影响）`)) return;
  await chrome.storage.local.set({ pending: {} });
  setMsg(`✓ 已清空 ${n} 件待同步数据`, 'ok');
  await refresh();
});

refresh();
