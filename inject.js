// inject.js —— 运行在【页面主环境 MAIN world】的嗅探器
// 核心思路（完全不同于扩展自己发请求）：
//   虾皮 SPA 渲染商品时，会【自己】用带反爬 token 的登录态去请求
//   /api/v4/item/get（详情）。这条请求页面必然成功（否则页面都渲染不出来）。
//   我们两种手段并用：
//   ① 包裹 window.fetch / XMLHttpRequest，clone 页面自己成功请求的响应、读出销量；
//   ② 主动用 window.fetch（MAIN world，自动带页面 cookie/token，不被 403）再请求一次
//      item/get 当前商品，直接拿到真实 item.sold（近30天=月销）与 item.historical_sold（累计）。
//   ② 是关键兜底：即使 ① 因注入时机错过首屏请求，主动请求也能补上。
//   数据经 postMessage 交给录制逻辑（content.js 的 ISOLATED world）。
//
// 2026-08-18 加固：
//   - 偷录页面真实 API 请求的【完整 header（含反爬 token）】，用一模一样的 header 原样重放，
//     极大提升 refetch 拿到 200 的概率（此前用「简化 header」可能被虾皮风控 403）。
//   - 新增 /api/v4/pdp/get 端点兜底（部分账号/页面走这个）。
//   - refetch 重试更密集（800/2000/4000/8000ms），并支持被 content.js 即时触发。
//   - 暴露 window.__SR_CAPTURED__() 供诊断查看已捕获的请求 URL。
//   - 【本次修复】响应解析改为「深度搜索」，自适应 json.data.item / json.item /
//     json.data 即商品对象 / 任意嵌套结构；并在首条 200 响应 dump 结构便于远程定位。
(function () {
  'use strict';

  // ★ 版本戳：每次重大修改后递增，用于在诊断/浮窗中 unmistakably 确认浏览器加载的是新代码。
  var SR_VERSION = '2026-08-26-v3';

  // ★ 单源字段字典：sales_schema.js 在 MAIN world 已先于本文件注入（见 manifest.json）。
  //   所有销量/价格/icsc 解析统一走 S.resolveItem / S.locateIcs，杜绝分散重复逻辑。
  var S = window.__SR_SCHEMA__;

  // 只拦截这几类接口；其余请求一律放行
  // ★ 2026-08-21 修正：必须包含店铺/列表类接口，否则用户浏览店铺页、分类页、热销榜时
  //   商品数据完全进不来（浮窗「浏览已扫 0 件」的根因之一）。
  var TARGETS = [
    '/api/v4/item/get',            // 详情页：权威 月销(item.sold) + 总销(item.historical_sold)
    '/api/v4/pdp/get_pc',          // ★PC 详情页新版接口（2026 虾皮已切换，参数 shop_id/item_id）★
    '/api/v4/pdp/get',             // 新版详情页（部分账号/页面使用）
    '/api/v4/search/search_items', // 搜索列表
    '/api/v4/recommend/recommend', // 推荐/每日发现
    '/api/v4/shop/get_shop_tab',   // 店铺商品墙（tab 切换）
    '/api/v4/shop/rcmd_items',     // 店铺推荐/热销
    '/api/v4/shop/hot_sales',      // 店铺热销榜
    '/api/v4/shop/get_shop_seo',   // 店铺 SEO 页商品
    '/api/v4/item/get_rating',     // 部分页面的评分接口（含 item 基本数据，兜底）
    // ★ 2026-08-26：PDP 推荐卡「看了又看/猜你喜欢」——每个卡片 item_data.item_card_display_sold_count
    //   含结构化 monthly_sold_count（最干净的权威月销，如 363），此前漏捕获，是金矿接口。
    '/api/v4/pdp/hot_sales/get_item_cards',
    // 购物车面板/变体选择接口——页面真实请求，可能返回带销量的 item 详情
    '/api/v4/cart/cart_panel/get_rw',
    '/api/v4/pdp/cart_panel/select_variation_pc'
  ];

  // ---- 请求日志（供诊断：记录页面所有经过本嗅探器的 /api 请求 URL）----
  var REQ_LOG = [];
  function logReq(url) {
    if (!url || typeof url !== 'string') return;
    if (url.indexOf('/api/') >= 0 || url.indexOf('shopee.tw') >= 0) {
      if (REQ_LOG.indexOf(url) < 0) {
        REQ_LOG.push(url);
        if (REQ_LOG.length > 80) REQ_LOG.shift();
      }
    }
  }
  try {
    Object.defineProperty(window, '__SR_REQ_LOG__', {
      configurable: true,
      get: function () { return REQ_LOG.slice(); }
    });
  } catch (e) {
    window.__SR_REQ_LOG__ = REQ_LOG;
  }

  function isTarget(url) {
    if (!url || typeof url !== 'string') return null;
    for (var i = 0; i < TARGETS.length; i++) {
      if (url.indexOf(TARGETS[i]) >= 0) return TARGETS[i];
    }
    return null;
  }

  function post(payload) {
    try { window.postMessage({ __SR_API_CAPTURE__: true, payload: payload }, '*'); } catch (e) {}
  }
  function postLog(endpoint, msg, preview) {
    try { window.postMessage({ __SR_INTERCEPT_LOG__: true, endpoint: endpoint, msg: msg, preview: preview }, '*'); } catch (e) {}
  }
  // ★ 诊断专用：深度受限的安全序列化（防 postMessage 体过大 / 循环引用）
  function safeStringify(obj, maxDepth, maxArr, seen) {
    if (obj == null) return null;
    if (typeof obj !== 'object') {
      if (typeof obj === 'string' && obj.length > 240) return obj.slice(0, 240) + '…';
      return obj;
    }
    if (maxDepth == null) maxDepth = 4;
    if (maxArr == null) maxArr = 8;
    if (seen == null) seen = [];
    if (seen.indexOf(obj) >= 0) return '[circular]';
    seen.push(obj);
    var out;
    if (Array.isArray(obj)) {
      out = [];
      for (var i = 0; i < Math.min(obj.length, maxArr); i++) out.push(safeStringify(obj[i], maxDepth - 1, maxArr, seen));
      if (obj.length > maxArr) out.push('[+' + (obj.length - maxArr) + ' more]');
    } else {
      out = {}; var cnt = 0;
      for (var k in obj) {
        if (!obj.hasOwnProperty(k)) continue;
        if (cnt >= 50) { out['…'] = '[truncated]'; break; }
        out[k] = safeStringify(obj[k], maxDepth - 1, maxArr, seen);
        cnt++;
      }
    }
    seen.pop();
    return out;
  }
  // ★ 诊断专用：把店铺/推荐卡接口的原始样本 + 逐件 resolveItem 结果发给 content.js，
  //   供 diagCapture 一并导出——直接暴露「原始结构 vs 解析结果」，定位月销=0 根因（无需再猜）。
  function postShopDiag(t, items) {
    try {
      var resolved = (items || []).slice(0, 8).map(function (it) {
        var r = S.resolveItem(it, t);
        return { id: r ? r.itemid : null, shopid: r ? r.shopid : null,
                 month: r ? r.month : null, total: r ? r.total : null, price: r ? r.price : null };
      });
      var raw = items && items[0] ? safeStringify(items[0], 4, 6) : null;
      window.postMessage({ __SR_SHOP_DIAG__: true, endpoint: t, count: (items || []).length,
                           resolved: resolved, rawSample: raw }, '*');
    } catch (e) {}
  }

  // ---- 接收 content.js 的批量补抓指令（在 MAIN world 用页面登录态拉 item/get）----
  window.addEventListener('message', function (e) {
    if (e && e.data && e.data.__SR_BATCH_FETCH__ && e.data.items && e.data.items.length) {
      fetchBatchItems(e.data.items);
    }
  });

  function fetchBatchItems(items) {
    if (!items || !items.length) return;
    var init = buildInit({ Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' });
    items.forEach(function (it, idx) {
      if (!it.shopid || !it.itemid) return;
      setTimeout(function () {
        var url = 'https://shopee.tw/api/v4/item/get?itemid=' + encodeURIComponent(it.itemid) + '&shopid=' + encodeURIComponent(it.shopid);
        fetch(url, init).then(function (resp) {
          if (!resp.ok) return;
          return resp.json();
        }).then(function (json) {
          if (!json) return;
          var out = extractItems('/api/v4/item/get', json);
          if (out.length) {
            post({ endpoint: '/api/v4/item/get', items: out, authoritativeMonth: true, source: 'batch' });
          }
        }).catch(function () {});
      }, idx * 400);
    });
  }

  // 深度搜索响应体，找出真正的商品对象。
  // 判定：含 itemid/item_id，且满足 (requireSales ? 含销量字段 : 含销量/基本字段之一)。
  // 不再「命中即返回」，而是收集所有候选后按「字段完整度」排序，优先选择同时含
  // 销量 + 名称 + 价格 + 图片的完整商品对象，避免抓到仅含销量的摘要对象。
  function findItem(obj, requireSales, depth, candidates) {
    if (!obj || typeof obj !== 'object') return null;
    if (depth == null) depth = 0;
    if (candidates == null) candidates = [];
    if (depth > 7) return null; // 防环 & 安全上限
    var id = (obj.itemid != null) ? obj.itemid : (obj.item_id != null ? obj.item_id : null);
    if (id != null) {
      var hasSales = (obj.sold != null) || (obj.historical_sold != null) || (obj.monthly_sold != null) ||
                     (obj.sold_count != null) || (obj.recent_sold != null) || (obj.month_sales != null);
      var hasBasic = (obj.price != null) || (obj.name != null) || (obj.images != null) || (obj.image != null) || (obj.shopid != null);
      if (requireSales ? hasSales : (hasSales || hasBasic)) {
        candidates.push(obj);
      }
    }
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      var v = obj[k];
      if (v && typeof v === 'object') findItem(v, requireSales, depth + 1, candidates);
    }
    if (depth > 0) return null; // 仅最顶层调用做排序/返回
    if (!candidates.length) return null;
    // 排序：字段越完整越优先；同分时优先含销量的
    function score(it) {
      var s = 0;
      if (it.itemid != null) s += 1;
      if (it.shopid != null) s += 1;
      if (it.name) s += 3;
      if (it.price != null || it.price_min != null) s += 3;
      if (it.images || it.image || it.image_url) s += 3;
      if (it.sold != null || it.historical_sold != null || it.monthly_sold != null) s += 4;
      return s;
    }
    candidates.sort(function (a, b) { return score(b) - score(a); });
    return candidates[0];
  }

  // ★ 销量/价格/icsc 提取已统一到 sales_schema.js（单源，见文件顶部 var S = window.__SR_SCHEMA__）：
  //   - 月销/总销/价格/周销/名称/图片 → S.resolveItem(item, endpoint)
  //   - icsc 深搜 → S.locateIcs / S.readIcscNum
  //   - 文本数字 → S.parseNumLocal；纯数值 → S.coerceIntLocal
  //   旧函数（numFromText / findIcs / readIcsSold / readMonthSold / readTotalSold）已删除，
  //   消除「月销与累计混淆」「逻辑分散重复」两个反复改错的根因（见复盘 §0）。

  // ★ 递归扫描对象里所有 key 含 sold/sales 的字段（路径 + 值），用于诊断锁定虾皮真实字段名。
  function dumpSoldFields(obj, prefix, out, max) {
    if (out == null) out = [];
    if (max == null) max = 15;
    if (!obj || typeof obj !== 'object' || out.length >= max) return out;
    prefix = prefix || '';
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length && out.length < max; i++) dumpSoldFields(obj[i], prefix + '[' + i + ']', out, max);
      return out;
    }
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      var path = prefix ? prefix + '.' + k : k;
      var v = obj[k];
      if (/sold|sales|sale_count|sold_count/i.test(k)) {
        var vs = (v == null) ? 'null' : (typeof v === 'object' ? JSON.stringify(v).slice(0, 50) : String(v));
        out.push(path + '=' + vs);
        if (out.length >= max) return out;
      }
      if (v && typeof v === 'object') dumpSoldFields(v, path, out, max);
    }
    return out;
  }

  // ★ 2026-08-19（诊断增强 #126）：递归扫描 price 原始字段（路径 + 值）。
  //   用途：锁定每个接口的价格单位（详情×100000 / 列表×10 / seo 分 / 卖家中心元），
  //   诊断样本直接可见原始值，不再靠猜。
  function dumpPriceFields(obj, prefix, out, max) {
    if (out == null) out = [];
    if (max == null) max = 10;
    if (!obj || typeof obj !== 'object' || out.length >= max) return out;
    prefix = prefix || '';
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length && out.length < max; i++) dumpPriceFields(obj[i], prefix + '[' + i + ']', out, max);
      return out;
    }
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      var path = prefix ? prefix + '.' + k : k;
      var v = obj[k];
      if (/^price$|price_min|price_max|min_price|max_price|original_price|raw_price/i.test(k)) {
        var vs = (v == null) ? 'null' : (typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v));
        out.push(path + '=' + vs);
        if (out.length >= max) return out;
      }
      if (v && typeof v === 'object') dumpPriceFields(v, path, out, max);
    }
    return out;
  }

  // 从一个接口响应 JSON 中提取出商品 item 对象数组
  function extractItems(endpoint, json) {
    var out = [];
    try {
      if (endpoint === '/api/v4/item/get' || endpoint === '/api/v4/pdp/get' || endpoint === '/api/v4/pdp/get_pc' || endpoint === '/api/v4/item/get_rating') {
        if (json && json.data && (json.data.item || (json.data.data && json.data.data.item))) {
          var it = json.data.item || json.data.data.item;
          if (it && (it.itemid != null || it.item_id != null)) out.push(it);
        } else if (json && json.item && (json.item.itemid != null || json.item.item_id != null)) {
          out.push(json.item);
        } else {
          var f = findItem(json, authFor(endpoint));
          if (f) out.push(f);
        }
      } else {
        var arr = (json && json.data && (json.data.items || json.data.item_list || json.data.list || json.data.product_list || json.data.item_cards)) || (json && json.items) || null;
        if (arr && arr.length) {
          for (var i = 0; i < arr.length; i++) {
            var e = arr[i];
            if (!e) continue;
            // ★ 2026-08-26：get_item_cards 把商品包在 item_data 里（item_data.itemid / .shopid /
            //   .item_card_display_sold_count / .item_card_display_price），故 it2 也要尝试 item_data。
            var hasCard = (e.item_card_display_sold_count != null) || (e.item_card_displayed_asset != null) ||
                          (e.item_data && (e.item_data.item_card_display_sold_count != null || e.item_data.itemid != null));
            var it2 = (e && (e.item_basic || e.item || e.item_data)) || e;
            // ★ 2026-08-19（月销丢失防御）：卡片对象若同时含 itemid 与 icsc（item_card_display_sold_count），
            //   优先收集卡片对象本身——只取 item_basic/item 会把销量对象丢掉（曾导致月销 77 捕获后丢失）。
            var eid = (e.itemid != null || e.item_id != null ||
                       (e.item_data && (e.item_data.itemid != null || e.item_data.item_id != null)));
            if (hasCard && eid) {
              out.push(e);
            } else if (it2 && (it2.itemid != null || it2.item_id != null)) {
              out.push(it2);
            }
            if (out.length > 200) break; // 安全上限
          }
        }
        // ★ 未知端点兜底：深度搜索任何嵌套结构（get_pc 等新接口可能把 item 放任意层级）。
        //   ★ 2026-08-19：改为收集【所有】含 itemid/item_id 的商品对象 —— 卖家中心商品
        //     列表接口返回 N 件商品，findItem 只取「最优 1 件」会漏掉目标商品。
        if (!out.length) {
          var all2 = [];
          collectAllItems(json, all2, 0, 100);
          for (var i2 = 0; i2 < all2.length && out.length < 100; i2++) out.push(all2[i2]);
        }
      }
    } catch (e) {}
    return out;
  }

  // 递归收集所有含 itemid/item_id 的商品对象（卖家中心等未知结构的列表接口）
  function collectAllItems(obj, out, depth, max) {
    if (!obj || typeof obj !== 'object' || out.length >= max || (depth || 0) > 7) return;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length && out.length < max; i++) collectAllItems(obj[i], out, depth + 1, max);
      return;
    }
    var id = (obj.itemid != null) ? obj.itemid : (obj.item_id != null ? obj.item_id : null);
    // ★ 2026-08-19（本轮）：含 item_card_display_sold_count / item_card_displayed_asset 的对象
    //   也视为商品（列表接口的 item_data 可能只有 itemid + 销量对象，缺 price/name 会被漏掉）
    var hasCard = (obj.item_card_display_sold_count != null) || (obj.item_card_displayed_asset != null);
    if (hasCard && id == null) {
      // ★ get_shop_tab/rcmd_items 结构：销量在 item_cards[] 层，但 id 在其子对象 item_data 里。
      //   把 id 补到 item_card 层自身，保证 handleApiCapture 同时拿到 itemid + 销量对象。
      for (var kk in obj) {
        if (!obj.hasOwnProperty(kk) || kk === 'item_card_display_sold_count' || kk === 'item_card_displayed_asset') continue;
        var vv = obj[kk];
        if (vv && typeof vv === 'object' && !Array.isArray(vv)) {
          if (vv.itemid != null || vv.item_id != null) {
            obj.itemid = (vv.itemid != null) ? vv.itemid : vv.item_id;
            id = obj.itemid;
            break;
          }
        }
      }
    }
    if (id != null && (obj.price != null || obj.name != null || obj.sold != null || obj.image != null || obj.shopid != null || obj.shop_id != null || hasCard)) {
      out.push(obj);
      return; // 已识别为商品对象，不再深入（避免误收集 models 变体）
    }
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      var v = obj[k];
      if (v && typeof v === 'object') collectAllItems(v, out, depth + 1, max);
    }
  }

  function authFor(endpoint) {
    // ★ 2026-08-24 校正：只有 item/get / item/get_rating 的 sold 才是「近30天月销」(=531)。
    //   pdp/get_pc / pdp/get 的 sold 实为【累计总销】(=2000)，若当权威月销会让网站月销=2000（已验证错误）。
    //   故 pdp 类接口不再标记 authoritativeMonth；其月销由下方 activeRefetch 借页面 header 重发 item/get 取得。
    return (endpoint === '/api/v4/item/get' || endpoint === '/api/v4/item/get_rating');
  }

  // 暂存页面真实请求（含完整 header / 反爬 token），用于原样重放（几乎必成功）
  var _capturedReqs = {};     // endpoint -> { url, init, headers }
  var _lastApiHeaders = null; // 最近一次页面 API 请求的 header（任意端点，反爬 header 跨端点通用）

  function normalizeHeaders(h) {
    if (!h) return null;
    var out = {};
    try {
      if (typeof h.forEach === 'function') { h.forEach(function (v, k) { out[k] = v; }); return out; }
      if (typeof h === 'object') { for (var k in h) { if (h.hasOwnProperty(k)) out[k] = h[k]; } return out; }
    } catch (e) {}
    return null;
  }

  function captureReq(target, url, init) {
    try {
      var headers = normalizeHeaders(init && init.headers);
      if (headers) _lastApiHeaders = headers;            // 任意 /api 请求都更新真实 header
      _capturedReqs[target] = { url: url, init: init || null, headers: headers };
    } catch (e) {}
  }

  // ---- 包裹 window.fetch：clone 响应体后读 JSON（不破坏页面本身的消费）----
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  if (realFetch) {
    window.fetch = function (input, init) {
      var url = (input && input.url) ? input.url : (typeof input === 'string' ? input : '');
      logReq(url);
      // 任意 /api 请求都记录真实 header（用于后续重放）
      if (url && url.indexOf('/api/') >= 0) captureReq('__hdr__', url, init);
      var t = isTarget(url);
      return realFetch(input, init).then(function (resp) {
        if (t && resp && resp.ok && typeof resp.clone === 'function') {
          try {
            if (t === '/api/v4/item/get' || t === '/api/v4/pdp/get' || t === '/api/v4/pdp/get_pc' ||
                t === '/api/v4/shop/get_shop_tab' || t === '/api/v4/shop/rcmd_items' || t === '/api/v4/shop/hot_sales') captureReq(t, url, init);
            var clone = resp.clone();
            var isAuth = authFor(t);
            clone.json().then(function (json) {
              var items = extractItems(t, json);
              if (items.length) {
                if (t === '/api/v4/search/search_items' || t === '/api/v4/recommend/recommend') {
                  // 浏览/搜索/每日发现：用户要求列表页什么都不录
                  postLog(t, '浏览/搜索/每日发现接口，按规则不录制');
                } else if (shouldShopCapture(t)) {
                  // 店铺页：捕获该店商品（content.js 按来源阈值过滤），并触发 item/get 月销精修
                  var sp = parseShopFromUrl();
                  var sname = (json && json.data && (json.data.shop_name || (json.data.shop && json.data.shop.name))) || _shopCtx.name;
                  updateShopCtx(sp && sp.shopid, sname);
                  var shopPosts = buildShopProducts(t, items, { shopid: (sp && sp.shopid) || _shopCtx.shopid, name: _shopCtx.name, source: 'shop' });
                  shopPosts.forEach(function (p) { post(p); });
                  enqueueShopMonthUpgrade(shopPosts);
                  postShopDiag(t, items); // ★ 诊断：原始样本 + 逐件解析结果
                  postLog(t, '店铺接口，捕获 ' + shopPosts.length + ' 件（shop 页：月/总销>0 即保留）');
                } else if (t === '/api/v4/pdp/hot_sales/get_item_cards') {
                  // ★ PDP 推荐卡（看了又看/猜你喜欢）：每张卡来自【不同店铺】，其真实店铺在
                  //   item_data.shopid 里。务必让每张卡【自我归属】，绝不用当前页 shopid/店铺名覆盖
                  //   （memory 铁律：勿把当前页 shopid 误赋给推荐商品）。
                  //   buildShopProducts 内部 S.resolveItem 已逐卡读 item_data.shopid + icsc 月销；
                  //   这里传 {} 让 shopName 回退为「店铺{自身shopid}」，而非当前页店铺名。
                  var cardPosts = buildShopProducts(t, items, { source: 'pdp_card' });
                  cardPosts.forEach(function (p) { post(p); });
                  postShopDiag(t, items); // ★ 诊断：原始样本 + 逐件解析结果
                  postLog(t, 'PDP推荐卡，捕获 ' + cardPosts.length + ' 件（每张自属店铺，月销>30 入库）');
                } else if (isDetailEndpoint(t) && pageType() === 'detail') {
                  post({ endpoint: t, items: items, authoritativeMonth: isAuth, source: 'listen' });
                  // ★ 诊断：dump 偷听响应的销量字段，锁定虾皮真实字段名（sold/historical_sold/global_sold…）
                  try {
                    var sf = dumpSoldFields(json, 'root', [], 12);
                    var d0 = json && json.data;
                    var it0 = d0 && typeof d0 === 'object' && (d0.item || (d0.data && d0.data.item));
                    var itKeys = (it0 && typeof it0 === 'object') ? Object.keys(it0).slice(0, 24).join(',') : '无';
                    postLog(t, '偷听items=' + items.length + ' item.keys=[' + itKeys + ']' +
                            (sf.length ? ' sold扫描: ' + sf.join(' | ') : ' sold扫描:无'));
                  } catch (eD) {}
                } else {
                  postLog(t, '非目标页类型(' + pageType() + ')，跳过录制');
                }
              } else {
                postLog(t, 'json 解析成功但无 items');
              }
            }).catch(function (e) {
              try {
                var textClone = resp.clone();
                textClone.text().then(function (txt) {
                  postLog(t, 'json 解析失败，响应长度=' + (txt ? txt.length : 0), String(txt).slice(0, 200));
                }).catch(function () {});
              } catch (e2) {}
            });
          } catch (e) {}
        }
        // ★ 兜底：非白名单的 shopee 域 /api/ 响应——【只诊断、不入库】（2026-08-21 修正）。
        //   原逻辑对所有 /api/ 响应都 extractItems 并 post 给 content.js，导致购物车 /cart/mini、
        //   加购面板等接口里的商品对象（有 itemid/price/name 但无销量）被当成真实商品捕获，
        //   月销=0、价格错误，严重污染 catalog 并触发大量无效补抓。
        //   现在改为：仅对卖家中心域（seller.shopee.tw）做自动商品提取；买家域普通接口只 dump
        //   日志用于诊断，绝不 post 商品数据给 content.js。
        if (!t && resp && resp.ok && url && /\/api\//.test(url) && /shopee\.tw/.test(url) && typeof resp.clone === 'function') {
          try {
            var c2 = resp.clone();
            var isSeller = url.indexOf('seller.') >= 0;
            c2.text().then(function (txt) {
              if (!txt || txt.length < 120) return;   // 登录/心跳等小响应跳过，防刷屏
              var json = null;
              try { json = JSON.parse(txt); } catch (e) { return; } // 非 JSON（HTML/图片）跳过
              var items = extractItems(null, json);
              var epName = (isSeller ? 'seller:' : 'auto:') + url.split('?')[0];
              var sf2 = dumpSoldFields(json, 'root', [], 18);
              var pf2 = dumpPriceFields(json, 'root', [], 10);
              var topKeys = (json && typeof json === 'object') ? Object.keys(json).slice(0, 12).join(',') : 'n/a';
              postLog(epName, '域=' + (isSeller ? '卖家中心' : 'shopee') + ' top=[' + topKeys + '] 商品对象=' + items.length +
                      (sf2.length ? ' sold扫描: ' + sf2.join(' | ') : ' sold扫描:无') +
                      (pf2.length ? ' price扫描: ' + pf2.join(' | ') : ''));
              // 只有卖家中心域的未知接口才允许自动提取商品；买家域普通接口只诊断不入库
              if (isSeller && items.length) post({ endpoint: epName, items: items, authoritativeMonth: false, source: 'listen' });
            }).catch(function () {});
          } catch (e) {}
        }
        return resp;
      }, function (err) { throw err; });
    };
  }

  // ---- 包裹 XMLHttpRequest（best-effort，覆盖老接口路径）----
  try {
    var RealXHR = window.XMLHttpRequest;
    if (RealXHR) {
      var _open = RealXHR.prototype.open;
      var _send = RealXHR.prototype.send;
      var _setH = RealXHR.prototype.setRequestHeader;
      RealXHR.prototype.open = function (m, u) {
        this.__srUrl = (u != null ? u : '');
        this.__srMethod = m;
        this.__srHeaders = {};
        return _open.apply(this, arguments);
      };
      RealXHR.prototype.setRequestHeader = function (k, v) {
        try { this.__srHeaders[k] = v; _lastApiHeaders = this.__srHeaders; } catch (e) {}
        return _setH.apply(this, arguments);
      };
      RealXHR.prototype.send = function () {
        var self = this;
        var t = isTarget(self.__srUrl);
        logReq(self.__srUrl);
        if (t) {
          if (t === '/api/v4/item/get' || t === '/api/v4/pdp/get' || t === '/api/v4/pdp/get_pc') {
            captureReq(t, self.__srUrl, { method: self.__srMethod || 'GET', headers: self.__srHeaders });
          }
          var _on = this.onreadystatechange;
          this.onreadystatechange = function () {
            if (self.readyState === 4 && self.status >= 200 && self.status < 300) {
              try {
                var txt = self.responseText;
                if (txt) {
                  var json = JSON.parse(txt);
                  var items = extractItems(t, json);
                  var isAuth = authFor(t);
                  if (items.length) {
                    if (shouldShopCapture(t)) {
                      var sp2 = parseShopFromUrl();
                      updateShopCtx(sp2 && sp2.shopid, _shopCtx.name);
                      var shopPosts2 = buildShopProducts(t, items, { shopid: (sp2 && sp2.shopid) || _shopCtx.shopid, name: _shopCtx.name, source: 'shop' });
                      shopPosts2.forEach(function (p) { post(p); });
                      enqueueShopMonthUpgrade(shopPosts2);
                    } else if (isDetailEndpoint(t) && pageType() === 'detail') {
                      post({ endpoint: t, items: items, authoritativeMonth: isAuth, source: 'listen' });
                    }
                  }
                }
              } catch (e) {}
            }
            if (_on) { try { _on.apply(self, arguments); } catch (e) {} }
          };
        }
        return _send.apply(this, arguments);
      };
    }
  } catch (e) {}

  // ---- 主动再请求一次 item/get（MAIN world，自动带页面登录态/token，不被 403）----
  // 这是最稳健的兜底：用页面自己的身份（真实 header + cookie）再拉一次当前商品，
  // 拿到真实 item.sold（近30天月销）+ item.historical_sold（累计）。
  function parseIdsFromUrl() {
    var p = location.pathname || '';
    var s = location.search || '';
    var href = location.href || '';
    // 商品 URL 形如：/xxx商品名-i.627426868.41174106115（连字符拼接）或 /product/627426868/41174106115
    var m = p.match(/\/product\/(\d+)\/(\d+)/) ||            // /product/{shopid}/{itemid}
            p.match(/[-.]i\.(\d+)\.(\d+)/) ||                 // 名称-i.{shopid}.{itemid}（连字符或点前缀）
            p.match(/\/(\d+)\.(\d+)(?:[/?#]|$)/);             // 兜底：任意 /{shopid}.{itemid}
    if (!m) {
      // 兜底：SPA 可能把商品 ID 放在 hash 或完整 URL 里，再对 href 试一次
      m = href.match(/\/product\/(\d+)\/(\d+)/) ||
          href.match(/[-.]i\.(\d+)\.(\d+)/) ||
          href.match(/\/(\d+)\.(\d+)(?:[/?#]|$)/);
    }
    if (m) return { shopid: m[1], itemid: m[2] };
    // 兜底：从 query 参数取 item_id / shop_id（部分页面用这种形式）
    var si = s.match(/[?&]item_id=(\d+)/) || s.match(/[?&]itemid=(\d+)/);
    var sh = s.match(/[?&]shop_id=(\d+)/) || s.match(/[?&]shopid=(\d+)/);
    if (si && sh) return { shopid: sh[1], itemid: si[1] };
    return null;
  }

  // ---- 店铺页识别（用户要求：点进店铺才录，列表/每日发现页什么都不录）----
  function parseShopFromUrl() {
    var p = location.pathname || '';
    var s = location.search || '';
    var m = p.match(/\/shop\/(\d+)(?:[/?#]|$)/);
    if (m) return { shopid: m[1] };
    var sh2 = s.match(/[?&]shop[_]?id=(\d+)/) || s.match(/[?&]shop=(\d+)/);
    if (sh2) return { shopid: sh2[1] };
    // ★ 2026-08-26：识别 slug 形式店铺 URL（shopee.tw/<shop-slug>?categoryId=...&itemId=...）。
    //   旧逻辑不认 slug → 店铺页被误判为「浏览」、shopid 取不到 → 店铺商品全部被丢弃（月销=0 的又一诱因）。
    //   判定：路径是「单段、非保留路由、且非商品详情(-i.)」——即形如 /kdmyzbt7pb。
    var seg = p.replace(/^\//, '').replace(/\/+$/, '');
    var RESERVED = /^(search|shop|product|daily_discover|discover|cart|checkout|buyer|user|me|login|brand|mall|coin|voucher|promo|category|flash_sale|dailyfinds|today|tag|collection|official|i|item|rating|review)$/i;
    if (seg && seg.indexOf('/') < 0 && !RESERVED.test(seg) && (location.href || '').indexOf('-i.') < 0) {
      return { slug: seg, shopid: null }; // shopid 未知，靠 get_shop_tab 响应里的 item_data.shopid 补全
    }
    return null;
  }

  // 页面类型：detail=商品详情页；shop=店铺页；browse=搜索/每日发现/首页等列表页
  function pageType() {
    if (parseIdsFromUrl()) return 'detail';
    if (parseShopFromUrl()) return 'shop';
    return 'browse';
  }

  function isShopEndpoint(t) {
    return t === '/api/v4/shop/get_shop_tab' || t === '/api/v4/shop/rcmd_items' ||
           t === '/api/v4/shop/hot_sales' || t === '/api/v4/shop/get_shop_seo';
  }
  function isDetailEndpoint(t) {
    return t === '/api/v4/item/get' || t === '/api/v4/pdp/get' || t === '/api/v4/pdp/get_pc' || t === '/api/v4/item/get_rating';
  }

  // 店铺捕获判定：get_shop_tab/hot_sales/get_shop_seo 只在店铺页发出，直接判为店铺捕获
  // （不依赖 URL 解析，Shopee 店铺 URL 形态多变也能稳抓）；rcmd_items 在详情页也可能出现，
  // 仅当页面确为店铺页时才捕获，避免把详情页推荐位误归到店铺。
  function shouldShopCapture(t) {
    if (t === '/api/v4/shop/get_shop_tab' || t === '/api/v4/shop/hot_sales' || t === '/api/v4/shop/get_shop_seo') return true;
    if (t === '/api/v4/shop/rcmd_items') return pageType() === 'shop';
    return false;
  }

  // 当前店铺上下文（把商品归到店铺）
  var _shopCtx = { shopid: null, name: null };
  function updateShopCtx(shopid, name) {
    if (shopid) _shopCtx.shopid = String(shopid);
    if (name) _shopCtx.name = name;
    else if (shopid && !_shopCtx.name) _shopCtx.name = '店铺' + shopid;
  }

  // 从店铺接口响应提取商品：月销优先用 icsc.monthly_sold_count_text（页面显示「月銷量 N」，准确），
  // 缺失时回退到裸字段。返回待 post 的 payload 数组（每条带 shopCapture 标记）。
  function buildShopProducts(endpoint, items, shop) {
    var out = [];
    // source 区分店铺页(shop) 与 PDP 推荐卡(pdp_card)，content.js 用不同阈值过滤
    var source = (shop && shop.source) || 'shop';
    var defaultShopName = (shop && shop.name) || ('店铺' + ((shop && shop.shopid) || ''));
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      // ★ 统一走单源 S.resolveItem：自动处理 item_data 嵌套、icsc 深搜、端点化字段语义。
      //   r 已含【端点化换算后】的价格（get_shop_tab ×10、get_item_cards ×100000 → 元）与逐卡 shopid，
      //   直接下发给 content.js，不再发原始值（避免 content.js 重复/漏换算，且扁平化后无法再解 item_data）。
      var r = S.resolveItem(it, endpoint);
      if (!r) continue;
      var cardShopName = source === 'pdp_card' ? ('店铺' + r.shopid) : defaultShopName;
      out.push({
        endpoint: endpoint,
        items: [{
          itemid: r.itemid, shopid: r.shopid,
          name: r.name || '', price: r.price, img: r.img || '',
          // ★ tri-state：月销允许 null（未知），绝不补 0（见复盘 §0 错误5）
          month_sold: r.month, sold_total: r.total,
          shopCapture: true, shopId: r.shopid, shopName: cardShopName,
          _icscMonth: r.month, _hist: r.total, _source: source
        }],
        authoritativeMonth: false, source: source, shopCapture: true,
        shopId: r.shopid, shopName: cardShopName
      });
    }
    return out;
  }

  // ---- 店铺月销精修：对「icsc 月销缺失且累计>=30」的商品，借店铺页真实 header 重发 item/get，
  //   拿权威月销(item.sold)。节流 1 件/3s、单店上限 30，控风控。----
  var _shopUpgradeQ = [];
  var _shopUpgradeActive = false;
  function enqueueShopMonthUpgrade(shopPosts) {
    for (var i = 0; i < shopPosts.length; i++) {
      var it = shopPosts[i] && shopPosts[i].items && shopPosts[i].items[0];
      if (!it) continue;
      if ((it._icscMonth == null || it._icscMonth <= 0) && (it._hist == null || it._hist >= 30)) _shopUpgradeQ.push(it);
    }
    if (_shopUpgradeQ.length > 30) _shopUpgradeQ.length = 30;
    if (!_shopUpgradeActive && _shopUpgradeQ.length) { _shopUpgradeActive = true; pumpShopUpgrade(); }
  }
  function pumpShopUpgrade() {
    if (!_shopUpgradeQ.length) { _shopUpgradeActive = false; return; }
    var it = _shopUpgradeQ.shift();
    shopMonthUpgradeFetch(it);
  }
  function shopMonthUpgradeFetch(it) {
    var cap = _capturedReqs['/api/v4/shop/get_shop_tab'] || _capturedReqs['/api/v4/shop/rcmd_items'] || _capturedReqs['/api/v4/shop/hot_sales'];
    var init = (cap && cap.init) ? cap.init : buildInit();
    if (init && init.headers) {
      var f = headerEntries(init.headers);
      for (var h in f) { if (f.hasOwnProperty(h) && UNSAFE_HEADERS.test(h)) delete f[h]; }
      f['Accept'] = 'application/json';
      if (!f['X-Requested-With']) f['X-Requested-With'] = 'XMLHttpRequest';
      init = Object.assign({}, init, { headers: f });
    }
    var url = 'https://shopee.tw/api/v4/item/get?itemid=' + encodeURIComponent(it.itemid) + '&shopid=' + encodeURIComponent(it.shopid);
    if (!realFetch) { setTimeout(pumpShopUpgrade, 3000); return; }
    realFetch(url, init).then(function (r) {
      if (!r.ok) { postLog('店铺月销精修', 'status=' + r.status); setTimeout(pumpShopUpgrade, 3000); return; }
      r.clone().json().then(function (json) {
        // ★ 反转依赖：item/get 仅作「覆盖层」。用 S.resolveItem 统一解析，
        //   仅当拿到具体月销才覆盖卡片 icsc 值；失败/未知则【保留卡片 icsc 值，绝不清零】。
        var item = findItem(json, true) || findItem(json, false);
        var r2 = item ? S.resolveItem(item, 'item/get') : null;
        if (r2 && r2.month != null) {
          post({
            endpoint: '/api/v4/item/get',
            items: [{
              itemid: it.itemid, shopid: it.shopid, name: it.name, price: it.price, img: it.img,
              month_sold: r2.month, sold_total: (r2.total != null ? r2.total : it.sold_total),
              shopCapture: true, shopId: it.shopId, shopName: it.shopName,
              _icscMonth: r2.month, _overlayMonth: r2.month, _overlay: true
            }],
            authoritativeMonth: true, source: 'shop-upgrade', shopCapture: true, shopId: it.shopId, shopName: it.shopName
          });
          postLog('店铺月销精修', '✓ ' + it.itemid + ' 月销=' + r2.month + '（覆盖卡片 icsc）');
        } else {
          // ★ 不再清零：item/get 无月销(未知) → 保留卡片 icsc 已得值
          postLog('店铺月销精修', 'item/get 无月销(未知)，保留卡片 icsc 值（不清零）');
        }
        setTimeout(pumpShopUpgrade, 3000);
      }).catch(function (e) { setTimeout(pumpShopUpgrade, 3000); });
    }).catch(function (e) { setTimeout(pumpShopUpgrade, 3000); });
  }

  // 用页面真实 header 构造一个尽可能像「页面自发」的请求 init。
  // ★ 2026-08-20 修复：自己构造 URL 时不能复制与 URL 绑定的签名头，否则会被虾皮 WAF
  //   识别为异常请求，触发 verify/traffic/error 风控页。只保留通用身份头（Cookie/UA 等）。
  var UNSAFE_HEADERS = /^(x-signature|x-shopee-client-signature|x-sgw-auth|af-ac-enc-dat|x-api-key|x-csrftoken|x-requested-id|x-shopee-client-time|x-shopee-language|x-request-id|x-amz-cf-|x-cache|x-edge-|x-forwarded-|x-real-ip|cf-|cdn-)/i;
  // 兼容 Headers 对象 / 数组 / 普通对象
  function headerEntries(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function') { try { h.forEach(function (v, k) { out[k] = v; }); } catch (e) {} return out; }
    if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) { if (h[i] && h[i].length >= 2) out[h[i][0]] = h[i][1]; } return out; }
    if (typeof h === 'object') { for (var k in h) { if (h.hasOwnProperty(k)) out[k] = h[k]; } return out; }
    return out;
  }
  function buildInit(extra) {
    var init = { method: 'GET', credentials: 'include' };
    var headers = headerEntries(_lastApiHeaders);
    for (var k in headers) {
      if (!headers.hasOwnProperty(k)) continue;
      if (UNSAFE_HEADERS.test(k)) delete headers[k];
    }
    headers['Accept'] = 'application/json';
    if (!headers['X-Requested-With']) headers['X-Requested-With'] = 'XMLHttpRequest';
    if (!headers['User-Agent'] && navigator.userAgent) headers['User-Agent'] = navigator.userAgent;
    if (extra) { for (var k2 in extra) { if (extra.hasOwnProperty(k2)) headers[k2] = extra[k2]; } }
    init.headers = headers;
    return init;
  }

  // 替换/新增 URL query 参数（用于 pdp/get_pc 的 detail_level 等变体重放试验）
  function withQuery(url, kv) {
    try {
      var u = url.split('?')[0];
      var map = {};
      var q = (url.split('?')[1] || '').split('&');
      for (var i = 0; i < q.length; i++) {
        if (!q[i]) continue;
        var p = q[i].split('=');
        map[p[0]] = p.slice(1).join('=');
      }
      for (var k in kv) { if (kv.hasOwnProperty(k)) map[k] = kv[k]; }
      var parts = [];
      for (var k2 in map) { if (map.hasOwnProperty(k2)) parts.push(k2 + '=' + map[k2]); }
      return u + '?' + parts.join('&');
    } catch (e) { return url; }
  }

  var _dumpedDetail = false; // 是否已 dump 过首条 200 响应的详细结构（诊断用）
  var _gotItem = false;      // item/get 是否已成功取到商品（用于防止 pdp 兜底污染）

  // ★ 每条 200 响应都做精简结构 dump；首条再做详细 dump。不再局限于「首条」——
  //   主动重放可能前几次被限流(90309999)，真正成功的响应在更后面，必须每条都看。
  function dumpResp(json, label) {
    try {
      if (!json || typeof json !== 'object') { postLog('active-refetch', '【' + label + '】响应非对象'); return; }
      var topKeys = Object.keys(json).slice(0, 12);
      var d = json.data;
      var dinfo = d == null ? 'data=null'
        : (Array.isArray(d) ? 'data=array(' + d.length + ')'
        : 'data.keys=[' + Object.keys(d).slice(0, 12).join(',') + ']');
      var errStr = '';
      if (json.error != null) errStr = ' error=' + (typeof json.error === 'object' ? JSON.stringify(json.error).slice(0, 80) : String(json.error));
      var emStr = '';
      if (json.error_msg != null && json.error_msg !== '') emStr = ' error_msg=' + String(json.error_msg).slice(0, 80);
      postLog('active-refetch', '【' + label + '】top=[' + topKeys.join(',') + '] ' + dinfo + errStr + emStr);
      // data.item 结构 + 全响应 sold 字段扫描（锁定真实字段名）
      try {
        var it = d && typeof d === 'object' && !Array.isArray(d) && (d.item || (d.data && d.data.item));
        var itKeys = (it && typeof it === 'object') ? Object.keys(it).slice(0, 24).join(',') : '';
        var sf = dumpSoldFields(json, 'root', [], 15);
        postLog('active-refetch', '【' + label + ' 详情】' + (itKeys ? 'item.keys=[' + itKeys + '] ' : '') +
                (sf.length ? 'sold扫描: ' + sf.join(' | ') : 'sold扫描:无'));
      } catch (eD) {}
      if (_dumpedDetail) return;
      _dumpedDetail = true;
      // 详细版（仅首条）：顶层 key 的 type + 前 80 字符
      var detail = topKeys.slice(0, 8).map(function (k) {
        var v = json[k];
        if (v == null) return k + ':null';
        var t = Array.isArray(v) ? 'arr' : typeof v;
        if (t === 'string') return k + ':str(' + v.length + ')';
        if (t === 'object') {
          try { var s = JSON.stringify(v); return k + ':obj(' + s.length + ') ' + s.slice(0, 80); } catch (e) { return k + ':obj'; }
        }
        return k + ':' + t + '=' + String(v).slice(0, 80);
      }).join(' | ');
      postLog('active-refetch', '【响应详情】' + detail);
    } catch (e) {}
  }

  function doRefetch(opts) {
    if (!realFetch) { postLog('active-refetch', 'realFetch 不可用'); return; }
    if (opts.skipIfGot && _gotItem) return; // item/get 已成功，pdp 兜底不必再发
    // ★ 2026-08-21：借用页面真实请求 init 时，必须过滤掉与 URL 绑定的签名/安全头，
    //   否则用 pdp/get_pc 的 header 发 item/get 会被虾皮 WAF 识别为异常，导致 403/风控。
    var init = opts.init || buildInit();
    if (init.headers && typeof init.headers === 'object') {
      var filtered = headerEntries(init.headers);
      for (var hk in filtered) {
        if (!filtered.hasOwnProperty(hk)) continue;
        if (UNSAFE_HEADERS.test(hk)) delete filtered[hk];
      }
      filtered['Accept'] = 'application/json';
      if (!filtered['X-Requested-With']) filtered['X-Requested-With'] = 'XMLHttpRequest';
      init = Object.assign({}, init, { headers: filtered });
    }
    postLog('active-refetch', '发起 ' + (opts.label || '') + ' url=' + opts.url.slice(0, 90));
    realFetch(opts.url, init).then(function (r) {
      postLog('active-refetch', 'status=' + r.status + (opts.label ? ' (' + opts.label + ')' : ''));
      if (!r.ok) return;
      r.clone().json().then(function (json) {
        dumpResp(json, opts.label || opts.endpoint || '响应');
        // 深度搜索商品对象：item/get 必须含销量字段；pdp/get 也要求含销量字段（避免抓到无销量的 model）
        var requireSales = (opts.endpoint === '/api/v4/item/get' || opts.endpoint === '/api/v4/pdp/get_pc');
        var item = findItem(json, requireSales);
        // ★ 兜底：requireSales 找不到时，宽松再找一次（只要求 itemid 匹配当前商品），
        //   因为 pdp/get_pc 等新接口的销量字段名可能未知——先交给 content.js 做最终判断。
        if (!item && requireSales) {
          var loose = findItem(json, false);
          if (loose && String(loose.itemid != null ? loose.itemid : loose.item_id) === String(opts.itemid || '')) {
            item = loose;
            postLog('active-refetch', '⚠ 销量字段名未识别，采用宽松匹配(含itemid)，月销可能需字段名校正');
          }
        }
        if (item) {
          var okId = String(item.itemid != null ? item.itemid : item.item_id);
          var reqId = String(opts.itemid || '');
          if (reqId && okId && okId !== reqId) {
            postLog('active-refetch', 'itemid 不符(响应=' + okId + ' 请求=' + reqId + ') 跳过');
            return;
          }
          _gotItem = true;
          var r = S.resolveItem(item, opts.endpoint);
          var isAuthMonth = (S.matchEndpoint(opts.endpoint) === 'item/get' || S.matchEndpoint(opts.endpoint) === 'item/get_rating');
          post({
            endpoint: opts.endpoint,
            items: [item],
            authoritativeMonth: isAuthMonth,
            source: 'active-refetch'
          });
          postLog('active-refetch',
                  '✓ 月销=' + (r ? r.month : '?') + ' 总销=' + (r ? r.total : '?') + ' 价=' + item.price + ' 图=' + (item.image || (item.images && item.images[0]) ? '有' : '无') + ' 名=' + (item.name ? '有' : '无'));
        } else {
          postLog('active-refetch',
                  '响应无商品对象 keys=[' + ((json && typeof json === 'object') ? Object.keys(json).join(',') : 'n/a') + ']');
        }
      }).catch(function (e) {
        postLog('active-refetch', 'json 解析失败: ' + e.message);
      });
    }).catch(function (e) {
      postLog('active-refetch', '请求异常: ' + e.message);
    });
  }

  // ★ 2026-08-19 二次重构（打破风控）：
  //   诊断证实：① 买家页 pdp/get_pc 响应【不包含销量字段】（models[].sold 全 null）；
  //   ② 盲发 item/get 必 403（发出时页面真实 header 还没捕获到，buildInit 缺关键反爬 header）。
  //   新策略：
  //   - 有页面真实请求捕获时，【借它的完整 init（含全部反爬 header）】发 item/get —— 接口级 WAF
  //     只认 header，页面自己的请求能 200，同 header 的 item/get 大概率也能 200（权威月销来源）。
  //   - item/get 最多尝试 3 次（_itemGetAttempts），避免 SGW 限流（90309999）。
  //   - 无捕获时不盲发，等页面自己发请求后由重试触发。
  //   - content.js 每次点「立即同步」都会发 __SR_REQUEST_CAPTURE__，会重置尝试次数，
  //     确保用户主动同步时总能再试一次。
  var _itemGetAttempts = 0;  // 借 header 发 item/get 的尝试次数
  var _itemGetMaxAttempts = 1; // 2026-08-25：买家端 item/get 已被 WAF 403，只试 1 次，省风控
  var _variantTried = false; // pdp/get_pc 的 detail_level 变体只试 1 次
  var _waitRetries = 0;      // 无捕获时的等待重试次数
  var _urlParseRetries = 0;  // URL 解析失败时的重试次数（SPA 路由可能延迟才写入商品 ID）

  function tryAltDetailEndpoints(ids) {
    if (_gotItem) return;
    var itemId = encodeURIComponent(ids.itemid);
    var shopId = encodeURIComponent(ids.shopid);
    var init = buildInit();
    // 备选 1：item/get_rating（虾皮PC常带商品基本信息，可能含 sold）
    postLog('active-refetch', 'item/get 403，尝试 item/get_rating 取月销');
    doRefetch({
      url: 'https://shopee.tw/api/v4/item/get_rating?item_id=' + itemId + '&shop_id=' + shopId,
      init: init,
      label: 'item/get_rating',
      endpoint: '/api/v4/item/get_rating',
      itemid: ids.itemid,
      skipIfGot: true
    });
    // 备选 2：移动端 pdp/get
    setTimeout(function () {
      if (_gotItem) return;
      postLog('active-refetch', 'item/get_rating 无结果，尝试 pdp/get');
      doRefetch({
        url: 'https://shopee.tw/api/v4/pdp/get?item_id=' + itemId + '&shop_id=' + shopId,
        init: init,
        label: 'pdp/get',
        endpoint: '/api/v4/pdp/get',
        itemid: ids.itemid,
        skipIfGot: true
      });
    }, 2000);
  }

  function activeRefetch() {
    if (!realFetch) return;
    var ids = parseIdsFromUrl();
    if (!ids) {
      // SPA 路由可能延迟才把商品 ID 写入 URL，重试若干次后再放弃（避免「URL 无法解析」误判）
      _urlParseRetries++;
      if (_urlParseRetries <= 8) {
        postLog('active-refetch', 'URL 暂无法解析 shopid/itemid（SPA未就绪？），重试(' + _urlParseRetries + '/8)');
        setTimeout(activeRefetch, 1500);
      } else {
        postLog('active-refetch', 'URL 始终无法解析 shopid/itemid，停止主动抓取');
      }
      return;
    }
    _urlParseRetries = 0;
    var itemId = encodeURIComponent(ids.itemid);
    var shopId = encodeURIComponent(ids.shopid);
    var cap = _capturedReqs['/api/v4/item/get'] || _capturedReqs['/api/v4/pdp/get'] || _capturedReqs['/api/v4/pdp/get_pc'];
    if (cap && cap.url && (cap.url.indexOf('itemid=' + ids.itemid) >= 0 || cap.url.indexOf('item_id=' + ids.itemid) >= 0)) {
      var capEp = (cap.url.indexOf('/api/v4/item/get') >= 0) ? '/api/v4/item/get'
                : (cap.url.indexOf('/api/v4/pdp/get_pc') >= 0) ? '/api/v4/pdp/get_pc'
                : '/api/v4/pdp/get';
      // 页面捕获的是 pdp 类接口（无销量字段）→ 借它的完整 header 发 item/get（唯一权威月销来源）
      if (capEp !== '/api/v4/item/get' && _itemGetAttempts < _itemGetMaxAttempts) {
        _itemGetAttempts++;
        postLog('active-refetch', '借页面真实请求header 发 item/get（尝试 ' + _itemGetAttempts + '/' + _itemGetMaxAttempts + '）');
        doRefetch({
          url: 'https://shopee.tw/api/v4/item/get?itemid=' + itemId + '&shopid=' + shopId,
          init: cap.init ? cap.init : buildInit(),
          label: '借header-item/get',
          endpoint: '/api/v4/item/get',
          itemid: ids.itemid
        });
        // 1s 后若 item/get 失败，再试 item_id/shop_id 参数版本
        setTimeout(function () {
          if (_gotItem) return;
          postLog('active-refetch', '尝试 item/get item_id/shop_id 参数版');
          doRefetch({
            url: 'https://shopee.tw/api/v4/item/get?item_id=' + itemId + '&shop_id=' + shopId,
            init: cap.init ? cap.init : buildInit(),
            label: 'item/get-underscore',
            endpoint: '/api/v4/item/get',
            itemid: ids.itemid,
            skipIfGot: true
          });
        }, 1200);
        // 重放页面真实请求作为后备（拿价格/名称/图片）
        setTimeout(function () {
          doRefetch({
            url: cap.url,
            init: cap.init ? cap.init : buildInit(),
            label: '重放页面真实请求',
            endpoint: capEp,
            itemid: ids.itemid,
            skipIfGot: true
          });
        }, 2400);
      } else {
        // 已捕获 item/get 或已试过 → 重放页面真实请求
        doRefetch({
          url: cap.url,
          init: cap.init ? cap.init : buildInit(),
          label: '重放页面真实请求',
          endpoint: capEp,
          itemid: ids.itemid,
          skipIfGot: (capEp === '/api/v4/item/get' && _gotItem)
        });
      }
      // pdp/get_pc 变体 detail_level=1
      if (capEp === '/api/v4/pdp/get_pc' && !_gotItem && !_variantTried) {
        _variantTried = true;
        setTimeout(function () {
          if (_gotItem) return;
          doRefetch({
            url: withQuery(cap.url, { detail_level: '1' }),
            init: cap.init ? cap.init : buildInit(),
            label: 'detail_level=1变体',
            endpoint: capEp,
            itemid: ids.itemid
          });
        }, 3600);
      }
      // 若 item/get 仍 403，尝试备选端点
      setTimeout(function () { tryAltDetailEndpoints(ids); }, 5200);
      return;
    }
    // 没有页面真实请求：不盲发 item/get，等页面首屏请求发出后重试
    _waitRetries++;
    if (_waitRetries <= 4) {
      postLog('active-refetch', '暂无页面真实请求捕获，等待页面加载后重试(' + _waitRetries + '/4)');
      setTimeout(activeRefetch, 2500);
    } else {
      postLog('active-refetch', '页面始终未发商品请求（可能非详情页），停止等待');
    }
  }

  // 暴露已捕获的请求 URL，供诊断
  try {
    window.__SR_CAPTURED__ = function () {
      var out = [];
      for (var k in _capturedReqs) { if (_capturedReqs.hasOwnProperty(k) && _capturedReqs[k].url) out.push(k + ' -> ' + _capturedReqs[k].url); }
      return out;
    };
  } catch (e) {}

  // 通知内容脚本：嗅探器已就位（用于日志/诊断）
  // ★ 延迟 500ms：inject.js 是 MAIN world，比 ISOLATED world 的 content.js 先执行，
  //   立即 postMessage 会在 content.js 注册监听器之前丢失（诊断里 inject_ready 一直 false 的原因）。
  setTimeout(function () { try { window.postMessage({ __SR_INJECT_READY__: true, version: SR_VERSION }, '*'); } catch (e) {} }, 500);

  // ★ 定期把请求日志推送给 content.js —— 诊断里 all_requests 读取不到 MAIN world 属性
  // （ISOLATED world 无法读 MAIN world 的 window.__SR_REQ_LOG__），必须靠 postMessage 同步。
  setInterval(function () {
    try {
      window.postMessage({ __SR_REQ_LOG_SYNC__: true, urls: REQ_LOG.slice(-60) }, '*');
    } catch (e) {}
  }, 2500);

  // 监听 content.js 发来的「请立即抓取」指令（无需等定时器）
  window.addEventListener('message', function (ev) {
    try {
      var d = ev.data;
      if (d && d.__SR_REQUEST_CAPTURE__) {
        // 用户主动同步时重置尝试次数，允许再试一次 item/get（之前可能因 header 未就绪失败）
        _itemGetAttempts = 0;
        activeRefetch();
      }
    } catch (e) {}
  });

  // 延迟主动抓取：等页面 cookie/token 就绪（首屏渲染一般已完成）。
  // ★ 2026-08-26：虾皮为 SPA，URL 中的商品 ID 可能延迟才写入，若只在加载瞬间判定一次，
  //   会因「URL 无法解析」而永远不触发主动抓取。改为轮询重试：最多 10 次（每次 1.2s），
  //   一旦识别到商品详情页即发起 activeRefetch；列表/店铺页不会误触发。
  (function scheduleActiveRefetch() {
    if (parseIdsFromUrl()) { setTimeout(activeRefetch, 4000); return; }
    var _initRetry = 0;
    var _poll = setInterval(function () {
      _initRetry++;
      if (parseIdsFromUrl()) { clearInterval(_poll); setTimeout(activeRefetch, 1500); }
      else if (_initRetry >= 10) { clearInterval(_poll); }
    }, 1200);
  })();
})();
