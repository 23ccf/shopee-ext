// background.js — service worker：接收商品、存储、定时/手动同步到 GitHub
'use strict';

const DEFAULTS = {
  recording: true,   // 默认开启：打开扩展在虾皮浏览即自动录制，弹窗可随时关闭
  cfg: {
    token: '',  // 不再预填无效 token；未配置时同步会明确提示「未配置 GitHub Token」，不会静默用错 token 报 401
    owner: '23ccf',
    repo: 'shopee-sync',
    branch: 'main',
    catalogPath: 'catalog.json',
    syncPath: 'sync.json',
  },
  // Gitee 镜像（国内可达，做到真正实时、不受 GitHub 封锁影响）。
  // 默认关闭，用户在选项页填写并启用后，扩展会「同时」推送一份到 Gitee，网站改读 Gitee。
  gitee: {
    enabled: false,
    owner: '',
    repo: '',
    token: '',
    branch: 'master',        // Gitee 默认分支通常是 master
    catalogPath: 'catalog.json',
    syncPath: 'sync.json',
  },
  pending: {},     // key -> 商品对象（待同步）
  lastSync: null,  // { ts, ok, msg }  —— GitHub 同步结果
};

// 商品消息队列：content.js 可能同时发送大量商品，串行处理避免 pending 互相覆盖
let productsQueue = [];
let processingProducts = false;

function key(it) { return `${it.shopid}-${it.itemid}`; }
function nowUnix() { return Math.floor(Date.now() / 1000); }  // Unix 秒（网站 dateStrUTC8 期望的格式）
function nowISO() { return new Date().toISOString(); }         // 仅用于 catalog 顶层 generated_at/captured_at

// ---- 桥接：选品网站通过外部消息把删除记录持久化到 GitHub deleted.json ----
//   用于：网站的 localStorage Token 被隐私浏览器清空时（写不进 deleted.json）→ 仍能通过本扩展
//   （自带可用 GitHub Token）把删除标记写入 GitHub，让"删除后立即同步复活"的 bug 彻底根除。
async function persistSiteDeletedViaExtension(payload) {
  try {
    const ids = Array.isArray(payload && payload.ids) ? payload.ids : [];
    if (!ids.length) return { ok: false, error: "no ids" };
    const ts = Number(payload && payload.ts) || nowUnix();
    const s = await getState();
    const cfg = s.cfg;
    if (!cfg || !cfg.token) return { ok: false, error: "recorder token empty" };
    const OWNER = cfg.owner, REPO = cfg.repo, BRANCH = cfg.branch || "main";
    const HDR = {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "application/json",
    };
    // 读取现有 deleted.json（若不存在则从空开始）
    let sha = null;
    let delMap = {};
    try {
      const meta = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/deleted.json?ref=${encodeURIComponent(BRANCH)}`,
        { headers: HDR }
      );
      if (meta.ok) {
        const j = await meta.json();
        sha = j.sha || null;
        try { delMap = JSON.parse(b64decode(j.content || "")) || {}; } catch (e) { delMap = {}; }
        if (typeof delMap !== "object" || Array.isArray(delMap)) delMap = {};
      } else if (meta.status !== 404) {
        return { ok: false, error: "read deleted.json failed: " + meta.status };
      }
    } catch (e) { /* 404 / network → treat as empty */ }
    // 合并（同 id 取较新 ts）
    for (const id of ids) { if (!delMap[id] || Number(delMap[id]) < ts) delMap[id] = ts; }
    const n = Object.keys(delMap).length;
    const body = {
      message: "site: persist deleted via extension (" + ids.length + " new, total " + n + ")",
      content: b64encode(JSON.stringify(delMap)),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;
    const r = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/deleted.json`,
      { method: "PUT", headers: HDR, body: JSON.stringify(body) }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { ok: false, error: "PUT deleted.json " + r.status + " " + t.slice(0, 160) };
    }
    console.log("[SR-bg] bridge: 已通过扩展持久化 deleted.json，标记总数", n);
    return { ok: true, count: n };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
// ---- 主动桥接：当用户打开选品网站时，扩展自动向页面主世界注入扩展 id ----
//   用于兜底 content_scripts 因浏览器策略/权限/时序未注入的情况。
const SITE_HOST = 'b966eeee72f14075ac04f41b7f0c79dd.bj2.agentos-app.net';
const SITE_PATTERN = 'https://' + SITE_HOST + '/*';
function injectBridgeToTab(tabId) {
  try {
    const code = `
      (function(){
        try {
          var id = '${chrome.runtime.id}';
          var ver = '${(chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "?"}';
          window.__SHOPEE_RECORDER__ = { id: id, version: ver, bridge: 1, ready: true };
          var el = document.documentElement || document.head || document.body;
          if (el && el.setAttribute) {
            el.setAttribute('data-shopee-recorder-id', id);
            el.setAttribute('data-shopee-recorder-version', ver);
            el.setAttribute('data-shopee-recorder-bridge', '1');
          }
          window.dispatchEvent(new CustomEvent('shopee-recorder-bridge', { detail: { id: id, version: ver } }));
        } catch (e) {}
      })();
    `;
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: (codeStr) => { eval(codeStr); },
      args: [code]
    }).catch(() => {});
  } catch (e) {}
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url && tab.url.startsWith('https://' + SITE_HOST + '/')) {
    injectBridgeToTab(tabId);
  }
});
// 对当前已打开的网站标签也尝试注入一次（扩展刚加载/更新时）
try {
  chrome.tabs.query({ url: SITE_PATTERN }).then((tabs) => {
    for (const t of tabs) { if (t.id) injectBridgeToTab(t.id); }
  }).catch(() => {});
} catch (e) {}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  try {
    if (msg && msg.type === "site:deleted") {
      persistSiteDeletedViaExtension(msg).then((r) => { try { sendResponse(r); } catch (e) {} });
      return true;  // 异步响应
    }
  } catch (e) {}
  return false;
});

// ---- 存储读写 ----
async function getState() {
  const s = await chrome.storage.local.get(['recording', 'cfg', 'giteeCfg', 'pending', 'lastSync', 'lastGiteeSync']);
  const storedCfg = s.cfg || {};
  const storedGitee = s.giteeCfg || {};
  return {
    recording: s.recording ?? DEFAULTS.recording,
    cfg: {
      token: storedCfg.token || DEFAULTS.cfg.token,  // 空则用默认 token
      owner: storedCfg.owner || DEFAULTS.cfg.owner,
      repo: storedCfg.repo || DEFAULTS.cfg.repo,
      branch: storedCfg.branch || DEFAULTS.cfg.branch,
      catalogPath: storedCfg.catalogPath || DEFAULTS.cfg.catalogPath,
      syncPath: storedCfg.syncPath || DEFAULTS.cfg.syncPath,
    },
    giteeCfg: Object.assign({}, DEFAULTS.gitee, storedGitee),  // Gitee 镜像配置
    pending: s.pending || {},
    lastSync: s.lastSync || null,
    lastGiteeSync: s.lastGiteeSync || null,
  };
}
function savePending(pending) { return chrome.storage.local.set({ pending }); }
async function clearPending() { return chrome.storage.local.set({ pending: {} }); }
function setRecording(v) {
  // 开启录制时主动拉一次最新删除名单：用户在网站删完商品后马上开录，
  // 缓存若还是旧的（最长 60 秒 TTL），已删商品会被录进 pending。
  if (v) {
    getState().then((s) => {
      if (s.cfg && s.cfg.token) return getDeletedMap(s.cfg, true);
    }).catch(() => {});
  }
  return chrome.storage.local.set({ recording: v });
}

// ---- badge ----
async function updateBadge() {
  const s = await getState();
  if (s.recording) {
    const n = Object.keys(s.pending).length;
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : 'REC' });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    chrome.action.setBadgeText({ text: 'OFF' });
  }
}

// ---- 把待同步数广播给所有打开的虾皮买家页（供浮窗显示）----
async function broadcastPending() {
  try {
    const s = await getState();
    const n = Object.keys(s.pending).length;
    const tabs = await chrome.tabs.query({ url: ['https://shopee.tw/*', 'https://*.shopee.tw/*'] });
    for (const t of tabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: 'pendingCount', n }); } catch (e) {}
    }
  } catch (e) {}
}

// ---- 接收商品 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.products) {
    // 入队串行处理，避免并发读写 storage.local.pending 导致覆盖
    productsQueue.push({ products: msg.products, tag: msg.tag, sendResponse });
    if (!processingProducts) processProductsQueue();
    return true;
  }
  if (msg && msg.type === 'manualSync') {
    doSyncShared().then((r) => sendResponse && sendResponse(r)).catch((e) => sendResponse && sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'setRecording') {
    setRecording(!!msg.value).then(() => {
      updateBadge();
      broadcastPending();
      sendResponse && sendResponse({ ok: true });
    }).catch((e) => sendResponse && sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'getState') {
    getState().then((s) => sendResponse && sendResponse(s)).catch(() => sendResponse && sendResponse(DEFAULTS));
    return true;
  }
  if (msg && msg.type === 'clearPending') {
    clearPending().then(() => {
      updateBadge();
      broadcastPending();
      sendResponse && sendResponse({ ok: true });
    }).catch((e) => sendResponse && sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // content script 的 fetch 可能被页面 CSP 拦截，这里用 background 的 fetch 代理（不受页面 CSP 限制）
  if (msg && msg.type === 'fetchViaBg') {
    fetchViaBg(msg.url, msg.init).then((r) => sendResponse && sendResponse(r)).catch((e) => sendResponse && sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
  // 前端保活心跳（MV3 service worker 10 秒自动同步需要持续唤醒）
  if (msg && msg.type === 'ping') {
    sendResponse && sendResponse({ ok: true, ts: Date.now() });
    return true;
  }
});

// 用 background 上下文发起 fetch（绕过页面 CSP），返回 { ok, status, json?, text? }
async function fetchViaBg(url, init) {
  const r = await fetch(url, init || {});
  const ct = r.headers.get('content-type') || '';
  if (ct.indexOf('json') >= 0) return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
  return { ok: r.ok, status: r.status, text: await r.text().catch(() => null) };
}

async function processProductsQueue() {
  processingProducts = true;
  while (productsQueue.length) {
    const job = productsQueue.shift();
    try {
      await handleProducts(job.products, job.tag);
      if (job.sendResponse) job.sendResponse({ ok: true });
    } catch (e) {
      console.error('[SR-bg] 处理商品队列失败:', e);
      if (job.sendResponse) job.sendResponse({ ok: false, error: String(e) });
    }
  }
  processingProducts = false;
}

// 把 pending 商品合并进待同步列表（同一 key 保留首次 first_seen，后面的更新 last_seen 和非零字段）
async function handleProducts(products, tag) {
  const s = await getState();
  if (!s.recording) return; // 开关关闭不录制
  // ★ 2026-09-03 关键修复：在「录制入口」就过滤掉网站已删除的商品。
  //   旧代码只在同步时过滤，且用了「last_seen 晚于删除时间就当作重新录制」的豁免条件，
  //   于是用户在网站删完商品、再去店铺页浏览，录制器重新录到同一商品（last_seen=当前时间），
  //   全部被判为"新品"绕过过滤 → 同步后集体复活。
  //   现在入口直接丢弃，已删商品根本进不了 pending。
  const delMap = (s.cfg && s.cfg.token) ? await getDeletedMap(s.cfg) : {};
  const nDelAll = Object.keys(delMap).length;
  const ts = nowUnix();  // Unix 秒（网站 dateStrUTC8 期望的格式）
  let changed = false;
  let droppedDeleted = 0;
  for (const p of products) {
    if (!p || p.itemid == null || p.shopid == null) continue;
    if (nDelAll && isDeleted(p, delMap)) { droppedDeleted++; continue; }
    const k = key(p);
    const prev = s.pending[k];
    const item = mergeFields(prev || {}, p);
    item.itemid = p.itemid;
    item.shopid = p.shopid;
    item.first_seen = prev ? prev.first_seen : ts;
    item.last_seen = ts;
    item.tags = Array.from(new Set((prev ? (prev.tags || []) : []).concat([tag || '浏览'])));
    s.pending[k] = item;
    changed = true;
  }
  if (droppedDeleted) console.log('[SR-bg] 录制入口过滤「网站已删除」商品:', droppedDeleted, '件');
  if (changed) {
    console.log('[SR-bg] 存入 pending:', Object.keys(s.pending).length, '件');
    await savePending(s.pending);
    updateBadge();
    broadcastPending();
  }
}

// 价格合理性兜底：列表/店铺接口曾把「分(×100)」误当 ×10，导致价格大 10 倍
// （如 ¥77 商品录成 770、¥580 录成 5800、甚至 9912）。本目录全为洞洞鞋，真值均 < NT$1000，
// 故任何 ≥1000 的价格一律视为 ×10 单位错误，÷10 还原（仅一次，避免过度修正）。
// 注：误差恒为 10×，单次 ÷10 即得真值；≤999 的正常洞洞鞋价格完全不动。
// 风险提示：若未来录入真实 ≥NT$1000 的非洞洞鞋，此兜底会误 ÷10，属已知取舍（见项目记忆）。
// 价格单位错误已从根因修复：sales_schema.js 各接口 unit 已正确（店铺分×100 / 推荐卡×100000），
// 录制端按 unit 换算得到正确 NT$。旧版 `p >= 1000 则 ÷10` 的双保险会误杀真实 ≥NT$1000 的商品
// （如店铺套装），导致"一部分价格错误"。故此处改为透传，不再对正常价做任何缩放；
// 极端 ×100000 单位灾难由网站端 normalizePrice(>1e6) 兜底，无需在此处理。
function sanePrice(p) {
  if (typeof p !== 'number' || !isFinite(p) || p <= 0) return p;
  return p;
}

// 精简商品字段，压缩 catalog.json 体积（实测 -45%，直接决定网站加载速度）。
// 省略的字段由网站 app.js 的 normalizeCatalog() 一一对称补回，两边必须同步修改：
//   1) 可派生：id / url / sold / total_sold / week_sold / listed_at
//   2) 零值空值：price=0、shop=''、cats=[] 等一律不写
function slimItem(it) {
  const o = { shopid: it.shopid, itemid: it.itemid };
  const ms = Number(it.month_sold) || 0;
  const ts = Number(it.sold_total != null ? it.sold_total : it.total_sold) || 0;
  if (ms) o.month_sold = ms;
  if (ts) o.sold_total = ts;
  // 周销量：用录制器算好的；缺失则由月销推导，确保网站一定有（口径 = 月销/4.345）
  const wk = (it.week_sold != null && Number(it.week_sold) > 0)
    ? Number(it.week_sold)
    : (ms > 0 ? Math.round(ms / 4.345) : 0);
  if (wk) o.week_sold = wk;
  // 价格字段：必为合理商品售价（>=30且<1000000），低于 30 通常是运费/优惠券/分期等小额，
  // 绝不能把它当售价推到 GitHub（避免上次的 price=10 / 0 把网站弄错）。
  // 先过 sanePrice 兜底修正残留的单位错误（旧录制的大 10 倍价格），正常价格原样通过。
  const pr = sanePrice(Number(it.price));
  if (isFinite(pr) && pr >= 30 && pr < 1000000) o.price = pr;
  ['name', 'img', 'rating', 'reviews', 'liked', 'stock', 'shop', 'loc', 'brand', 'discount'].forEach((k) => {
    if (it[k]) o[k] = it[k];   // 0 / '' / null 全部省略
  });
  if (it.official) o.official = true;
  if (it.cats && it.cats.length) o.cats = it.cats;
  if (it.tiers && it.tiers.length) o.tiers = it.tiers;
  if (it.first_seen) o.first_seen = it.first_seen;
  if (it.last_seen) o.last_seen = it.last_seen;   // 「今日录制」板块依赖，必须保留
  if (it.listed_at && it.listed_at !== it.first_seen) o.listed_at = it.listed_at;
  const msku = it.main_sku || {};
  if (msku.name || (msku.price != null && msku.price !== it.price && msku.price >= 30 && msku.price < 1000000)) {
    o.main_sku = msku;
  }
  if (it.keyword) o.keyword = it.keyword;
  if (it.keep_shop) o.keep_shop = true; // 店铺捕获商品：长期保留（不过「今日过滤」）
  return o;
}

// 合并字段：newItem 里的有效非零数值优先覆盖，零/null 不覆盖 old 的有效值。
// 价格字段：newItem.price 必须是合理商品售价(>=30)才覆盖；避免扩展误抓的运费/优惠券
//   (如「現折$10」「$0 起」「6期x $33」等)将 correct 的旧售价覆盖掉。
function mergeFields(oldItem, newItem) {
  const out = Object.assign({}, oldItem);
  for (const k of Object.keys(newItem)) {
    const v = newItem[k];
    if (v === undefined) continue;
    if (k === 'price') {
      const nv = sanePrice(Number(v));
      // 价格是敏感字段：必须 >=30 才算「真售价」
      if (!isNaN(nv) && nv >= 30 && nv < 1000000) out[k] = nv;
      continue;
    }
    if (['month_sold', 'week_sold', 'total_sold', 'sold', 'sold_total', 'rating', 'liked', 'reviews', 'stock'].includes(k)) {
      const nv = Number(v);
      if (!isNaN(nv) && nv > 0) out[k] = nv;
      else if (!isNaN(nv) && nv === 0 && (out[k] == null || out[k] === 0)) out[k] = 0;
    } else if (['name', 'img', 'url', 'shop', 'loc', 'brand'].includes(k)) {
      if (v != null && String(v).trim() !== '') out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---- GitHub 同步（Git Data API，支持 >1MB 大文件）----
function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

async function ghDataApi(method, path, token, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'shopee-recorder-extension',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

// ---- tree 请求缓存 + 并发去重 ----
// catalog.json 与 deleted.json 都在同一个 tree 里。旧代码分别拉一次 tree（2 次请求），
// 同步时又与 fetchExistingCatalog 串行 → 白白多一次往返。这里做成带 TTL 的缓存，
// 并且并发调用共用同一个 in-flight Promise，绝不重复发。
let treeCache = { tree: null, ts: 0 };
let treeInFlight = null;
const TREE_CACHE_TTL = 20000;
async function fetchTreeCached(cfg) {
  const now = Date.now();
  if (treeCache.tree && (now - treeCache.ts) < TREE_CACHE_TTL) return treeCache.tree;
  if (treeInFlight) return treeInFlight;
  const branch = cfg.branch || 'main';
  treeInFlight = ghDataApi('GET', `/repos/${cfg.owner}/${cfg.repo}/git/trees/${branch}?recursive=1`, cfg.token)
    .then((t) => { treeCache = { tree: t.tree || [], ts: Date.now() }; return treeCache.tree; })
    .finally(() => { treeInFlight = null; });
  return treeInFlight;
}

// 用 Git Data API 拉取独立 deleted.json（网站删除时写入的小文件）
// 作用：即使网站没有成功更新 catalog.json 的 deleted 字段，只要 deleted.json 存在，
//   录制器同步时也能过滤掉已删商品，避免「删除后同步又复活」。
async function fetchDeletedJson(cfg) {
  try {
    const tree = await fetchTreeCached(cfg);
    const entry = tree.find((e) => e.path === 'deleted.json');
    if (!entry) return {};
    const blob = await ghDataApi('GET', `/repos/${cfg.owner}/${cfg.repo}/git/blobs/${entry.sha}`, cfg.token);
    const content = blob.encoding === 'base64' ? b64decode(blob.content) : blob.content;
    const d = JSON.parse(content);
    if (d && typeof d === 'object' && !Array.isArray(d)) return d;
    return {};
  } catch (e) {
    console.log('[SR-bg] 拉 deleted.json 失败:', e.message);
    return {};
  }
}

// ---- 删除名单（网站已删商品）缓存 ----
// 录制入口每浏览一个商品都会查，同步时也要查，不能每次都打 API。
// 缓存 60 秒；录制开始 / 每次同步成功后主动刷新。
let deletedMapCache = { map: {}, ts: 0 };
const DELETED_CACHE_TTL = 60000;
async function getDeletedMap(cfg, force) {
  const now = Date.now();
  if (!force && deletedMapCache.map && (now - deletedMapCache.ts) < DELETED_CACHE_TTL) {
    return deletedMapCache.map;
  }
  const m = await fetchDeletedJson(cfg);
  deletedMapCache = { map: m, ts: now };
  console.log('[SR-bg] 刷新删除名单:', Object.keys(m).length, '条');
  return m;
}
function invalidateDeletedCache() { deletedMapCache = { map: {}, ts: 0 }; }

// 商品是否被网站删除。
// key 有三种写法，必须都查：
//   ① 网站 deleted.json / catalog.deleted → "shopid_itemid"（下划线）
//   ② 扩展内部 map 与 pending 的 key      → "shopid-itemid"（连字符）
//   ③ 个别商品自带的 id 字段               → 原样
// ★ 2026-09-03：不再比较 last_seen 与删除时间的先后。
//   旧逻辑「last_seen 晚于删除时间就当作用户重新录的新品」正是商品复活的元凶——
//   用户删完再去店铺页浏览，录制器重新录到同一商品、last_seen 刷新到当前时间，
//   于是全部被判为"新品"复活。删除是最终决定，恢复走网站「清空删除记录」（会清空 deleted.json）。
function isDeleted(it, delMap) {
  if (!delMap || !Object.keys(delMap).length) return false;
  if (it == null) return false;
  const s = String(it.shopid), i = String(it.itemid);
  const variants = [s + '_' + i, s + '-' + i];
  if (it.id != null && it.id !== undefined) variants.push(String(it.id));
  for (const dk of variants) if (delMap[dk]) return true;
  return false;
}
// pending 的 key 形如 "shopid-itemid"，拆开后按同样的三种写法查删除名单
function isDeletedKey(k, delMap) {
  if (!delMap || !Object.keys(delMap).length) return false;
  const str = String(k);
  const parts = str.split('-');
  if (parts.length >= 2) {
    const s = parts[0], i = parts.slice(1).join('-');
    if (delMap[s + '_' + i] || delMap[s + '-' + i]) return true;
  }
  return !!delMap[str];
}

// 用 Git Data API 拉取现有 catalog.json（绕过 Contents API 的 1MB 限制和 CDN 缓存）
// 优化：直接用分支名定位 tree（省掉 ref + commit 两次往返），仅 2 次请求；
// blob 用 raw media type 取原文，省掉 base64 解码。拉到后写入内存缓存。
async function fetchExistingCatalog(cfg) {
  try {
    // 与 deleted.json 共用同一次 tree 请求（旧代码各拉一次，多一次往返）
    const tree = await fetchTreeCached(cfg);
    const entry = tree.find((e) => e.path === cfg.catalogPath);
    if (!entry) {
      return { items: [], categories: [], locations: [], source: 'shopee-recorder-extension' };
    }
    const blob = await ghDataApi('GET', `/repos/${cfg.owner}/${cfg.repo}/git/blobs/${entry.sha}`, cfg.token);
    const content = blob.encoding === 'base64' ? b64decode(blob.content) : blob.content;
    const doc = JSON.parse(content);
    console.log('[SR-bg] 拉到现有 catalog:', (doc.items || []).length, '件, blob:', entry.sha.slice(0, 7));
    existingCatalogCache = doc;
    existingCatalogCacheTs = Date.now();
    return doc;
  } catch (e) {
    console.log('[SR-bg] 拉 catalog 失败(可能首次或空库):', e.message);
    return { items: [], categories: [], locations: [], source: 'shopee-recorder-extension' };
  }
}

// 现有 catalog 内存缓存：点击「立即同步」时若缓存 <30 秒则直接复用，省去 2-6 秒拉取耗时。
let existingCatalogCache = null;
let existingCatalogCacheTs = 0;
function getExistingCatalogCached(cfg) {
  const fresh = Date.now() - existingCatalogCacheTs < 30000;
  if (existingCatalogCache && fresh) {
    console.log('[SR-bg] 复用内存缓存的 catalog (', (existingCatalogCache.items || []).length, '件)');
    return Promise.resolve(existingCatalogCache);
  }
  return fetchExistingCatalog(cfg);
}

// 用 Git Data API 推送多个文件（blob/tree/commit/ref），支持大文件
// 内部自动处理 "Update is not a fast forward"：创建 blob/tree/commit 期间若 ref 被其他客户端更新，
// 则重新获取最新 ref 并重试（最多 5 次），避免 422 导致同步失败。
async function pushFilesDataAPI(files, cfg, message) {
  const branch = cfg.branch || 'main';
  const maxAttempts = 5;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // ref 与所有 blob 创建无依赖 → 并行发起，省一次 RTT
      const refP = ghDataApi('GET', `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${branch}`, cfg.token);
      const blobPs = Object.entries(files).map(([, content]) =>
        ghDataApi('POST', `/repos/${cfg.owner}/${cfg.repo}/git/blobs`, cfg.token, {
          content: b64encode(content),
          encoding: 'base64',
        })
      );
      const [ref, ...blobs] = await Promise.all([refP, ...blobPs]);
      const baseSha = ref.object.sha;
      const commit = await ghDataApi('GET', `/repos/${cfg.owner}/${cfg.repo}/git/commits/${baseSha}`, cfg.token);
      const baseTreeSha = commit.tree.sha;

      const treeEntries = Object.keys(files).map((path, i) => ({
        path, mode: '100644', type: 'blob', sha: blobs[i].sha,
      }));

      const tree = await ghDataApi('POST', `/repos/${cfg.owner}/${cfg.repo}/git/trees`, cfg.token, {
        base_tree: baseTreeSha,
        tree: treeEntries,
      });
      const newCommit = await ghDataApi('POST', `/repos/${cfg.owner}/${cfg.repo}/git/commits`, cfg.token, {
        message,
        tree: tree.sha,
        parents: [baseSha],
      });
      await ghDataApi('PATCH', `/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${branch}`, cfg.token, {
        sha: newCommit.sha,
      });
      console.log('[SR-bg] pushFilesDataAPI 成功, attempt:', attempt + 1);
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message);
      const isRefConflict = msg.includes('422') && msg.includes('not a fast forward');
      if (isRefConflict || msg.includes('409')) {
        const delay = 600 + attempt * 400;
        console.log('[SR-bg] ref 冲突，', delay, 'ms 后重试 (attempt', attempt + 1, '):', e.message);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ---- Gitee 镜像同步（Contents API：GET 拿 sha 再 PUT 文件）----
// Gitee 与 GitHub 的 API 体系不同，必须单独实现。用于「国内可达、真正实时」的镜像源。
async function giteeApi(method, path, token, bodyObj, isJson) {
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  const url = 'https://gitee.com/api/v5' + path + sep + 'access_token=' + encodeURIComponent(token);
  const headers = { Authorization: 'token ' + token, Accept: 'application/json' };
  if (bodyObj && isJson) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, {
    method,
    headers,
    body: bodyObj ? (isJson ? JSON.stringify(bodyObj) : bodyObj) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.indexOf('json') >= 0 ? (await r.json().catch(() => null)) : null;
}

// 创建或更新单个文件（Gitee Contents API 统一用 PUT：有 sha 则更新，无 sha 则创建）
async function giteePutFile(owner, repo, branch, path, content, token, message) {
  let sha = null;
  try {
    const d = await giteeApi('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`, token, null, false);
    sha = d && d.sha ? d.sha : null;
  } catch (e) {
    sha = null; // 文件不存在（404），走创建分支
  }
  const body = {
    access_token: token,
    content: b64encode(content),  // Gitee 要求 base64
    message: message || 'sync',
    branch: branch,
  };
  if (sha) body.sha = sha;
  await giteeApi('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, token, body, true);
}

// 把合并后的 catalog 文档同时推送一份到 Gitee（作为国内可访问的实时镜像源）
async function pushToGitee(doc, giteeCfg) {
  if (!giteeCfg || !giteeCfg.enabled || !giteeCfg.token || !giteeCfg.owner || !giteeCfg.repo) {
    console.log('[SR-bg] Gitee 未配置或未启用，跳过镜像推送');
    return;
  }
  const branch = giteeCfg.branch || 'master';
  const catalogPath = giteeCfg.catalogPath || 'catalog.json';
  const syncPath = giteeCfg.syncPath || 'sync.json';
  const syncDoc = {
    sync_ts: doc.catalog_ts,
    catalog_ts: doc.catalog_ts,
    running: true,
    active: true,
    total_count: doc.items.length,
    updated_at: new Date().toISOString(),
  };
  try {
    await giteePutFile(giteeCfg.owner, giteeCfg.repo, branch, catalogPath, JSON.stringify(doc), giteeCfg.token, `sync: catalog (${doc.items.length} items)`);
    await giteePutFile(giteeCfg.owner, giteeCfg.repo, branch, syncPath, JSON.stringify(syncDoc, null, 2), giteeCfg.token, 'sync heartbeat');
    console.log('[SR-bg] Gitee 镜像推送成功');
    await chrome.storage.local.set({ lastGiteeSync: { ts: Date.now(), ok: true, added: doc.items.length } });
  } catch (e) {
    console.error('[SR-bg] Gitee 镜像推送失败:', e.message);
    await chrome.storage.local.set({ lastGiteeSync: { ts: Date.now(), ok: false, error: String(e.message) } });
  }
}

// ★★ 2026-09-03 关键修复：同步互斥。
//   扩展有三个独立触发源：弹窗「立即同步」、10 秒 setInterval 自动同步、15 秒 chrome.alarms。
//   旧代码三者互不知情，会同时并发跑 doSync()：各自读 catalog → 各自推送，
//   后推的那一个必然撞上 Git ref 冲突（422 not a fast forward）→ pushFilesDataAPI 内部重试 5 次
//   × doSync 外层重试 3 次 = 最坏 15 轮、每轮 5 个串行请求 → 这就是「点击同步非常慢」的根因。
//   现在用一把锁：已有同步在跑就直接复用它的 Promise，既不会冲突也不会重复推送。
let syncInFlight = null;
function doSyncShared() {
  if (syncInFlight) {
    console.log('[SR-bg] 已有同步在进行中，复用其结果（避免并发冲突与重复推送）');
    return syncInFlight;
  }
  syncInFlight = doSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

// 拉取现有 catalog，合并 pending，推回（带冲突重试）
async function doSync() {
  const s = await getState();
  const cfg = s.cfg;
  // 可选「自建后端」模式：仅在用户**显式启用且填了地址**时才走后端。
  // 默认（未启用 / 地址为空）一律走 GitHub —— 这是跨境卫士环境的唯一可用路径。
  const backend = s.backend || {};
  if (backend.enabled && backend.url) {
    return doSyncBackend(backend, s);
  }
  if (!cfg.token) return { ok: false, error: '未配置 GitHub Token（扩展设置页填写）' };
  const pendingKeys = Object.keys(s.pending);
  console.log('[SR-bg] doSync 开始, pending:', pendingKeys.length, '件, token:', cfg.token ? cfg.token.slice(0, 7) + '...' : '(空)');
  if (pendingKeys.length === 0) {
    // 仍更新 sync 心跳
    await pushSync(cfg, true, true);
    return { ok: true, added: 0, total: 0, note: '无新商品' };
  }

  let lastErr = null;
  // 重试次数 3 → 2：pushFilesDataAPI 内部已有 5 次 ref 冲突重试，
  // 外层再 3 次最坏要跑 15 轮完整流程（每轮 5 个串行请求），慢到不可用。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t0 = Date.now();
      // 并行拉取：旧代码串行 await 两次，各含一次 tree 请求（现在 tree 已带缓存+并发去重）
      const [existingDoc, deletedFromServer] = await Promise.all([
        getExistingCatalogCached(cfg),
        fetchDeletedJson(cfg),
      ]);
      const tFetch = Date.now();
      const mergedDelMap = Object.assign({}, existingDoc.deleted || {});
      for (const [k, v] of Object.entries(deletedFromServer || {})) {
        if (!mergedDelMap[k] || Number(mergedDelMap[k]) < Number(v)) mergedDelMap[k] = v;
      }
      const existingItems = Array.isArray(existingDoc.items) ? existingDoc.items : [];

      // 2) 合并，并过滤月销量为 0 的商品（用户要求：月销为 0 不进入网站）
      const map = new Map();
      for (const it of existingItems) {
        if (it && it.itemid != null && it.shopid != null) map.set(key(it), it);
      }
      let added = 0;
      let skippedZeroMonth = 0;
      for (const k of pendingKeys) {
        const np = s.pending[k];
        // 判据放宽（2026-08-26，2026-08-27 强化三态）：月销>0 或 总销>0 即视为有效商品入库。
        // 三态语义：content.js 传来的月/总销可能为 null（未知，非真 0）。
        //   Number(null) || 0 === 0，故「未知」与「真 0」在过滤时都按「无有效销量」处理，
        //   两者都不会单独作为入库依据；但只要月/总任一 >0（含真实 DOM 累计总销）即保留。
        //   月销=0/未知 的商品保留其真实总销，月销字段在 slimItem 被省略，网站显示为「未知」，绝不伪造。
        const ms = (np.month_sold == null) ? 0 : (Number(np.month_sold) || 0);
        const ts = (np.sold_total != null ? np.sold_total : np.total_sold);
        const tsN = (ts == null) ? 0 : (Number(ts) || 0);
        if (ms <= 0 && tsN <= 0) {
          skippedZeroMonth++;
          console.log('[SR-bg] 跳过月/总销均为 0/未知:', k, 'month=', np.month_sold, 'total=', np.sold_total);
          continue;
        }
        // 周销量为月销量的派生值（虾皮不提供周销量），确保口径一致
        np.week_sold = Math.round(ms / 4.345);
        const existing = map.get(k);
        let merged;
        if (!existing) {
          added++;
          merged = Object.assign({}, np);
        } else {
          // 保留最早的 first_seen，其他字段智能合并
          merged = mergeFields(existing, np);
          merged.first_seen = Math.min(existing.first_seen || Infinity, np.first_seen || Infinity);
          merged.last_seen = Math.max(existing.last_seen || 0, np.last_seen || 0);
        }
        map.set(k, merged);
      }
      // ★ 2026-09-02：移除「只保留今天录制/浏览」的过滤。
      //   该过滤会导致：扩展每天同步时把昨天及更早录制的商品从 GitHub catalog.json 中整批删除，
      //   网站首屏先显示本地旧快照（300+件）→ 后台拉到最新 catalog（只剩当天 keep_shop）→ 骤减闪屏。
      //   选品库应长期保留历史录制商品，由网站端按 MIN_MONTH 等规则过滤显示；
      //   真正需要移除的商品应走网站「删除选中」→ 写 deleted.json / 从 catalog 移除。
      // 放宽（2026-08-31）：月销=0 且 总销=0/未知 时，若商品具备真实商品信息
      // （店铺录制 keep_shop、或有名称/图片/价格）仍保留——虾皮台站常隐藏月/总销量，
      // 不应因此把用户主动录制的商品丢弃；仅当「无任何销量且明显非真实商品」才剔除。
      let _droppedUnknown = 0;
      for (const [_k, _v] of map) {
        const _ms = (_v.month_sold == null) ? 0 : (Number(_v.month_sold) || 0);
        const _tsRaw = (_v.sold_total != null ? _v.sold_total : _v.total_sold);
        const _ts = (_tsRaw == null) ? 0 : (Number(_tsRaw) || 0);
        const _isProduct = _v.keep_shop || _v.name || _v.img || (_v.price && _v.price > 0);
        if (_ms <= 0 && _ts <= 0 && !_isProduct) { map.delete(_k); _droppedUnknown++; }
      }
      console.log('[SR-bg] 二次过滤(销量未知)后剩余:', map.size, '件，剔除明显非商品:', _droppedUnknown);
      // ★★ 2026-09-01 关键修复：尊重网站上的删除。
      //   网站「删除选中」会把被删商品 id 写进 catalog.json 的 deleted 字段 + 独立 deleted.json：
      //   { "<shopid_itemid>": <删除时间戳秒> }
      //   此前录制器重建 catalog.json 时既不保留 deleted 字段、也不过滤已删商品，
      //   导致：用户在网站删光商品 → 录制器下一次同步又把 pending 里的旧商品全推回去 → "删除全部复活"。
      //   ★★ 2026-09-03 二次修复：去掉「last_seen 晚于删除时间就当作重新录制」的豁免。
      //   线上实测：用户删了 48 件，其中 6 件复活，全部来自同一店铺，
      //   last_seen 比删除时间晚 851~853 秒（用户删完后又去逛了该店铺页）→ 被判成"新品"复活。
      //   删除是最终决定，一律剔除；要恢复请走网站「清空删除记录」（会清空 deleted.json）。
      //   注意 key 格式：网站用下划线 shopid_itemid，录制器内部 map 用连字符 shopid-itemid，故两种都查。
      {
        const delMap = mergedDelMap;
        const nDel = Object.keys(delMap).length;
        if (nDel > 0) {
          let droppedDeleted = 0;
          for (const [_k, _v] of map) {
            if (isDeleted(_v, delMap)) { map.delete(_k); droppedDeleted++; }
          }
          console.log('[SR-bg] 过滤「网站已删除」商品:', droppedDeleted, '件（deleted 标记', nDel, '个）');
        }
      }
      // 按月销量从大到小排序，网站默认展示销量最高的商品
      const newItems = Array.from(map.values())
        .map(slimItem)
        .sort((a, b) => (b.month_sold || 0) - (a.month_sold || 0));
      const catalogTs = Math.floor(Date.now() / 1000);
      // 保留现有 catalog 的顶层字段（categories/locations 供网站筛选）
      const newDoc = {
        generated_at: nowISO(),
        captured_at: nowISO(),
        catalog_ts: catalogTs,
        source: existingDoc.source || 'shopee-recorder-extension',
        total: newItems.length,
        categories: existingDoc.categories || [],
        locations: existingDoc.locations || [],
        items: newItems,
        // ★ 2026-09-01：必须原样保留网站的 deleted 删除标记！
        //   此前这里漏掉该字段，录制器每次推送都会把它抹掉 → 网站删除记录丢失 → 商品复活。
        // ★ 2026-09-02：合并 deleted.json 与 catalog 内嵌 deleted，确保任一来源的删除都生效。
        deleted: mergedDelMap,
      };
      // 不加缩进：缩进会让 catalog.json 膨胀 30%+，直接拖慢网站加载
      const catalogJson = JSON.stringify(newDoc);
      console.log('[SR-bg] 合并后:', newItems.length, '件, 新增:', added, ', 跳过月销0:', skippedZeroMonth, ', catalog_ts:', catalogTs);

      // 3) 推 catalog + sync 心跳 + deleted.json（Git Data API，避免 Contents API 1MB 限制）
      await pushFilesDataAPI({
        [cfg.catalogPath]: catalogJson,
        'deleted.json': JSON.stringify(mergedDelMap),
        [cfg.syncPath]: JSON.stringify({
          sync_ts: catalogTs,
          catalog_ts: catalogTs,
          running: true,
          active: true,
          total_count: newItems.length,
          updated_at: new Date().toISOString(),
        }, null, 2),
      }, cfg, `sync: +${added} items (total ${newItems.length})`);
      console.log('[SR-bg] catalog/sync 推送成功');

      // === Gitee 镜像双推（国内可达，做到真正实时、不受 GitHub 封锁影响）===
      // 异步执行：不阻塞「同步完成」的返回，用户可早 1-3 秒看到成功提示；
      // 失败不阻断 GitHub 已成功的同步；状态记入 lastGiteeSync 供 popup 展示。
      pushToGitee(newDoc, s.giteeCfg).catch((ge) => {
        console.error('[SR-bg] Gitee 镜像推送异常(不阻断 GitHub):', ge.message);
      });

      const tPush = Date.now();
      console.log('[SR-bg] 同步耗时: 拉取', tFetch - t0, 'ms, 合并', tPush - tFetch, 'ms, 推送', Date.now() - tPush, 'ms');
      // 推送完成后刷新删除名单缓存（本轮可能刚写入新的删除标记）
      invalidateDeletedCache();

      // 4) 成功：从 pending 中移除本次已处理的 key（保留同步过程中新进入的商品）
      const currentPending = (await chrome.storage.local.get(['pending'])).pending || {};
      for (const k of pendingKeys) delete currentPending[k];
      // ★ 2026-09-03：还要清掉 pending 里「网站已删除」的商品。
      //   否则它们会一直留在 pending 中，下次同步又被推上去（即便合并阶段会过滤，
      //   留着也是隐患，且会让浮窗的「待同步 N 件」数字虚高）。
      let clearedDeleted = 0;
      const nDelMerged = Object.keys(mergedDelMap).length;
      if (nDelMerged) {
        for (const k of Object.keys(currentPending)) {
          if (isDeletedKey(k, mergedDelMap)) { delete currentPending[k]; clearedDeleted++; }
        }
      }
      if (clearedDeleted) console.log('[SR-bg] 已从待同步列表移除「网站已删除」商品:', clearedDeleted, '件');
      await chrome.storage.local.set({ pending: currentPending });
      await saveLastSync({ ts: Date.now(), ok: true, added, total: newItems.length, skipped: skippedZeroMonth, droppedDeleted: clearedDeleted });
      updateBadge();
      broadcastPending();
      console.log('[SR-bg] 同步完成: +', added, '件, 共', newItems.length, '件, 跳过月销0:', skippedZeroMonth, ', 总耗时', Date.now() - t0, 'ms');
      return { ok: true, added, total: newItems.length, skipped: skippedZeroMonth, elapsedMs: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      console.error('[SR-bg] 同步失败 (attempt', attempt + 1, '):', e.message);
      if (attempt < 1) {
        const delay = 800 + attempt * 500;
        console.log('[SR-bg] doSync ', delay, 'ms 后整体重试');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  await saveLastSync({ ts: Date.now(), ok: false, error: String(lastErr && lastErr.message) });
  return { ok: false, error: String(lastErr && lastErr.message) };
}

// ★ 2026-09-09：自建后端同步模式。开启后扩展直接登录后端并 POST /api/catalog/items，不再读写 GitHub。
// 这是"开源给他人用"的核心路径：用户只需一个账号密码即可使用，无需 GitHub Token。
async function doSyncBackend(backend, s) {
  const pendingKeys = Object.keys(s.pending || {});
  console.log('[SR-bg] doSyncBackend 开始, pending:', pendingKeys.length);
  if (pendingKeys.length === 0) {
    return { ok: true, added: 0, total: 0, note: '无新商品' };
  }

  // 1) 确保登录态有效（没有 token 就重新登录）
  const base = String(backend.url).replace(/\/$/, '');
  let token = backend.token;
  if (!token) {
    let loginRes;
    try {
      loginRes = await backendApi(base, '/api/auth/login', { username: backend.username, password: backend.password }, null, 8000);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    if (!loginRes) return { ok: false, error: '后端登录失败：无响应' };
    if (!loginRes.ok) return { ok: false, error: '后端登录失败：' + (loginRes.error || loginRes.message || '未知') };
    token = loginRes.token;
    backend.token = token;
    await chrome.storage.local.set({ backend });
  }

  try {
    const t0 = Date.now();

    // 2) 拉服务端删除名单（与现有 mergedDelMap 格式一致：{key: ts}）
    const delRes = await backendApi(base, '/api/catalog/deleted', null, token);
    let delMap = {};
    if (delRes && delRes.ok && delRes.deleted) delMap = delRes.deleted;

    // 3) 构造 items 列表：过滤月销量/总销均为 0 的，过滤已删除的
    const items = [];
    let skippedZeroMonth = 0;
    for (const k of pendingKeys) {
      const np = s.pending[k];
      if (!np) continue;
      if (isDeleted(np, delMap)) {
        console.log('[SR-bg] 后端模式：过滤已删除商品', k);
        continue;
      }
      const ms = (np.month_sold == null) ? 0 : (Number(np.month_sold) || 0);
      const ts = (np.sold_total != null ? np.sold_total : np.total_sold);
      const tsN = (ts == null) ? 0 : (Number(ts) || 0);
      if (ms <= 0 && tsN <= 0) {
        skippedZeroMonth++;
        continue;
      }
      np.week_sold = Math.round(ms / 4.345);
      items.push(Object.assign({}, np));
    }

    if (!items.length) {
      // 全部跳过：清掉 pending 里的这些 key，避免反复堆积
      await chrome.storage.local.set({ pending: {} });
      return { ok: true, added: 0, total: 0, skipped: skippedZeroMonth, note: '全部在服务端已删除或无有效销量' };
    }

    // 4) POST 到后端。后端已经做了合并/去重/删除拦截，扩展不需要关心。
    const upRes = await backendApi(base, '/api/catalog/items', { items }, token);
    if (!upRes || !upRes.ok) {
      return { ok: false, error: '后端写入失败：' + ((upRes && upRes.error) || '未知') };
    }
    const added = (upRes.added || 0) + (upRes.updated || 0); // 对扩展而言，新增+更新都是"进了库"
    console.log('[SR-bg] 后端推送成功: added=', upRes.added, 'updated=', upRes.updated, 'dropped=', upRes.dropped, '耗时', Date.now() - t0, 'ms');

    // 5) 从 pending 中移除本次已处理的 key
    await chrome.storage.local.set({ pending: {} });
    await saveLastSync({ ts: Date.now(), ok: true, added, total: upRes.total_count || items.length, skipped: skippedZeroMonth, droppedDeleted: upRes.dropped || 0 });
    updateBadge();
    broadcastPending();
    return { ok: true, added, total: upRes.total_count || items.length, skipped: skippedZeroMonth, elapsedMs: Date.now() - t0 };
  } catch (e) {
    console.error('[SR-bg] 后端同步失败:', e);
    return { ok: false, error: '后端同步失败：' + (e.message || e) };
  }
}

async function backendApi(base, path, body, token, timeoutMs) {
  const url = base + path;
  const init = {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
  };
  // 用自定义 header，避免反向代理改写 Authorization
  if (token) init.headers['x-shopee-token'] = token;
  if (body) init.body = JSON.stringify(body);

  // ★ 超时兜底（必选）：自建后端域名在跨境卫士等代理环境下，请求可能既不成功也不失败、
  //   永久挂起，没有超时会把整个同步流程（乃至页面）拖死。8 秒无响应即放弃并报错。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  init.signal = ctrl.signal;

  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e && (e.name === 'AbortError' || /abort/i.test(String(e.message))));
    throw new Error(aborted
      ? ('后端无响应（超时 ' + Math.round((timeoutMs || 8000) / 1000) + 's）：' + base +
         ' —— 若使用跨境卫士等代理浏览器，请关闭「自建后端」改用 GitHub 模式')
      : ('后端无法连接：' + ((e && e.message) || e)));
  }
  clearTimeout(timer);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let json; try { json = JSON.parse(text); } catch (e) {}
    return json || { ok: false, status: r.status, error: text || ('HTTP ' + r.status) };
  }
  return await r.json();
}

// 无新商品时仅更新 sync.json 心跳（同样用 Git Data API）
async function pushSync(cfg, running, active, total, catalogTs) {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const doc = {
      sync_ts: nowSec,
      catalog_ts: catalogTs != null ? catalogTs : nowSec,
      running,
      active,
      total_count: total != null ? total : 0,
      updated_at: new Date().toISOString(),
    };
    await pushFilesDataAPI({
      [cfg.syncPath]: JSON.stringify(doc, null, 2),
    }, cfg, 'sync heartbeat');
  } catch (e) {
    console.log('[SR-bg] sync 心跳推送失败:', e.message);
  }
}

async function saveLastSync(obj) {
  await chrome.storage.local.set({ lastSync: obj });
}

// ---- 自动同步（每 10 秒）----
// MV3 service worker 会在无消息时休眠；content.js 每 10 秒发一次 ping 保活，
// 同时这里每 10 秒检查 pending：有未同步商品就推 GitHub。
let autoSyncTimer = null;
function startAutoSync() {
  if (autoSyncTimer) return;
  autoSyncTimer = setInterval(async () => {
    try {
      const s = await getState();
      if (!s.recording) return;
      const n = Object.keys(s.pending).length;
      if (n > 0) {
        console.log('[SR-bg] 自动同步触发，pending:', n);
        const r = await doSyncShared();
        console.log('[SR-bg] 自动同步结果:', r.ok ? '+' + r.added + ' 件' : r.error);
      }
    } catch (e) {
      console.error('[SR-bg] 自动同步异常:', e.message);
    }
  }, 20000);
  console.log('[SR-bg] 自动同步已启动（20 秒，与 15 秒 alarm 双轨，由互斥锁保证不冲突）');
}
startAutoSync();

// ---- 定时同步（每 15 秒若有 pending 则推送，近实时同步到网站）----
chrome.alarms.create('sync', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') {
    getState().then((s) => {
      if (s.recording && Object.keys(s.pending).length > 0) doSyncShared();
      else broadcastPending(); // 无新商品时也刷新浮窗待同步数
    });
  }
});

// ---- 安装/启动 ----
chrome.runtime.onInstalled.addListener(() => {
  getState().then(() => updateBadge());
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.recording || changes.pending)) updateBadge();
});

updateBadge();
console.log('[Shopee Recorder] background ready');
