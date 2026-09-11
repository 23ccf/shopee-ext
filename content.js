// content.js — ISOLATED world 主逻辑 + MAIN world inject.js 桥接
// 核心策略：inject.js 偷听页面自己成功发出的 /api/v4/item/get，把真实月销量经 postMessage 传进来；
//          同时保留 SSR/DOM 解析作为兜底，确保任何场景都有销量数据。
(function () {
  'use strict';

  // ★ 单一真相源：由 sales_schema.js 注入（manifest 已注册到 ISOLATED world）。
  //   所有端点的「月销/总销/周销/价格/id」字段语义集中定义，杜绝此前 15+ 函数各自硬编码导致的反复算错。
  var S = globalThis.__SR_SCHEMA__;

  var TAG = '[SR]';
  var seenIds = {};          // 当前页面已处理过的商品 key
  var sentKeys = {};         // 本次会话已发送给后台的商品 key（避免重复计数）
  var capturedItems = {};    // key -> 从页面接口真实响应捕获的销量 {month_sold,total_sold,week_sold,price,...}
  var sessionCount = 0;      // 浮窗：本次录制计数
  var currentDetailItemId = null; // ★ 2026-08-26：当前详情页商品 itemid（用于店铺捕获回填其真实月销）
  var apiCaptureCount = 0;   // inject.js 成功拦截到的接口商品数
  // ★ 2026-08-20：浏览即录（无需点进商品）
  var browseCapture = true;  // 开关：true=浏览列表页即自动捕获所有商品的月/周/总销量
  var browseCount = 0;       // 本次已扫到的列表商品件数（含未发送）
  var browseMonthCount = 0;  // 其中含真实月销量的件数
  var sentMonth = {};        // ★ 2026-09-11：key -> 该商品已发送的月销（供「录完这一页」回报月销≥30 件数）
  var sentKeyAll = {};       // 本次会话已发送过的全部 key（不受 isUpdate 影响，用于回报总件数）
  // ★ 2026-09-11：「录完这一页」进行中的计数器。
  //   不能用 sentKeys 差集：店铺页走的是 sendProduct(...,true)（isUpdate），
  //   那条路径根本不写 sentKeys，导致「新增 N 件」在店铺页恒为 0。
  var pageRecTally = null;   // { keys:{key:maxMonth}, n:0, m30:0 }
  var apiInterceptLog = [];  // 最近几条拦截日志（用于诊断）
  var reqLog = [];           // inject.js 定期推送的页面请求 URL 列表（跨 world 读取失败，改用 postMessage）
  var capturedUrlLog = [];   // 捕获到商品数据的接口请求 URL（诊断用）
  var lastShopDiag = null;  // ★ 诊断：inject.js 发来的店铺/推荐卡原始样本 + 逐件解析结果
  var pendingCount = 0;      // 浮窗：后台待同步计数
  var recordingOn = true;
  var floatEl = null;
  var injectVersion = '';    // inject.js 版本号（用于确认扩展是否加载新代码）
  var ON_BUYER = !/seller|admin/i.test(location.hostname);

  // enrich 队列：对列表页没有月销量/价格的商品，fetch 详情页 HTML 补全
  var enrichQueue = [];
  var enrichRunning = 0;
  var ENRICH_CONCURRENCY = 2;
  var ENRICH_INTERVAL = 400;

  function log() { var a = [TAG]; for (var i = 0; i < arguments.length; i++) a.push(arguments[i]); console.log.apply(console, a); }
  function warn() { var a = ['[SR]']; for (var i = 0; i < arguments.length; i++) a.push(arguments[i]); console.warn.apply(console, a); }

  // ---- 数字解析 ----
  // 数字解析：兼容「已售出 211」「月銷量 77」「1萬+」「1000+」「1,492」等虾皮文本格式
  // ★ 2026-08-19（本轮）：改为正则提取，支持带中文前缀的销量文案 ——
  //   item_card_display_sold_count 的 *_text 字段就是「月銷量 363」「已售出 1000+」这种文本，
  //   原实现 parseFloat 直接得 NaN（如 parseFloat("月銷量 77")）。
  function parseNum(str) {
    if (str == null) return undefined;
    str = String(str).trim().toLowerCase().replace(/,/g, '').replace(/\+/g, '');
    if (!str) return undefined;
    var m = str.match(/(\d+(?:\.\d+)?)\s*([kw万萬]?)/);
    var core = (m && m[1]) || str;
    var mul = 1;
    if (m && m[2] === 'k') mul = 1000;
    else if (m && (m[2] === 'w' || m[2] === '万' || m[2] === '萬')) mul = 10000;
    var n = parseFloat(core);
    return isNaN(n) ? undefined : n * mul;
  }

  // 虾皮 price 字段常见单位为 1e-5（原币 * 100000）。
  // 对任意来源的价格做归一化：若数值过大则反复除以 100000，直到落在合理区间。
  // ★ 2026-08-26：已知接口的价格由 sales_schema.js 的 S.resolveItem → S.convertPrice 端点感知换算（见 handleApiCapture）；
  //   此 normalizePrice 仅保留给「DOM 文本价格」(extractPriceFromDOMText) 的兜底。
  function normalizePrice(v) {
    if (v == null) return undefined;
    var n = (typeof v === 'number') ? v : parseFloat(String(v).replace(/,/g, ''));
    if (isNaN(n)) return undefined;
    // 虾皮商品价格极少超过 100 万新台币；若过大则视为 raw 单位，最多归一化两次
    for (var i = 0; i < 2 && n > 1000000; i++) n = n / 100000;
    return n;
  }

  // ---- 端点感知价格换算（2026-08-19 修复·40 件价格 ×10 bug 的根治）----
  // 虾皮不同接口的价格单位完全不同，必须按请求端点换算成「整数新台币」：
  //   ① 详情接口 item/get、pdp/get、pdp/get_pc、get_rating：原币 × 100000（如 19900000 → 199）
  //   ② 列表接口 get_shop_tab、rcmd_items、hot_sales/get_item_cards、search_items、recommend：
  //      元 × 10 带 0.1 精度（如 3597.5 = 359.75 元）→ ÷10 后 floor 取整（实测与旧 DOM 提取口径
  //      $359 完全一致：floor(3597.5/10)=359、floor(4486.5/10)=448、floor(1594.2/10)=159）
  //   ③ get_shop_seo：分（元 × 100，如 100000 分 = 1000 元「補發專用」）→ ÷100 取整
  //   ④ 卖家中心 seller.shopee.tw：已是元 → 原值取整
  // ★ 2026-08-20：优先从 item_basic / item 子对象取值，列表接口的价格/图片/店名常放在嵌套里
  function pickValue(it, keys) {
    if (!it || typeof it !== 'object') return undefined;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (it[k] != null) return it[k];
    }
    var inner = it.item_basic || it.item;
    if (inner && typeof inner === 'object') {
      for (var j = 0; j < keys.length; j++) {
        var k2 = keys[j];
        if (inner[k2] != null) return inner[k2];
      }
    }
    return undefined;
  }
  // ★ 2026-08-21：列表接口（shop/get_shop_tab、rcmd_items 等）常把真实字段放在
  //   item_basic / item 子对象里，而顶层只有 item_card_display_sold_count。
  //   先把子对象里的销量/价格/名称/图片等关键字段合并到顶层，避免顶层字段缺失导致月销=0。
  function mergeItemBasic(it) {
    if (!it || typeof it !== 'object') return it;
    var inner = it.item_basic || it.item;
    if (!inner || typeof inner !== 'object') return it;
    var salesKeys = ['sold', 'historical_sold', 'monthly_sold', 'month_sold', 'sold_count', 'recent_sold',
                     'month_sales', 'sales', 'sold_30d', 'recent_sales', 'sales_30d', 'month_sold_count',
                     'sold_in_30_days', 'sold30', 'monthSold', 'sold_total', 'total_sold', 'cumulative_sold',
                     'global_sold', 'total_sales', 'sold_accumulate'];
    var basicKeys = ['price', 'price_min', 'price_max', 'name', 'title', 'image', 'image_url', 'images',
                     'shop_name', 'shopname', 'shop_location', 'location', 'shop_loc', 'item_rating',
                     'liked_count', 'liked', 'stock'];
    salesKeys.concat(basicKeys).forEach(function (k) {
      if (it[k] == null && inner[k] != null) it[k] = inner[k];
    });
    return it;
  }
  // ---- 从页面真实渲染后的可见文本提取销量（不依赖任何 API / 不受 CSP / 403 影响）----
  // 这是目前唯一稳定可用的真实数据源：用户浏览器把商品数据渲染进了 DOM。
  // 注意：虾皮不同页面场景下「已售出 X」语义不同：
  //   - 列表/搜索/店铺商品卡：「已售出 X」= 近30天月销（和接口 item.sold 一致）
  //   - 商品详情页：        「已售出 X」= 累计总销（historical_sold）
  // mode='card'  用于列表卡片；mode='detail' 用于详情页；mode='auto' 两边都兜底（诊断用）。
  function extractSalesFromLiveDOM(text, mode) {
    var res = { month_sold: null, total_sold: null, week_sold: null };
    if (!text) return res;
    mode = mode || 'auto';
    // 月销量（近30天）：明确文案「月銷 X / 近30天 X / 30天 X」
    var monthPatterns = [
      /近\s*30\s*天[售出]*\s*([\d.,]+\s*[kKw万萬]?\+?)/,
      /([\d.,]+\s*[kKw万萬]?\+?)\s*近\s*30\s*天[售出]*/,
      /30\s*天[售出]*\s*([\d.,]+\s*[kKw万萬]?\+?)/,
      /([\d.,]+\s*[kKw万萬]?\+?)\s*30\s*天[售出]*/,
      /月[銷销]量?\s*([\d.,]+\s*[kKw万萬]?\+?)/,
      /([\d.,]+\s*[kKw万萬]?\+?)\s*月[銷销]量?/
    ];
    for (var i = 0; i < monthPatterns.length; i++) {
      var mm = text.match(monthPatterns[i]);
      if (mm) { var tm = parseNum(mm[1]); if (tm != null) { res.month_sold = tm; break; } }
    }
    // 「已售出 X / X 已售出」：在所有场景都是【累计总销量】（已验证：详情页「已售出 2,000+」= historical_sold=2000）。
    // ★ 绝不把它当月销——月销只来自 API item.sold（列表/详情一致）或 DOM「月銷 X / 近30天 X」文案。
    // 之前误把「已售出」当月销，导致月销被虚高成累计值（本商品月销应 531 却显示 2000）。
    var m = text.match(/已售[出]?\s*([\d.,]+\s*[kKw万萬]?\+?)/) ||
            text.match(/([\d.,]+\s*[kKw万萬]?\+?)\s*已售[出]?/);
    if (m) {
      var t = parseNum(m[1]);
      if (t != null) {
        if (res.total_sold == null || res.total_sold === 0) res.total_sold = t; // 仅作累计总销
      }
    }
    if (res.month_sold != null && res.month_sold > 0) res.week_sold = Math.round(res.month_sold / 4.345);
    return res;
  }

  // ---- 从详情页 DOM 文本提取商品真实售价 ----
  // 虾皮详情页常见文案：$199 $299 6.7折 賣場優惠券 現折$10 現折$20 6期x $33 運費：$0 起
  // 关键观察：商品真实售价通常**没有上下文关键词**，是个孤立的 $XX；而优惠券/运费/分期
  // 一定紧跟「折/現折/運費/優惠/分期/利率/折扣」这些关键词。
  // 策略：先用宽正则收集所有 $XX 类数字，再按下述三步过滤：
  //   ① 排除紧邻关键词(折/優惠券/運費/分期/利率/折扣/0利率)附近的数字；
  //   ② 排除明显是运费/优惠券/分期价的 <50 的小数；
  //   ③ 取页面文本位置最早、且满足[50, 999999] 的合理价格（真实售价通常在前）。
  function extractPriceFromDOMText(text) {
    if (!text) return undefined;
    // 把所有 "$数字" 命中点按位置收录，并标记每个位置上方 12 字符内是否含【否定关键词】
    var re = /\$\s*([\d,]+(?:\.\d+)?)(?!\d)/g;
    var KEYWORD_BEFORE = /(?:現\s*折|折\s*\$|賣[場场]\s*優?[惠券]|優?[惠券]|運\s*費|运\s*费|分\s*期|利\s*率|0\s*利率|折\s*[扣]|满\s*[减]|滿\s*[减]|減\s*免|coupon|dicount)/i;
    var candidates = [];
    var m;
    while ((m = re.exec(text)) != null) {
      var p = parseNum(m[1]);
      if (p == null || p <= 0) continue;
      // 检查这个数字上方 12 字符内是否含「否定关键词」（折/優惠/運費/分期/利率），命中则视为非售价
      var ctx = text.slice(Math.max(0, m.index - 12), m.index);
      if (KEYWORD_BEFORE.test(ctx)) continue;
      candidates.push({ p: p, idx: m.index });
    }
    if (!candidates.length) {
      // 退到 NT$ 类，与上面同样过滤
      var re2 = /NT\$\s*([\d,]+(?:\.\d+)?)/g;
      while ((m = re2.exec(text)) != null) {
        var p2 = parseNum(m[1]);
        if (p2 == null || p2 <= 0) continue;
        var ctx2 = text.slice(Math.max(0, m.index - 12), m.index);
        if (KEYWORD_BEFORE.test(ctx2)) continue;
        candidates.push({ p: p2, idx: m.index });
      }
    }
    if (!candidates.length) return undefined;
    // 按出现位置排序；真实售价最早出现（页面顶部主图区），且通常 >=50
    candidates.sort(function (a, b) { return a.idx - b.idx; });
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].p >= 50 && candidates[i].p <= 999999) return normalizePrice(candidates[i].p);
    }
    // 没找到 ≥50 的合理价：返回第一个候选，但**绝不返回 <10**（避免运费/分期 $0 / $5）
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].p >= 10) return normalizePrice(candidates[j].p);
    }
    return undefined;
  }

  // ---- 从详情页 DOM 提取主图 ----
  function extractMainImageFromDOM() {
    // 1) Open Graph / Twitter 标签最可靠
    var meta = document.querySelector('meta[property="og:image"]');
    if (meta && meta.content) return meta.content;
    meta = document.querySelector('meta[name="twitter:image"]');
    if (meta && meta.content) return meta.content;
    // 2) 页面中首个大尺寸图片（商品主图通常最大）
    var imgs = document.querySelectorAll('img');
    var candidates = [];
    for (var i = 0; i < imgs.length && i < 30; i++) {
      var src = imgs[i].getAttribute('data-src') || imgs[i].getAttribute('src') || imgs[i].currentSrc;
      if (!src) continue;
      var w = imgs[i].naturalWidth || imgs[i].width || 0;
      var h = imgs[i].naturalHeight || imgs[i].height || 0;
      // 跳过常见小图标/logo
      if (src.indexOf('icon') >= 0 || src.indexOf('logo') >= 0 || src.indexOf('avatar') >= 0) continue;
      candidates.push({ src: src, area: (w || 100) * (h || 100) });
    }
    if (candidates.length) {
      candidates.sort(function (a, b) { return b.area - a.area; });
      return candidates[0].src;
    }
    return undefined;
  }

  // ---- 从 href 提取 shopid/itemid ----
  function parseShopItem(href) {
    if (!href) return null;
    var m = href.match(/-i\.(\d+)\.(\d+)/);
    if (m) return { shopid: m[1], itemid: m[2] };
    m = href.match(/[?&]i\.(\d+)\.(\d+)/);
    if (m) return { shopid: m[1], itemid: m[2] };
    m = href.match(/\/product\/(\d+)\/(\d+)/i);
    if (m) return { shopid: m[1], itemid: m[2] };
    return null;
  }

  function pageTag() {
    var u = location.href.toLowerCase();
    if (u.indexOf('daily_discover') >= 0 || u.indexOf('discover') >= 0) return '每日新发现';
    if (u.indexOf('/search') >= 0) return '搜索';
    if (u.indexOf('/shop/') >= 0) return '店铺';
    if (u.indexOf('-i.') >= 0 || u.indexOf('/product/') >= 0) return '商品详情';
    // ★ 2026-08-26：slug 形式店铺 URL（shopee.tw/<shop-slug>?...），旧逻辑误判为「浏览」，
    //   导致浮窗/分类统计把店铺页当浏览，且店铺商品无法正确归店。
    var seg = (location.pathname || '').replace(/^\//, '').replace(/\/+$/, '');
    var RESERVED = /^(search|shop|product|daily_discover|discover|cart|checkout|buyer|user|me|login|brand|mall|coin|voucher|promo|category|flash_sale|dailyfinds|today|tag|collection|official|i|item|rating|review)$/i;
    if (seg && seg.indexOf('/') < 0 && !RESERVED.test(seg) && u.indexOf('-i.') < 0) return '店铺';
    return '浏览';
  }

  // ---- 工具：递归扫描对象，提取所有商品对象 ----
  // 识别条件：存在 itemid 或 item_id，且至少有 name/price/images/sold 之一。
  // ★ 2026-08-19：虾皮 SSR/新接口的商品对象可能只有 item_id 没有 shop_id（店铺信息分离），
  //   故不再强制要求 shopid 同时存在（详情页场景可从 URL 推断）；字段名兼容 item_id/shop_id。
  function collectItems(root, out, depth) {
    if (!root || typeof root !== 'object' || depth > 12) return;
    if (Array.isArray(root)) {
      for (var i = 0; i < root.length; i++) collectItems(root[i], out, depth + 1);
      return;
    }
    var itemid = root.itemid != null ? Number(root.itemid) : (root.item_id != null ? Number(root.item_id) : null);
    var shopid = root.shopid != null ? Number(root.shopid) : (root.shop_id != null ? Number(root.shop_id) : null);
    if (itemid && (root.name != null || root.price != null || root.price_min != null || root.images || root.image || root.sold != null || root.historical_sold != null)) {
      // shopid 缺失时允许收集，由调用方从 URL 补齐
      if (!shopid) root.shopid = null; else root.shopid = shopid;
      if (root.itemid == null && root.item_id != null) root.itemid = root.item_id;
      out.push(root);
    }
    for (var k in root) {
      if (root.hasOwnProperty(k)) {
        try { collectItems(root[k], out, depth + 1); } catch (e) {}
      }
    }
  }

  // ---- 解析单个 item 对象，返回统一字段 ----
  // ★ 2026-08-26：月销/总销/周销/价格统一走 sales_schema.js 的 S.resolveItem（单一真相源）。
  //   端点语义（item/get 的 sold=月销、pdp 的 sold=累计等）全部在 schema 一处定义，这里不再硬编码。
  //   未知字段返回 null（三态语义），绝不补 0。
  function parseItemObject(it, isDetail) {
    if (!it || typeof it !== 'object') return null;
    var ep = isDetail ? 'item/get' : 'search_items';
    var r = S.resolveItem(it, ep);
    if (!r) return null;
    function imgUrl(v) {
      if (!v) return undefined;
      return /^https?:/.test(v) ? v : ('https://down-tw.img.susercontent.com/file/' + v);
    }
    var ratingObj = it.item_rating || it.itemRating || {};
    var rating = (typeof ratingObj.rating_star === 'number') ? ratingObj.rating_star :
                 (typeof it.rating_star === 'number') ? it.rating_star :
                 (typeof it.rating === 'number') ? it.rating : null;
    var liked = (typeof it.liked_count === 'number') ? it.liked_count :
                (typeof it.liked === 'number') ? it.liked : null;
    var shop = it.shop_name || it.shopname || it.shop || null;
    var loc = it.shop_location || it.location || it.shop_loc || null;
    var official = !!it.is_official_shop || !!it.official;
    var month = r.month;   // null = 未知
    var total = r.total;
    var week = (r.week != null && r.week > 0) ? r.week : (month && month > 0 ? Math.round(month / 4.345) : 0);
    return {
      shopid: Number(r.shopid), itemid: Number(r.itemid),
      month_sold: month,
      week_sold: week,
      total_sold: total,
      month_sold_estimated: false,
      rating: rating,
      liked: liked,
      price: (r.price == null) ? undefined : r.price,
      img: imgUrl(r.img),
      name: r.name || null,
      shop: shop,
      loc: loc,
      official: official,
    };
  }

  // ---- 详情页特殊处理：直接解析当前商品完整数据 ----
  function getCurrentPageItemIds() {
    var href = location.href;
    var m = href.match(/-i\.(\d+)\.(\d+)/);
    if (m) return { shopid: Number(m[1]), itemid: Number(m[2]) };
    m = href.match(/[?&]i\.(\d+)\.(\d+)/);
    if (m) return { shopid: Number(m[1]), itemid: Number(m[2]) };
    m = href.match(/\/product\/(\d+)\/(\d+)/i);
    if (m) return { shopid: Number(m[1]), itemid: Number(m[2]) };
    return null;
  }

  // ---- 详情页：直接读页面真实渲染后的 DOM 文本（绕开被 403 的官方接口）----
  // SPA 详情页 SSR 里没有销量，官方 /api/v4/item/get 在用户浏览器被虾皮 403，
  // 但用户浏览器已把真实销量渲染进 DOM（页面可见的「已售出 X / 月銷 X」）。
  // 这里直接从 document.body.innerText 取真实数字，不经任何接口。
  function scrapeDetailFromDOM() {
    var ids = getCurrentPageItemIds();
    if (!ids) return false;
    var key = ids.shopid + '-' + ids.itemid;
    if (seenIds[key]) return true;            // 已处理过
    var text = document.body ? document.body.innerText : '';
    if (!text || text.length < 30) return false; // 页面还没渲染好，等下次扫描
    var sales = extractSalesFromLiveDOM(text.slice(0, 8000), 'detail'); // 取页面上部商品本体信息（含月銷/近30天文案）
    // 名称：优先 h1，否则用 document.title 去掉后缀
    var name = null;
    try { var h1 = document.querySelector('h1'); if (h1 && h1.innerText) name = h1.innerText.trim(); } catch (e) {}
    if (!name) { name = (document.title || '').replace(/\s*[-|].*$/, '').trim(); }
    var price = extractPriceFromDOMText(text);
    if (!sales.month_sold && !sales.total_sold && !price) return false; // 还没数据，等下次
    seenIds[key] = true;
    var prod = {
      id: key,
      itemid: ids.itemid, shopid: ids.shopid,
      name: name || undefined,
      price: price,
      img: undefined,
      sold: sales.month_sold || 0,
      sold_total: sales.total_sold || 0,
      total_sold: sales.total_sold || 0,
      month_sold: sales.month_sold || 0,
      week_sold: sales.month_sold ? Math.round(sales.month_sold / 4.345) : 0,
      month_sold_estimated: false,
      rating: 0, liked: 0, cats: [],
      url: 'https://shopee.tw/product/' + ids.shopid + '/' + ids.itemid,
    };
    log('DOM详情商品', ids.itemid, '月=' + prod.month_sold, '总=' + prod.total_sold, '价=' + prod.price);
    sendProduct(prod, '商品详情');
    enqueueDetailDomEnrich(prod); // SPA 可能晚渲染，延时再核对一次真实销量
    return true;
  }

  // 详情页销量晚渲染兜底：轮询页面真实 DOM 文本，拿到真实月/总销后发更新（isUpdate）。
  // 最多轮询 10 次（每次 1.5s），避免 SPA 首次扫描时销量文案尚未出现而录成 0。
  function enqueueDetailDomEnrich(prod) {
    var tries = 0;
    (function attempt() {
      var text = document.body ? document.body.innerText : '';
      var sales = extractSalesFromLiveDOM((text || '').slice(0, 4000), 'detail');
      if (sales && (sales.month_sold || sales.total_sold)) {
        var p = Object.assign({}, prod);
        var updated = false;
        if (sales.month_sold && sales.month_sold > 0) {
          p.month_sold = sales.month_sold; p.sold = sales.month_sold;
          p.week_sold = Math.round(sales.month_sold / 4.345); p.month_sold_estimated = false; updated = true;
        }
        if (sales.total_sold && sales.total_sold > 0) { p.total_sold = p.sold_total = sales.total_sold; updated = true; }
        if (updated) { log('DOM 取数(详情)', p.itemid, '月=' + p.month_sold, '总=' + p.total_sold); sendProduct(p, '商品详情', true); }
        return;
      }
      tries++;
      if (tries < 10) setTimeout(attempt, 1500);
    })();
  }

  function scrapeDetailPage() {
    var ids = getCurrentPageItemIds();
    if (!ids) return false;
    var rawItems = collectFromPageScripts();
    var found = null;
    for (var i = 0; i < rawItems.length; i++) {
      if (Number(rawItems[i].shopid) === ids.shopid && Number(rawItems[i].itemid) === ids.itemid) {
        found = parseItemObject(rawItems[i], true);
        break;
      }
    }
    if (!found) return false;
    var key = found.shopid + '-' + found.itemid;
    if (seenIds[key]) return true;
    seenIds[key] = true;
    var prod = {
      id: key,
      itemid: found.itemid,
      shopid: found.shopid,
      name: found.name,
      price: found.price,
      img: found.img,
      sold: found.month_sold || 0,
      sold_total: found.total_sold || 0,
      total_sold: found.total_sold || 0,
      month_sold: found.month_sold || 0,
      week_sold: found.week_sold || 0,
      rating: found.rating || 0,
      liked: found.liked || 0,
      shop: found.shop,
      loc: found.loc,
      official: found.official,
      cats: [],
      url: 'https://shopee.tw/product/' + found.shopid + '/' + found.itemid,
    };
    log('详情页商品', found.itemid, '月=' + prod.month_sold, '总=' + prod.total_sold, '价=' + prod.price);
    sendProduct(prod, '商品详情');
    enqueueDetailDomEnrich(prod);   // 优先从页面真实 DOM 文本取真实销量（接口被 403 时唯一可靠源）
    enqueueEnrich(prod, '商品详情'); // 接口可用时再用官方接口核对月/总销
    return true;
  }

  // ---- 详情页统一抓取：合并 SSR（完整元数据：名称/价格/图片）+ DOM 真实销量文本 + 页面接口捕获 ----
  // 旧代码里 scrapeDetailFromDOM 一旦拿到销量就会 return true，导致含图片/价格的 SSR 被跳过，
  // 网站同步后出现「有销量但无图、价=0」。这里统一合并后再发一次。
  function captureDetailPage() {
    var ids = getCurrentPageItemIds();
    if (!ids) return false;
    currentDetailItemId = Number(ids.itemid); // ★ 2026-08-26：记下当前详情商品，供店铺捕获回填真实月销
    var key = ids.shopid + '-' + ids.itemid;
    if (seenIds[key]) return true;
    if (!document.body || !document.body.innerText || document.body.innerText.length < 30) return false;

    // 1) SSR 完整商品数据
    var ssrItem = null;
    try {
      var ssrItems = collectFromPageScripts();
      for (var i = 0; i < ssrItems.length; i++) {
        if (Number(ssrItems[i].shopid) === ids.shopid && Number(ssrItems[i].itemid) === ids.itemid) {
          ssrItem = parseItemObject(ssrItems[i], true);
          break;
        }
      }
    } catch (e) {}

    // 2) DOM 文本：销量、名称、价格
    var text = (document.body.innerText || '').slice(0, 4000);
    var domSales = extractSalesFromLiveDOM(text, 'detail');
    var domName = null;
    try { var h1 = document.querySelector('h1'); if (h1 && h1.innerText) domName = h1.innerText.trim(); } catch (e) {}
    if (!domName) domName = (document.title || '').replace(/\s*[-|].*$/, '').trim();
    var domPrice = extractPriceFromDOMText(text);
    var domImg = extractMainImageFromDOM();

    // 3) 合并：销量优先 DOM（真实可见）；元数据优先 SSR（完整）；都没有再回退到 DOM
    var name = (domName && domName.length > 2) ? domName : (ssrItem && ssrItem.name) || domName || undefined;
    var price = domPrice || (ssrItem && ssrItem.price) || undefined;
    var img = (ssrItem && ssrItem.img) || domImg || undefined;
    var monthSold = (domSales.month_sold > 0 ? domSales.month_sold : null) || (ssrItem && ssrItem.month_sold) || 0;
    var totalSold = (domSales.total_sold > 0 ? domSales.total_sold : null) || (ssrItem && ssrItem.total_sold) || 0;

    if (!name && !price && !img && !monthSold && !totalSold) return false;

    seenIds[key] = true;
    var prod = {
      id: key, itemid: ids.itemid, shopid: ids.shopid,
      name: name, price: price, img: img,
      sold: monthSold, sold_total: totalSold, total_sold: totalSold,
      month_sold: monthSold, week_sold: monthSold > 0 ? Math.round(monthSold / 4.345) : 0,
      month_sold_estimated: false,
      rating: (ssrItem && ssrItem.rating) || 0,
      liked: (ssrItem && ssrItem.liked) || 0,
      shop: (ssrItem && ssrItem.shop) || undefined,
      loc: (ssrItem && ssrItem.loc) || undefined,
      official: (ssrItem && ssrItem.official) || false,
      cats: [],
      url: 'https://shopee.tw/product/' + ids.shopid + '/' + ids.itemid,
    };
    log('详情页合并', ids.itemid, '月=' + prod.month_sold, '总=' + prod.total_sold, '价=' + prod.price, '图=' + (prod.img ? '有' : '无'));
    prod = applyCapture(prod); // 合并 API 已捕获的字段（如 pdp/get_pc 的总销）
    // ★ 2026-08-26：改为 isUpdate=false，使「本次录制」正确计数当前商品（isUpdate=true 不计入，
    //   导致浮窗永远显示 0 件，用户误以为没录到）。sentKeys 防重复，seenIds 已提前拦截。
    sendProduct(prod, '商品详情', false);
    enqueueDetailDomEnrich(prod); // SPA 晚渲染兜底
    // 2026-08-25：买家端 item/get 已被 403，不再调用官方接口核对
    // enqueueEnrich(prod, '商品详情');
    return true;
  }

  // ---- 扫描页面所有 <script> 标签，提取 SSR JSON ----
  // 从 script 文本里按 keyword 提取顶层 JSON 对象（处理嵌套大括号）
  function extractTopLevelJSON(txt, keyword) {
    var idx = txt.indexOf(keyword);
    if (idx < 0) return null;
    var start = txt.indexOf('{', idx + keyword.length);
    if (start < 0) return null;
    var depth = 1;
    var inStr = false;
    var esc = false;
    for (var i = start + 1; i < txt.length; i++) {
      var c = txt.charAt(i);
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(txt.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function scanScriptJson() {
    var found = [];
    var SSR_KEYS = ['window.__INITIAL_STATE__', 'window.__NEXT_DATA__', 'window._SSR_HYDRATED_DATA',
                    'window.__PRELOADED_STATE__', 'window.__APP_DATA__', 'window.__NUXT__',
                    'window.INITIAL_STATE', 'window._data', 'window.__data__', 'window.__PRELOAD_STATE__'];
    try {
      var scripts = document.querySelectorAll('script');
      for (var i = 0; i < scripts.length; i++) {
        var txt = scripts[i].textContent || '';
        if (!txt || txt.length < 50) continue;

        // 模式 A: window.XXX = {...}; 或 window.XXX = JSON.parse('...');
        var m = null;
        for (var k = 0; k < SSR_KEYS.length; k++) {
          if (txt.indexOf(SSR_KEYS[k]) < 0) continue;
          m = extractTopLevelJSON(txt, SSR_KEYS[k]);
          if (m) { found.push(m); break; }
        }
        if (m) continue;
        // 模式 B: window.__INITIAL_STATE__ = JSON.parse('...');
        var idx = txt.indexOf('window.__INITIAL_STATE__');
        if (idx >= 0) {
          var p = txt.match(/window\.__INITIAL_STATE__\s*=\s*JSON\.parse\(\s*['"]([\s\S]*?)['"]\s*\);?/);
          if (p) {
            try {
              var unescaped = p[1].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
              found.push(JSON.parse(unescaped));
            } catch (e) {}
            continue;
          }
        }

        // 模式 C: 任意内嵌 JSON，包含 itemid/shopid 的数组或对象（兜底）
        try {
          if (/"itemid"/.test(txt) || /'itemid'/.test(txt) || /"item_id"/.test(txt)) {
            var obj = JSON.parse(txt);
            found.push(obj);
          }
        } catch (e) {}

        // 模式 D: 含 itemid 但整段不是纯 JSON 的 script —— 提取「= {...}」赋值表达式里的对象
        if (txt.indexOf('itemid') >= 0 || txt.indexOf('item_id') >= 0) {
          try {
            var eq = txt.search(/=\s*\{/);
            if (eq >= 0) {
              var sobj = extractTopLevelJSON(txt.slice(eq), '{');
              if (sobj) found.push(sobj);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    return found;
  }

  // ---- 从页面 SSR 数据中收集所有商品 ----
  function collectFromPageScripts() {
    var roots = scanScriptJson();
    var rawItems = [];
    for (var i = 0; i < roots.length; i++) {
      try { collectItems(roots[i], rawItems, 0); } catch (e) {}
    }
    // 去重
    var map = {};
    var out = [];
    for (var i = 0; i < rawItems.length; i++) {
      var it = rawItems[i];
      var k = it.shopid + '-' + it.itemid;
      if (!map[k]) { map[k] = true; out.push(it); }
    }
    return out;
  }

  // ---- 从商品链接构造商品基础对象 ----
  function buildFromHref(a, container) {
    var href = a.href || a.getAttribute('href') || '';
    var si = parseShopItem(href);
    if (!si) return null;
    var shopid = Number(si.shopid);
    var itemid = Number(si.itemid);
    if (!shopid || !itemid) return null;

    var imgEl = a.querySelector('img') || (container && container.querySelector ? container.querySelector('img') : null);
    var imgSrc = '';
    if (imgEl) {
      imgSrc = imgEl.getAttribute('data-src') || imgEl.getAttribute('data-original') || imgEl.src || imgEl.currentSrc || '';
    }
    if (imgSrc && imgSrc.indexOf('http') !== 0 && imgSrc.indexOf('//') === 0) imgSrc = 'https:' + imgSrc;

    var name = (a.getAttribute('title') || '').trim();
    if (!name && imgEl) name = (imgEl.getAttribute('alt') || '').trim();
    if (!name && container) {
      var nameEl = a.querySelector('[data-sqe="name"]') || container.querySelector('[data-sqe="name"]');
      if (nameEl) name = nameEl.textContent.trim();
    }
    if (!name) name = (a.textContent || '').trim().slice(0, 150);

    // 卡片文字中的价格和销量兜底
    var text = ((container && container.textContent) || '') + ' ' + (a.textContent || '');
    var price = extractPriceFromDOMText(text);
    var totalSold = 0, monthSold = 0, monthSoldEstimated = false;
    // ★ 列表/搜索/店铺商品卡：「已售出 X」= 累计总销（与详情页一致，已验证），绝不当月销；
    //   卡片 DOM 兜底时它只写 totalSold，monthSold 仅来自明确的「月銷 X / 近30天 X」文案
    //   （或后续由列表 API 的 item.sold 补全）。否则累计值会被误当月销（月销虚高）。
    var smSold = text.match(/已售\s*出?\s*([\d,.]+[kKw万]?)/) || text.match(/([\d,.]+[kKw万]?)\s*已售/);
    if (smSold) {
      totalSold = parseNum(smSold[1]) || 0;
    }
    // 月销：仅明确「月銷 X / 近30天 X」文案
    var smMonth = text.match(/近\s*30\s*天[售出]*\s*([\d,.]+[kKw万]?)/) ||
                  text.match(/月[銷销]量?\s*([\d,.]+[kKw万]?)/) ||
                  text.match(/([\d,.]+[kKw万]?)\s*月[銷销]量?/);
    if (smMonth) monthSold = parseNum(smMonth[1]) || 0;

    return {
      id: shopid + '-' + itemid,
      itemid: itemid, shopid: shopid,
      name: name || undefined,
      price: price,
      img: imgSrc ? String(imgSrc) : undefined,
      sold: monthSold,
      sold_total: totalSold,
      total_sold: totalSold,
      month_sold: monthSold,
      week_sold: monthSold ? Math.round(monthSold / 4.345) : 0,
      month_sold_estimated: monthSoldEstimated,
      rating: 0,
      liked: 0,
      cats: [],
      url: 'https://shopee.tw/product/' + shopid + '/' + itemid,
    };
  }

  // ---- 店铺页 DOM 兜底：API 没给月销时，从卡片可见文本读「月銷量 X」 ----
  function scrapeShopCards() {
    if (!recordingOn) return;
    try {
      // ★ 多策略找商品卡片链接：先精确匹配虾皮商品链接，再回退到带 href 的 a 标签
      var links = document.querySelectorAll('a[href*="-i."], a[href*="/product/"]');
      if (!links.length) links = document.querySelectorAll('a[href]');
      var found = 0;
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var href = a.href || a.getAttribute('href') || '';
        var si = parseShopItem(href);
        if (!si) continue;
        var key = si.shopid + '-' + si.itemid;
        if (seenIds[key]) continue;
        // 找卡片根容器：优先用虾皮 data-sqe 标记，再回退到「同时包含 img + 价格/销量文案」的祖先
        var card = null;
        if (a.closest) {
          card = a.closest('[data-sqe="item"], [data-sqe="name"], .shop-search-result-item, .shopee-search-item-result__item, .full-page-container .shop-page__items .shop-search-result-item');
        }
        if (!card) {
          var p = a.parentElement, steps = 0;
          while (p && steps < 8) {
            if (p.querySelector && p.querySelector('img')) {
              var pt = p.textContent || '';
              if (/已售[出]?|月[銷销]量?|\$|\NT\$/.test(pt)) { card = p; break; }
            }
            p = p.parentElement; steps++;
          }
        }
        if (!card) card = a;
        // 把卡片内所有文本聚合（包括价格、销量、名称）
        var text = (card.textContent || '') + ' ' + (a.textContent || '') + ' ' + (a.getAttribute('title') || '');
        var smMonth = text.match(/月[銷销]量?\s*([\d,.]+[kKw万]?)/) ||
                      text.match(/近\s*30\s*天[售出]*\s*([\d,.]+[kKw万]?)/) ||
                      text.match(/30\s*天[售出]*\s*([\d,.]+[kKw万]?)/);
        var monthSold = smMonth ? (parseNum(smMonth[1]) || 0) : 0;
        var smTotal = text.match(/已售[出]?\s*([\d,.]+[kKw万]?)/) || text.match(/([\d,.]+[kKw万]?)\s*已售[出]?/);
        var totalSold = smTotal ? (parseNum(smTotal[1]) || 0) : 0;
        browseCount++;
        if (monthSold > 0) browseMonthCount++;
        // 店铺页 DOM 兜底：月销>0 或 总销>0 即保留（与 API 路径一致），不再一刀切 >30
        if (monthSold <= 0 && totalSold <= 0) continue;
        found++;
        var price = extractPriceFromDOMText(text);
        var imgEl = card.querySelector('img') || a.querySelector('img');
        var imgSrc = imgEl ? (imgEl.getAttribute('data-src') || imgEl.getAttribute('data-original') || imgEl.src || imgEl.currentSrc || '') : '';
        if (imgSrc && imgSrc.indexOf('http') !== 0 && imgSrc.indexOf('//') === 0) imgSrc = 'https:' + imgSrc;
        var name = (a.getAttribute('title') || '').trim();
        if (!name && imgEl) name = (imgEl.getAttribute('alt') || '').trim();
        if (!name) {
          var nameEl = card.querySelector('[data-sqe="name"]') || a.querySelector('[data-sqe="name"]');
          if (nameEl) name = nameEl.textContent.trim();
        }
        if (!name) name = (a.textContent || '').trim().slice(0, 150);
        seenIds[key] = true;
        var prod = {
          id: key, itemid: Number(si.itemid), shopid: Number(si.shopid),
          name: name || undefined, price: price, img: imgSrc || undefined,
          sold: monthSold, month_sold: monthSold,
          week_sold: Math.round(monthSold / 4.345),
          total_sold: totalSold, sold_total: totalSold,
          month_sold_estimated: false,
          shop: (card.querySelector('[data-sqe="shopName"]') || {}).textContent || undefined,
          keep_shop: true,
          url: 'https://shopee.tw/product/' + si.shopid + '/' + si.itemid
        };
        log('店铺DOM兜底', si.itemid, '月=' + monthSold, '总=' + totalSold, '价=' + price);
        sendProduct(prod, '店铺', true);
      }
      if (found > 0) updateFloat();
    } catch (e) { warn('scrapeShopCards 异常:', e.message); }
  }

  // ---- 核心抓取：优先 SSR 数据，再用 DOM 链接兜底 ----
  function scrapeCards() {
    if (!recordingOn) return;
    var tag = pageTag();
    if (tag === '商品详情') {
      try { captureDetailPage(); } catch (e) { warn('captureDetailPage 异常:', e.message); }
      return;
    }
    if (tag === '店铺') {
      try { scrapeShopCards(); } catch (e) { warn('scrapeShopCards 异常:', e.message); }
      return;
    }
    // 2026-08-25：搜索/每日发现/首页等列表页什么都不录
    return;
    try {
      // 0) 商品详情页优先：统一合并 SSR（完整元数据）+ DOM 真实销量 + 页面接口捕获
      if (captureDetailPage()) return;

      // 1) 优先从页面 SSR script 中提取完整商品数据
      var ssrItems = collectFromPageScripts();
      log('SSR 扫描到 ' + ssrItems.length + ' 个商品对象');
      for (var i = 0; i < ssrItems.length; i++) {
        var detail = parseItemObject(ssrItems[i], false);
        if (!detail) continue;
        var key = detail.shopid + '-' + detail.itemid;
        if (seenIds[key]) continue;
        seenIds[key] = true;
        browseCount++;
        if (detail.month_sold > 0) browseMonthCount++;
        var prod = {
          id: key,
          itemid: detail.itemid,
          shopid: detail.shopid,
          name: detail.name,
          price: detail.price,
          img: detail.img,
          sold: detail.month_sold || 0,
          sold_total: detail.total_sold || 0,
          total_sold: detail.total_sold || 0,
          month_sold: detail.month_sold || 0,
          week_sold: detail.week_sold || 0,
          rating: detail.rating || 0,
          liked: detail.liked || 0,
          shop: detail.shop,
          loc: detail.loc,
          official: detail.official,
          cats: [],
          url: 'https://shopee.tw/product/' + detail.shopid + '/' + detail.itemid,
        };
        log('SSR 商品', detail.itemid, '月=' + prod.month_sold, (detail.month_sold_estimated ? '(估)' : ''), '总=' + prod.total_sold, '价=' + prod.price);
        sendProduct(prod, pageTag());
        // 列表页 SSR：只要有真实月销+价格，就不再硬拉 item/get（避免 403 风控）。
        // total_sold 缺失不触发 enrich，由后续详情页被动捕获或保持为空。
        if (!detail.month_sold || !detail.price || detail.month_sold_estimated) {
          enqueueEnrich(prod, pageTag());
        }
      }

      // 2) DOM 链接兜底：SSR 没覆盖到的商品，用卡片信息补录，并尝试 enrich 详情页
      var links = document.querySelectorAll('a[href*="-i."], a[href*="/product/"]');
      if (!links.length) links = document.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var href = a.href || a.getAttribute('href') || '';
        var si = parseShopItem(href);
        if (!si) continue;
        var key = si.shopid + '-' + si.itemid;
        if (seenIds[key]) continue;

        // 向上找包含图片的容器
        var container = a;
        var p = a.parentElement;
        var steps = 0;
        while (p && steps < 6 && !(p.querySelector && p.querySelector('img'))) { p = p.parentElement; steps++; }
        if (p && p.querySelector && p.querySelector('img')) container = p;

        var base = buildFromHref(a, container);
        if (!base) continue;
        seenIds[key] = true;
        browseCount++;
        if (base.month_sold > 0) browseMonthCount++;
        log('DOM 兜底商品', base.itemid, '月=' + base.month_sold, '价=' + base.price);
        sendProduct(base, pageTag());
        // DOM 兜底：列表卡只要有月销+价格就不 enrich，避免大量 item/get 403；total_sold 缺失不补。
        if (!base.month_sold || !base.price) enqueueEnrich(base, pageTag());
      }
    } catch (e) {
      warn('scrapeCards 异常:', e.message, e.stack);
    }
  }

  // ---- 从详情页 HTML 解析 SSR 数据补全指定商品（并兜底抓取可见「已售出」文案）----
  function fetchDetailHTML(shopid, itemid) {
    return new Promise(function (resolve) {
      var url = 'https://shopee.tw/product/' + shopid + '/' + itemid;
      try {
        bgFetch(url, { method: 'GET', credentials: 'include', headers: { 'Accept': 'text/html' } })
          .then(function (r) { return r && r.ok ? r.text() : null; })
          .then(function (html) {
            if (!html) { resolve(null); return; }
            var item = parseDetailHTML(html, shopid, itemid);
            var txt = extractSoldFromHTML(html);
            if (item) {
              if (!item.month_sold) item.month_sold = txt.month_sold;
              if (!item.total_sold) item.total_sold = txt.total_sold;
              if (!item.price && txt.price) item.price = txt.price;
            } else {
              item = txt;
            }
            if (!item || (!item.month_sold && !item.total_sold && !item.price)) { resolve(null); return; }
            resolve(item);
          }).catch(function (e) { resolve(null); });
      } catch (e) { resolve(null); }
    });
  }

  function parseDetailHTML(html, shopid, itemid) {
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, 'text/html');
      var scripts = doc.querySelectorAll('script');
      var roots = [];
      for (var i = 0; i < scripts.length; i++) {
        var txt = scripts[i].textContent || '';
        var m = extractTopLevelJSON(txt, 'window.__INITIAL_STATE__') ||
                extractTopLevelJSON(txt, 'window.__NEXT_DATA__') ||
                extractTopLevelJSON(txt, 'window._SSR_HYDRATED_DATA');
        if (m) roots.push(m);
      }
      var rawItems = [];
      for (var i = 0; i < roots.length; i++) {
        try { collectItems(roots[i], rawItems, 0); } catch (e) {}
      }
      for (var i = 0; i < rawItems.length; i++) {
        if (Number(rawItems[i].shopid) === Number(shopid) && Number(rawItems[i].itemid) === Number(itemid)) {
          return parseItemObject(rawItems[i], true);
        }
      }
    } catch (e) {}
    return null;
  }

  // ---- 诊断辅助：把商品对象里所有销量相关字段路径 dump 出来 ----
  // 用于远程定位「列表接口月销到底藏在哪个字段」，避免硬猜字段名。
  function dumpSalesDebug(obj, prefix, out, depth) {
    if (out == null) out = [];
    if (depth == null) depth = 0;
    if (!obj || typeof obj !== 'object' || out.length >= 24 || depth > 4) return out;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length && out.length < 24; i++) dumpSalesDebug(obj[i], prefix + '[' + i + ']', out, depth + 1);
      return out;
    }
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      var path = prefix ? prefix + '.' + k : k;
      var v = obj[k];
      if (/sold|sales|month|historical|cumulative/i.test(k) && v != null) {
        var vs = (typeof v === 'object') ? JSON.stringify(v).slice(0, 60) : String(v);
        out.push(path + '=' + vs);
        if (out.length >= 24) return out;
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) dumpSalesDebug(v, path, out, depth + 1);
    }
    return out;
  }

  // 从商品页可见文案提取月销量（近30天）。
  // 关键修正：绝不用裸正则抓整页第一个 "sold":N / "historical_sold":N ——
  // 真实页面里 "sold" 出现在推荐位、变体、其它商品片段里，抓第一个会得到脏值，
  // 还会把下面可靠的可见文案兜底「已售出 X」「月銷 X」屏蔽掉（这正是此前月销全错的元凶）。
  // 累计总销量由 fetchDetailAPI 的 item.historical_sold 提供（比 HTML 正则可靠），此处不抓。
  function extractSoldFromHTML(html) {
    var res = { month_sold: null, total_sold: null, week_sold: null, price: null };
    if (!html) return res;
    var m;
    // 累计总销量：页面可见文案「已售出 X」= 累计销量（historical_sold），【不是月销】。
    m = html.match(/已售[出]?\s*([\d.,]+\s*[kKw万千]?\+?)/) ||
        html.match(/([\d.,]+\s*[kKw万千]?\+?)\s*已售[出]?/);
    if (m) { var t = parseNum(m[1]); if (t != null) { res.total_sold = t; } }
    // 兜底：可见「月銷 X」
    if (res.month_sold == null || res.month_sold === 0) {
      m = html.match(/月[銷销]量?\s*([\d.,]+\s*[kKw万千]?)/);
      if (m) { var t2 = parseNum(m[1]); if (t2 != null) res.month_sold = t2; }
    }
    if (res.month_sold != null && res.month_sold > 0) res.week_sold = Math.round(res.month_sold / 4.345);
    return res;
  }

  // 前端渲染文本兜底：item_card_displayed_asset.sold_count.text = "月銷量 410" / "已售出 211"。
  // icsc 数值与文本全无时使用；前缀区分月销/总销。仅在 S.resolveItem 后仍缺字段时补充。
  function assetTextFallback(it) {
    if (!it || !it.item_card_displayed_asset || !it.item_card_displayed_asset.sold_count) return null;
    var atext = it.item_card_displayed_asset.sold_count.text;
    if (!atext) return null;
    var an = parseNum(atext);
    if (an == null || an <= 0) return null;
    if (/月銷|月销|30天/.test(atext)) return { month: an, total: null };
    return { month: null, total: an };
  }

  // 带 background 代理兜底的 fetch：页面 CSP 可能拦截 content script 的 fetch，
  // 走 background service worker 的 fetch 不受页面 CSP 限制（仅受 CORS 约束，虾皮 API 返回 ACAO:*）。
  function bgFetch(url, init) {
    return new Promise(function (resolve, reject) {
      try { fetch(url, init).then(resolve).catch(function (e) { fallback(); }); }
      catch (e) { fallback(); }
      function fallback() {
        try {
          chrome.runtime.sendMessage({ type: 'fetchViaBg', url: url, init: init }, function (resp) {
            if (chrome.runtime.lastError || !resp) { reject(chrome.runtime.lastError || new Error('bg fetch failed')); return; }
            if (resp.error) { reject(new Error(resp.error)); return; }
            if (resp.json != null) resolve({ ok: resp.ok, json: function () { return Promise.resolve(resp.json); } });
            else resolve({ ok: resp.ok, text: function () { return Promise.resolve(resp.text); } });
          });
        } catch (e) { reject(e); }
      }
    });
  }

  // ---- 从虾皮官方商品接口拿权威销量 ----
  // 现代虾皮商品页是 SPA，SSR HTML 里没有 sold；30 天真实销量只在
  // /api/v4/item/get 的 data.item.sold 里。扩展直接用用户登录态去拉这个接口。
  // 两路尝试：① 页面 fetch（可能受 CSP 拦截）；② background 代理（不受页面 CSP 限制）。
  // 任一路成功即采用；并记录来源与状态码，便于诊断。
  function fetchDetailAPI(shopid, itemid) {
    return new Promise(function (resolve) {
      var url = 'https://shopee.tw/api/v4/item/get?itemid=' + encodeURIComponent(itemid)
              + '&shopid=' + encodeURIComponent(shopid);
      var init = {
        method: 'GET', credentials: 'include',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
      };
      tryPage(url, init)
        .then(function (r) {
          if (r && r.ok) return finish(r, 'page');
          log('API[page] 非 200 (status=' + (r ? r.status : '?') + ')，改走 background 代理');
          return tryBg(url, init).then(function (r2) { return r2 ? finish(r2, 'bg') : null; });
        })
        .catch(function (e) {
          log('API[page] 异常 (' + (e && e.message) + ')，改走 background 代理');
          return tryBg(url, init).then(function (r2) { return r2 ? finish(r2, 'bg') : null; });
        })
        .then(function (detail) { resolve(detail); })
        .catch(function () { resolve(null); });

      function finish(r, src) {
        return Promise.resolve(r.json()).then(function (j) {
          if (!j) { log('API[' + src + '] 响应非 JSON'); return null; }
          var item = (j.data && (j.data.item || (j.data.data && j.data.data.item)))
                   || j.item || null;
          if (!item || typeof item !== 'object') { log('API[' + src + '] 无 item 对象'); return null; }
          // ★ 单一真相源：月销/总销/价格统一由 S.resolveItem('item/get') 解析（绝不深入变体）
          var r = S.resolveItem(item, 'item/get');
          var ir = item.item_rating || item.itemRating || {};
          var detail = {
            month_sold: r ? r.month : null,
            total_sold: r ? r.total : null,
            week_sold: r ? r.week : null,
            price: (r && r.price != null) ? r.price : undefined,
            rating: (typeof ir.rating_star === 'number') ? ir.rating_star : (ir.rating || 0),
            shop: item.shop_name || item.shopname || (item.shop && (item.shop.name || item.shop.shop_name)) || null,
            loc: item.shop_location || item.location || (item.shop && item.shop.shop_location) || null,
            name: item.name || item.title || null,
            img: item.image || (item.images && item.images[0]) || null,
          };
          log('API 取数[' + src + ']', itemid, '月=' + detail.month_sold, '总=' + detail.total_sold,
              '价=' + detail.price, '(raw item.sold=' + item.sold + ', historical_sold=' + item.historical_sold + ')');
          return detail;
        }).catch(function (e) { log('API[' + src + '] 解析异常', e.message); return null; });
      }
      function tryPage(u, i) { return bgFetch(u, i); } // bgFetch 内部：先页面 fetch，抛错则退回 background
      function tryBg(u, i) {
        return new Promise(function (res) {
          try {
            chrome.runtime.sendMessage({ type: 'fetchViaBg', url: u, init: i }, function (resp) {
              if (chrome.runtime.lastError || !resp || resp.error) return res(null);
              if (resp.json != null) res({ ok: resp.ok, json: function () { return Promise.resolve(resp.json); } });
              else res({ ok: resp.ok, text: function () { return Promise.resolve(resp.text); } });
            });
          } catch (e) { res(null); }
        });
      }
    });
  }

  // 从当前页面的真实 DOM 文本补全销量（列表卡片仍在 DOM 中；详情页直接读整页）。
  // 不经过任何接口，故不受 403 / CSP 影响，拿到的是虾皮真实展示的数字。
  function fetchDetailDOM(base) {
    return new Promise(function (resolve) {
      var text = '';
      try {
        // 列表页：定位该商品的卡片容器
        var card = document.querySelector('a[href*="-i.' + base.itemid + '"], a[href*="/product/' + base.shopid + '/' + base.itemid + '"]');
        if (card) {
          var c = card, p = card.parentElement, steps = 0;
          while (p && steps < 6 && !(p.querySelector && p.querySelector('img'))) { p = p.parentElement; steps++; }
          if (p && p.querySelector && p.querySelector('img')) c = p;
          text = c.innerText || c.textContent || '';
        } else if (getCurrentPageItemIds() && Number(getCurrentPageItemIds().itemid) === Number(base.itemid)) {
          // 详情页：读整页上部商品本体信息
          text = document.body ? document.body.innerText : '';
        }
      } catch (e) {}
      if (!text) { resolve(null); return; }
      var sales = extractSalesFromLiveDOM(text.slice(0, 4000), 'card');
      if (sales.month_sold || sales.total_sold) {
        resolve({ month_sold: sales.month_sold, total_sold: sales.total_sold, week_sold: sales.week_sold });
      } else {
        resolve(null);
      }
    });
  }

  function enqueueEnrich(base, tag) {
    enrichQueue.push({ base: base, tag: tag });
    pumpEnrich();
  }

  function pumpEnrich() {
    while (enrichRunning < ENRICH_CONCURRENCY && enrichQueue.length) {
      var job = enrichQueue.shift();
      enrichRunning++;
      processEnrich(job).then(function () {
        enrichRunning--;
        setTimeout(pumpEnrich, ENRICH_INTERVAL);
      }).catch(function () {
        enrichRunning--;
        setTimeout(pumpEnrich, ENRICH_INTERVAL);
      });
    }
  }

  function processEnrich(job) {
    var base = job.base;
    var key = base.shopid + '-' + base.itemid;
    // ① 最高优先级：页面接口（inject.js 偷听）已捕获的真实销量 —— 等价于 recorder.py 的数据，最权威
    // ★ 2026-08-19 修正：只有「确实有销量」才算权威捕获。此前 `|| cap.price` 导致
    //   仅拿到价格（如 pdp/get_pc 解析出 price=199 但销量字段未识别=0）就短路返回，
    //   阻断 ② DOM 兜底把总销补上 → 网站有价无销。现在 price 不再阻断后续兜底。
    var cap = capturedItems[key];
    if (cap && (cap.month_sold > 0 || cap.total_sold > 0)) {
      log('enrich 用已捕获接口数据', base.itemid, '月=' + cap.month_sold, '总=' + cap.total_sold, '价=' + cap.price);
      return Promise.resolve(cap);
    }
    return fetchDetailDOM(base)                                   // ② 页面真实 DOM 文本（绕开 403 接口，兜底）
      .then(function (detail) {
        if (detail && (detail.month_sold != null || detail.total_sold != null || detail.price != null)) return detail;
        return fetchDetailAPI(base.shopid, base.itemid);          // ③ 官方接口（用户浏览器被 403 时走不到）
      })
      .then(function (detail) {
        if (detail && (detail.month_sold != null || detail.total_sold != null || detail.price != null)) return detail;
        return fetchDetailHTML(base.shopid, base.itemid);         // ③ 商品页 HTML 兜底
      })
      .then(function (detail) {
      if (!detail) { warn('enrich 失败(接口+HTML均无销量/价格):', base.itemid, base.shopid); return; }
      // 只有 enrich 到了有效字段才更新
      var updated = false;
      var prod = Object.assign({}, base);
      // 月销量：仅当接口/详情明确给出「正数」才覆盖，避免把列表已抓到的真实值误清为 0
      if (detail.month_sold != null && detail.month_sold > 0) {
        prod.month_sold = detail.month_sold;
        prod.sold = detail.month_sold; // sold = 真实月销量（与 catalog.py 一致）
        prod.month_sold_estimated = false; // 详情页取到的是真实值，绝不估算
        prod.week_sold = detail.month_sold > 0 ? Math.round(detail.month_sold / 4.345) : 0;
        updated = true;
      }
      if (detail.week_sold != null && detail.week_sold > 0) { prod.week_sold = detail.week_sold; updated = true; }
      if (detail.total_sold != null && detail.total_sold > 0) { prod.total_sold = prod.sold_total = detail.total_sold; updated = true; }
      // 价格：enrich 不允许用低价（优惠券/运费/错误解析）覆盖已有的真实售价
      if (detail.price != null && detail.price > 0 && (!prod.price || detail.price > prod.price)) { prod.price = detail.price; updated = true; }
      if (detail.rating != null && detail.rating > 0) { prod.rating = detail.rating; updated = true; }
      if (detail.liked != null && detail.liked > 0) { prod.liked = detail.liked; updated = true; }
      if (detail.img) { prod.img = detail.img; updated = true; }
      if (detail.name) { prod.name = detail.name; updated = true; }
      if (detail.shop) { prod.shop = detail.shop; updated = true; }
      if (detail.loc) { prod.loc = detail.loc; updated = true; }
      if (prod.month_sold > 0 && prod.total_sold > 0 && prod.month_sold > prod.total_sold) {
        warn('数据可疑: 月销(' + prod.month_sold + ') > 总销(' + prod.total_sold + ')', base.itemid,
             '——可能字段错位，请点浮窗「📋 导出诊断样本」发我核对');
      }
      if (updated) {
        log('enrich 成功', base.itemid, '月=' + prod.month_sold, '价=' + prod.price);
        sendProduct(prod, job.tag, true);
      }
    });
  }

  // ---- 接收页面主环境 inject.js 偷听到的真实接口响应 ----
  // 这是月/总销的【权威真实源】：页面自己成功请求 /api/v4/item/get 的响应，
  // 含 item.sold（近30天=月销）与 item.historical_sold（累计=总销），与 recorder.py 抓到的完全一致。
  // ★ 2026-08-21：明确非商品接口（购物车/结算/用户等）不应被当成商品处理，直接丢弃。
  var NON_PRODUCT_ENDPOINTS = /(\/cart\/|\/bundle\/|\/payment\/|\/checkout\/|\/address\/|\/user\/|\/follow\/|\/chat\/|\/notification\/|\/shipping\/|\/voucher\/|\/account\/|\/auth\/|\/login\/|\/search\/history|\/pdp\/cart_panel)/i;
  function isProductEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'string') return false;
    if (NON_PRODUCT_ENDPOINTS.test(endpoint)) return false;
    return endpoint.indexOf('/api/') >= 0 || endpoint.indexOf('seller.') >= 0;
  }
  // ★ 2026-08-26：深度查找 item_card_display_sold_count 已由 sales_schema.js 的 S.locateIcs 统一实现
  //   （实测 get_shop_tab / get_item_cards 把它嵌套在 it.item_data.item_card_display_sold_count 下）。
  function handleApiCapture(payload) {
    try {
      if (!payload) return;
      var endpoint = payload.endpoint || '';
      if (!isProductEndpoint(endpoint)) {
        warn('丢弃非商品接口数据', endpoint);
        return;
      }
      var items = payload.items || [];
      if (items.length) {
        apiCaptureCount += items.length;
        updateFloat();
      }
      // 仅 item/get（详情）的 sold 是权威「近30天月销」；
      // search/recommend 列表接口的 sold 往往是累计总销量，只作总销兜底，绝不冒充月销
      var authMonth = !!payload.authoritativeMonth;
      if (payload.endpoint && payload.items && payload.items.length) {
        capturedUrlLog.push(payload.endpoint + ' @ ' + new Date().toISOString().slice(11, 19));
        if (capturedUrlLog.length > 20) capturedUrlLog.shift();
      }
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        // ★ get_pc 等新接口把商品数据嵌在 item_basic / item 子对象里，先解包
        // 2026-08-21：先把子对象里的销量/价格/名称等合并到顶层（列表接口常见此结构），
        // 如果顶层仍没有 itemid，再整个切换到子对象。
        it = mergeItemBasic(it);
        if (it && (it.item_basic || it.item) && it.itemid == null && it.item_id == null) {
          var inner = it.item_basic || it.item;
          if (inner && typeof inner === 'object') it = inner;
        }
        // ★ 兼容虾皮新旧两种字段名：itemid/shopid 与 item_id/shop_id（pdp/get_pc 用下划线命名）
        var shopid = Number(it.shopid != null ? it.shopid : (it.shop_id != null ? it.shop_id : (it.shop && it.shop.shopid)));
        var itemid = Number(it.itemid != null ? it.itemid : (it.item_id != null ? it.item_id : null));
        // ★ URL 兜底：列表接口的 item_card 可能缺 shopid（只有 itemid），用当前页 URL 的 shopid 补
        if (itemid && !shopid) {
          var mU = /(?:-i\.|product\/)(\d+)\.(\d+)/.exec(location.href);
          if (mU) shopid = Number(mU[1]);
        }
        if (!shopid || !itemid) continue;
        // 让 S.resolveItem 一定能取到 id/shopid（端点字段路径也覆盖，这里做 URL 兜底）
        it.shopid = (it.shopid != null) ? it.shopid : shopid;
        it.itemid = (it.itemid != null) ? it.itemid : itemid;
        if (it.shop_id != null && it.shopid == null) it.shopid = it.shop_id;
        if (it.item_id != null && it.itemid == null) it.itemid = it.item_id;
        var key = shopid + '-' + itemid;

        // ★ 2026-08-25：店铺捕获分支——仅收录「月销>30」的商品（用户要求），月销已含准确值
        //   （来自卡片 icsc「月銷量 N」文本，或由 inject.js 借页面 header 重发 item/get 精修得到）。
        //   商品归到当前店铺（shopName/shopId），并打 keep_shop 标记让后台在「今日过滤」中保留店铺数据。
        // ★ 2026-08-26：月销/总销/价格统一走 S.resolveItem（卡片 icsc 嵌套 item_data 由 schema 深度查找解决）。
        if (payload.shopCapture) {
          // ★ inject.js buildShopProducts 已逐卡完成权威解析（月销来自 item_data.icsc、价格已按端点换算为元、shopid 逐卡独立），
          //   这里【直接采用 payload 已算好的字段】，绝不再用 S.resolveItem 重解「已扁平化」的 payload——
          //   否则 get_shop_tab / get_item_cards 这类 itemWrap='item_data' 的端点会因缺 item_data.icsc 把月销算成 null→0，
          //   被过滤全部丢弃，且 schema 未定义 img/price 路径导致图、价丢失。
          var sid = Number(it.shopid != null ? it.shopid : (it.shop_id != null ? it.shop_id : null));
          var iid = Number(it.itemid != null ? it.itemid : (it.item_id != null ? it.item_id : null));
          if (!sid || !iid) continue;
          var sMonth = (it.month_sold != null) ? Number(it.month_sold) : 0;
          var sTotal = (it.sold_total != null) ? Number(it.sold_total) : 0;
          // 统一计入「浏览已扫」反馈（店铺页/PDP 卡都是用户正在浏览的商品）
          browseCount++;
          if (sMonth > 0) browseMonthCount++;
          updateFloat();
          // ★ 来源感知阈值：
          //   - 店铺页(shop)：用户主动浏览该店，月销>0 或 总销>0 即保留（与 background 过滤一致），避免 109 件只进 16 件。
          //   - PDP 推荐卡(pdp_card)：「看了又看」跨店商品，只保留月销>30 的热销品，避免刷屏。
          var source = it._source || payload.source || 'shop';
          var isCurrentDetail = (currentDetailItemId != null && iid === currentDetailItemId);
          var keep = false;
          if (source === 'pdp_card') {
            keep = sMonth > 30 || isCurrentDetail;
          } else {
            keep = sMonth > 0 || sTotal > 0 || isCurrentDetail;
          }
          if (!keep) {
            log(source === 'pdp_card' ? 'PDP推荐卡月销未达30，跳过' : '店铺商品月/总销均为0，跳过',
                iid, '月=' + sMonth, '总=' + sTotal, '来源=' + source);
            continue;
          }
          log('店铺API录取[' + source + ']', iid, '月=' + sMonth, '总=' + sTotal, '价=' + it.price, '店=' + sid);
          var sName = it.name || '';
          var sImg = it.img || '';
          if (Array.isArray(sImg)) sImg = sImg[0];
          if (sImg) sImg = /^https?:/.test(sImg) ? sImg : ('https://down-tw.img.susercontent.com/file/' + sImg);
          var sLoc = pickValue(it, ['shop_location', 'location', 'shop_loc', 'shoplocation']);
          var sprod = {
            id: sid + '-' + iid, shopid: sid, itemid: iid,
            month_sold: sMonth, sold: sMonth, week_sold: (sMonth > 0) ? Math.round(sMonth / 4.345) : 0,
            total_sold: sTotal, sold_total: sTotal, month_sold_estimated: false,
            shop: (payload.shopName || it.shop || it.shop_name || ('店铺' + sid)),
            shop_id: (payload.shopId || String(sid)),
            keep_shop: true
          };
          if (it.price != null) sprod.price = Number(it.price);
          // ★ 价格区间上限（2026-09-10）：多规格商品才有，缺失就不写，网站按单一价格显示
          if (it.price_max != null && Number(it.price_max) > Number(it.price || 0)) {
            sprod.price_max = Number(it.price_max);
          }
          if (sName) sprod.name = String(sName);
          if (sImg) sprod.img = sImg;
          if (sLoc && typeof sLoc === 'string') sprod.loc = sLoc;
          sendProduct(sprod, source === 'pdp_card' ? 'PDP推荐' : '店铺', true);
          continue;
        }

        // ★ 单一真相源：所有端点的「月销/总销/周销/价格/id」字段语义由 sales_schema.js 统一定义，
        //   消除此前 15+ 函数各自硬编码、互相矛盾的 key 列表（这是「月销反复算错/算成0」的根因）。
        var r = S.resolveItem(it, endpoint);
        if (!r) continue;
        // 前端渲染文本兜底：asset.sold_count.text = "月銷量 410" / "已售出 211"（icsc 全无时补一次，前缀区分月销/总销）
        var af = assetTextFallback(it);
        if (af) {
          if (af.month != null && (r.month == null || r.month === 0)) r.month = af.month;
          if (af.total != null && (r.total == null || r.total === 0)) r.total = af.total;
        }
        // ★ 三态语义：未知字段 = null（绝不补 0）；下游背景 slimItem 省略 null，网站 fmtMonth 显示「未知」。
        var rec = {
          month_sold: (r.month == null) ? null : r.month,
          total_sold: (r.total == null) ? null : r.total,
          week_sold: (r.week != null && r.week > 0) ? r.week : ((r.month && r.month > 0) ? Math.round(r.month / 4.345) : 0),
          price: (r.price == null) ? undefined : r.price
        };
        // ★ 价格区间上限（2026-09-10）：多规格商品才有 price_max；缺失/不高于现价则不写
        if (r.priceMax != null && r.price != null && r.priceMax > r.price) rec.price_max = r.priceMax;
        // ★ 2026-08-20：从嵌套 item_basic / item 子对象提取名称/图片/店铺/产地/评分/点赞/库存
        var name = pickValue(it, ['name', 'title']);
        if (name) rec.name = String(name);
        var img = pickValue(it, ['image_url', 'image', 'images']);
        if (Array.isArray(img)) img = img[0];
        if (img) rec.img = /^https?:/.test(img) ? img : ('https://down-tw.img.susercontent.com/file/' + img);
        var shopRaw = pickValue(it, ['shop_name', 'shopname', 'shop']);
        if (shopRaw) {
          if (typeof shopRaw === 'string') rec.shop = shopRaw;
          else if (shopRaw.name || shopRaw.shop_name || shopRaw.shopname)
            rec.shop = shopRaw.name || shopRaw.shop_name || shopRaw.shopname;
        }
        var loc = pickValue(it, ['shop_location', 'location', 'shop_loc', 'shoplocation']);
        if (loc && typeof loc === 'string') rec.loc = loc;
        var ratingObj = pickValue(it, ['item_rating', 'itemRating', 'rating']);
        var rating = (ratingObj && typeof ratingObj === 'object') ? ratingObj.rating_star :
                     (typeof ratingObj === 'number' ? ratingObj : null);
        if (rating) rec.rating = rating;
        var liked = pickValue(it, ['liked_count', 'liked']);
        if (liked != null && !isNaN(Number(liked))) rec.liked = Number(liked);
        var stock = pickValue(it, ['stock']);
        if (stock != null && !isNaN(Number(stock))) rec.stock = Number(stock);
        // ★ 2026-08-19（防覆盖·月销 77 丢失根因防御）：capturedItems 必须是「合并」而非「覆盖」。
        //   时序：列表接口(get_shop_tab/rcmd_items 月銷量 77)先到 → 详情接口(pdp/get_pc 无销量字段=0)后到，
        //   无条件覆盖会把真实月销/总销清成 0（诊断 api_captured=0 即此现象）。
        //   合并规则：新 rec 的 0 / 空 不覆盖已有非零值；价格/名称/图片/店铺等同理。
        var _prev = capturedItems[key];
        if (_prev) {
          if (!rec.month_sold && _prev.month_sold > 0) rec.month_sold = _prev.month_sold;
          if (!rec.week_sold && _prev.week_sold > 0) rec.week_sold = _prev.week_sold;
          if (!rec.total_sold && _prev.total_sold > 0) rec.total_sold = _prev.total_sold;
          if (!rec.price && _prev.price) rec.price = _prev.price;
          if (rec.price_max == null && _prev.price_max) rec.price_max = _prev.price_max;
          if (!rec.name && _prev.name) rec.name = _prev.name;
          if (!rec.img && _prev.img) rec.img = _prev.img;
          if (!rec.shop && _prev.shop) rec.shop = _prev.shop;
          if (!rec.loc && _prev.loc) rec.loc = _prev.loc;
          if (!rec.rating && _prev.rating) rec.rating = _prev.rating;
          if (!rec.liked && _prev.liked) rec.liked = _prev.liked;
        }
        capturedItems[key] = rec;

        // 2026-08-25：列表页已停止录制，批量补抓也关闭；
        // 店铺/详情页缺月销时不再入队，避免干扰日志。
        var isListEndpoint = /search_items|recommend|get_shop_tab|rcmd_items|hot_sales/.test(payload.endpoint || '');
        if (false && !authMonth && !payload.shopCapture && browseCapture && isListEndpoint && rec.month_sold <= 0 && shopid && itemid) {
          scheduleBatchFetch(shopid, itemid, key);
        }

        // ★ 2026-08-19（关键架构）：卖家中心捕获结果写入 chrome.storage.local ——
        //   买家详情页标签页启动时可跨页面恢复。capturedItems 只是本页内存，
        //   从卖家中心跳转/另开标签到买家页后即丢失，必须持久化才能打通
        //   「卖家中心商品列表（真实月销）→ 买家详情页（同步到网站）」链路。
        var isSeller = !!payload.endpoint && payload.endpoint.indexOf('seller.') >= 0;
        if (isSeller && (rec.month_sold > 0 || rec.total_sold > 0)) {
          try {
            chrome.storage.local.get('sr_seller_capture', function (s) {
              var m = (s && s.sr_seller_capture) || {};
              m[key] = rec;
              var ks = Object.keys(m);
              if (ks.length > 500) { // 上限保护，删最早
                ks.slice(0, ks.length - 500).forEach(function (k) { delete m[k]; });
              }
              chrome.storage.local.set({ sr_seller_capture: m });
            });
          } catch (e) {}
        }

        // ★ 诊断提示：权威详情接口只有价格、没有销量 → 要么销量字段名未识别，要么该商品近30天真实月销=0
        if (authMonth && !rec.month_sold && !rec.total_sold && rec.price) {
          warn('API捕获[' + (payload.endpoint || '?') + '] 仅得价格无销量——字段名未识别或真实月销=0', itemid, 'raw keys=[' + Object.keys(it).slice(0, 24).join(',') + ']');
        }

        // 立即发一条更新给后台（mergeFields 会保留既有非零字段）
        var prod = {
          id: key, shopid: shopid, itemid: itemid,
          month_sold: rec.month_sold, sold: rec.month_sold,
          week_sold: rec.week_sold,
          total_sold: rec.total_sold, sold_total: rec.total_sold,
          month_sold_estimated: false
        };
        if (rec.price) prod.price = rec.price;
        if (rec.name) prod.name = rec.name;
        if (rec.img) prod.img = rec.img;
        if (rec.shop) prod.shop = rec.shop;
        if (rec.loc) prod.loc = rec.loc;
        if (rec.rating) prod.rating = rec.rating;
        if (rec.liked != null) prod.liked = rec.liked;
        if (rec.stock != null) prod.stock = rec.stock;
        // ★ 2026-08-20（浏览即录）：列表类接口（搜索/推荐/店铺墙/热销榜）响应里每件商品
        //   已自带月销量(icsc)，【无需点进详情】即可抓取。区分「详情权威」与「列表浏览」：
        //   - 详情类（item/get/pdp/get 等）：点开必录（现有行为）。
        //   - 列表类：仅当「浏览即录」开关开、且商品有有效销量/价格时才入库，避免空壳膨胀；
        //     关闭开关则回到「只录点开的商品」旧行为。两者都计入浮窗「浏览已扫」反馈。
        var isDetailApi = (payload.endpoint === '/api/v4/item/get' || payload.endpoint === '/api/v4/pdp/get_pc' ||
                           payload.endpoint === '/api/v4/pdp/get' || payload.endpoint === '/api/v4/item/get_rating');
        // ★ 2026-08-20 诊断：列表商品月销为 0 / 未知 时，记录 icsc 原始文本 + 销量字段扫描，便于远程定位。
        if (!isDetailApi && (rec.month_sold == null || rec.month_sold <= 0)) {
          var _icsc = S.locateIcs(it) || it.item_card_display_sold_count;
          var _icsText = _icsc ? JSON.stringify({
            monthly: _icsc.monthly_sold_count_text,
            local_monthly: _icsc.local_monthly_sold_count_text,
            historical: _icsc.historical_sold_count_text,
            display: _icsc.display_sold_count_text,
            monthly_num: _icsc.monthly_sold_count,
            historical_num: _icsc.historical_sold_count
          }) : '无 icsc';
          var _salesDebug = dumpSalesDebug(it, '', [], 0);
          warn('列表月销=0', payload.endpoint, itemid, 'icsc=', _icsText,
               'sales扫描=', _salesDebug.join(' | ') || '无',
               'keys=', Object.keys(it).slice(0, 24).join(','));
        }
        log('API捕获[' + (payload.endpoint || '?') + ']', itemid, '月=' + rec.month_sold, '总=' + rec.total_sold, '价=' + rec.price);
        if (!isDetailApi) {
          browseCount++;
          if (rec.month_sold > 0) browseMonthCount++;
          var hasData = (rec.month_sold > 0 || rec.total_sold > 0 || (rec.price && rec.price >= 30));
          if (!browseCapture || !hasData) {
            updateFloat();
            continue;   // 浏览即录关闭，或该商品无有效销量/价格 → 仅计入已扫计数，不入库
          }
        }
        sendProduct(prod, pageTag(), true);
      }
    } catch (e) { warn('handleApiCapture 异常', e.message); }
  }

  // 把已捕获的真实销量合并进一个待发送商品（解决「DOM 先发、API 后到」的时序问题）
  function applyCapture(prod) {
    if (!prod || !prod.shopid || !prod.itemid) return prod;
    var key = prod.shopid + '-' + prod.itemid;
    var rec = capturedItems[key];
    if (!rec) return prod;
    if (rec.month_sold > 0) {
      prod.month_sold = rec.month_sold;
      prod.sold = rec.month_sold;
      prod.week_sold = rec.week_sold;
      prod.month_sold_estimated = false;
    }
    if (rec.total_sold > 0) { prod.total_sold = rec.total_sold; prod.sold_total = rec.total_sold; }
    // 价格：不允许用优惠券/运费等低价覆盖真实售价（只涨不跌）
    if (rec.price && (!prod.price || rec.price > prod.price)) prod.price = rec.price;
    if (rec.name && !prod.name) prod.name = rec.name;
    if (rec.img && !prod.img) prod.img = rec.img;
    return prod;
  }

  // ---- 发送商品到后台 ----
  // isUpdate=true 表示 enrich 后的更新，不增加 sessionCount，但仍发送给后台合并
  function sendProduct(prod, tag, isUpdate) {
    if (!prod || !prod.itemid || !prod.shopid) return;
    var key = prod.shopid + '-' + prod.itemid;
    sentMonth[key] = Number(prod.month_sold) || 0;
    sentKeyAll[key] = 1;
    if (!isUpdate) {
      if (sentKeys[key]) return;
      // 若有页面接口已捕获到真实销量，先合并进本次发送，避免先发的 0 值覆盖后续真实值
      prod = applyCapture(prod);
      sentKeys[key] = true;
      sessionCount++;
    }
    // ★ 「录完这一页」计数：无条件记账（不受 isUpdate 影响），
    //   同一件只算一次，并且月销取最大值（后续 API 捕获到真实值时会补上）。
    if (pageRecTally) {
      var _m = Number(prod.month_sold) || 0;
      var _prev = pageRecTally.keys[key];
      if (_prev === undefined) {
        pageRecTally.keys[key] = _m;
        pageRecTally.n++;
        if (_m >= 30) pageRecTally.m30++;
      } else if (_m > _prev) {
        pageRecTally.keys[key] = _m;
        if (_m >= 30 && _prev < 30) pageRecTally.m30++;
      }
    }
    updateFloat();
    sendToBackground({ products: [prod], tag: tag, url: location.href });
  }

  // ---- 发送到后台（带重试）----
  function sendToBackground(msg) {
    try {
      chrome.runtime.sendMessage(msg).then(function (resp) {
        if (resp && resp.ok) log('后台确认收到');
        else warn('后台返回非ok:', resp);
      }).catch(function (err) {
        warn('sendMessage 失败，1秒后重试:', err && err.message);
        setTimeout(function () {
          chrome.runtime.sendMessage(msg).catch(function () {
            warn('重试仍失败');
          });
        }, 1000);
      });
    } catch (e) {
      warn('sendMessage 异常:', e.message);
    }
  }

  // ---- 批量补抓月销（列表接口无月销时，用页面登录态偷拉 item/get）----
  // 核心：列表接口往往只给「已售出 X」（累计），不给近30天月销。
  // 拿到 shopid+itemid 后，让 inject.js 在 MAIN world 用页面真实 header 批量请求 item/get，
  // 偷听到的真实响应走 handleApiCapture（authMonth=true），月销自动补回。
  // ★ 2026-08-20 修复：自动批量补抓是触发虾皮风控（verify/traffic/error）的主因，
  //   改为【只收集、不自动发送】，仅在用户点「立即同步」时手动 flush 一次，且最多补 10 件、
  //   并发 1、间隔 2 秒，最大限度降低额外请求量。
  var batchFetchQueue = [];
  var batchFetchSent = {};
  var batchFetchTimer = null;
  var BATCH_FETCH_CONCURRENCY = 1;
  var BATCH_FETCH_LIMIT = 10;
  function scheduleBatchFetch(shopid, itemid, key) {
    if (!shopid || !itemid || batchFetchSent[key]) return;
    batchFetchSent[key] = true;
    batchFetchQueue.push({ shopid: shopid, itemid: itemid, key: key });
    log('加入批量补抓队列（待手动同步时 flush）', key, '队列长度', batchFetchQueue.length);
  }
  function pumpBatchFetch(maxItems) {
    if (document.hidden) return;
    if (!batchFetchQueue.length) return;
    var limit = (typeof maxItems === 'number' && maxItems > 0) ? Math.min(maxItems, BATCH_FETCH_LIMIT) : BATCH_FETCH_LIMIT;
    var chunk = [];
    for (var i = 0; i < BATCH_FETCH_CONCURRENCY && batchFetchQueue.length && chunk.length < limit; i++) chunk.push(batchFetchQueue.shift());
    if (chunk.length) {
      log('批量补抓月销', chunk.length, '件', chunk.map(function (x) { return x.key; }).join(','));
      try { window.postMessage({ __SR_BATCH_FETCH__: true, items: chunk }, '*'); } catch (e) {}
    }
  }
  function flushBatchFetch(maxItems) {
    if (batchFetchTimer) { clearInterval(batchFetchTimer); batchFetchTimer = null; }
    var sent = 0;
    var remaining = (typeof maxItems === 'number' && maxItems > 0) ? maxItems : BATCH_FETCH_LIMIT;
    function next() {
      if (sent >= remaining || !batchFetchQueue.length) return;
      var chunk = [];
      for (var i = 0; i < BATCH_FETCH_CONCURRENCY && batchFetchQueue.length && chunk.length < (remaining - sent); i++) chunk.push(batchFetchQueue.shift());
      if (chunk.length) {
        sent += chunk.length;
        log('手动 flush 补抓月销', chunk.length, '件');
        try { window.postMessage({ __SR_BATCH_FETCH__: true, items: chunk }, '*'); } catch (e) {}
        setTimeout(next, 2000);
      }
    }
    next();
  }

  // ---- 浮窗 ----
  function ensureFloat() {
    if (floatEl) return;
    if (!document.body) { setTimeout(ensureFloat, 500); return; }

    var style = document.createElement('style');
    style.textContent = [
      '#sr-float{position:fixed;top:12px;right:12px;z-index:2147483647;width:210px;background:#fff;border:2px solid #e74c3c;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.2);font:13px/1.5 -apple-system,Segoe UI,Roboto,"Microsoft YaHei",sans-serif;color:#222;user-select:none;overflow:hidden}',
      '#sr-float.sr-hidden{display:none!important}',
      '#sr-float.sr-collapsed .sr-body{display:none}',
      '.sr-head{display:flex;align-items:center;gap:6px;background:#e74c3c;color:#fff;padding:7px 10px;font-weight:600}',
      '.sr-dot{width:9px;height:9px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.4);animation:sr-blink 1s infinite}',
      '@keyframes sr-blink{50%{opacity:.4}}',
      '.sr-title{flex:1;font-size:13px}',
      '.sr-min{background:transparent;border:0;color:#fff;font-size:16px;cursor:pointer;line-height:1;padding:0 2px}',
      '.sr-body{padding:10px 12px}',
      '.sr-row{margin:3px 0}',
      '.sr-row b{color:#e74c3c;font-size:16px}',
      '.sr-sync{margin-top:8px;width:100%;border:0;border-radius:7px;background:#e74c3c;color:#fff;padding:7px 0;font-size:13px;cursor:pointer;font-weight:600}',
      '.sr-sync:active{background:#c0392b}',
      '.sr-msg{margin-top:6px;min-height:16px;color:#27ae60;font-size:12px}',
      '.sr-test{margin-top:4px;width:100%;border:1px solid #ccc;border-radius:7px;background:#f8f8f8;color:#555;padding:5px 0;font-size:12px;cursor:pointer}',
      '.sr-clear{margin-top:4px;width:100%;border:1px solid #e9b3b3;border-radius:7px;background:#fff;color:#c0392b;padding:5px 0;font-size:12px;cursor:pointer}'
    ].join('\n');
    document.head.appendChild(style);

    var el = document.createElement('div');
    el.id = 'sr-float';
    el.className = 'sr-hidden';
    el.innerHTML = [
      '<div class="sr-head">',
      '  <span class="sr-dot"></span>',
      '  <span class="sr-title">虾皮录制中</span>',
      '  <span id="sr-ver" style="font-size:10px;color:#ffeb3b;margin-left:auto;"></span>',
      '  <button class="sr-min" title="收起/展开">－</button>',
      '</div>',
      '<div class="sr-body">',
      '  <div class="sr-row">本次录制：<b id="sr-session">0</b> 件</div>',
      '  <div class="sr-row">待同步：<b id="sr-pending">0</b> 件</div>',
      '  <div class="sr-row"><label style="cursor:pointer;user-select:none"><input type="checkbox" id="sr-browse" checked> 🌐 浏览即录（无需点进商品）</label></div>',
      '  <div class="sr-row">浏览已扫：<b id="sr-browse-n">0</b> 件（含月销 <b id="sr-browse-m">0</b>）</div>',
      '  <div class="sr-row">API捕获：<b id="sr-api">0</b> 件</div>',
      '  <button class="sr-sync" id="sr-sync">⚡ 立即同步</button>',
      '  <button class="sr-clear" id="sr-clear">🗑 清空待同步</button>',
      '  <button class="sr-test" id="sr-test">🔍 测试抓取</button>',
      '  <button class="sr-test" id="sr-diag">📋 导出诊断样本</button>',
      '  <div class="sr-msg" id="sr-msg"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(el);

    el.querySelector('.sr-min').addEventListener('click', function () { el.classList.toggle('sr-collapsed'); });
    var browseChk = el.querySelector('#sr-browse');
    if (browseChk) {
      browseChk.checked = browseCapture;
      browseChk.addEventListener('change', function () {
        browseCapture = !!browseChk.checked;
        try { chrome.storage.local.set({ browseCapture: browseCapture }); } catch (e) {}
        log('浏览即录:', browseCapture ? '开' : '关');
      });
    }
    el.querySelector('#sr-sync').addEventListener('click', function () {
      var msgEl = el.querySelector('#sr-msg');
      msgEl.textContent = '同步中...';
      // ★ 先让 inject.js 主动 refetch 一次（此时距页面加载已过一段时间，虾皮限流可能已解除），
      //   再触发后台同步，确保同步到网站的是最新月/周/总销。
      try { window.postMessage({ __SR_REQUEST_CAPTURE__: true }, '*'); } catch (e) {}
      // ★ 手动 flush 批量补抓队列（限制数量，避免自动补抓触发风控）
      flushBatchFetch(10);
      setTimeout(function () {
        chrome.runtime.sendMessage({ type: 'manualSync' }, function (resp) {
          if (chrome.runtime.lastError) { msgEl.textContent = '同步失败: ' + chrome.runtime.lastError.message; return; }
          if (resp && resp.ok) {
            var skip = resp.skipped ? ('，过滤月销0 ' + resp.skipped + ' 件') : '';
            msgEl.textContent = '已同步 +' + (resp.added || 0) + ' 件' + skip;
          } else {
            msgEl.textContent = '同步失败' + (resp && resp.error ? ': ' + resp.error : '');
          }
          setTimeout(function () { msgEl.textContent = ''; }, 4000);
        });
      }, 800);
    });
    el.querySelector('#sr-test').addEventListener('click', function () {
      var n = testScrape();
      var msgEl = el.querySelector('#sr-msg');
      msgEl.textContent = 'SSR:' + collectFromPageScripts().length + ' / 链接:' + n;
      msgEl.style.color = n > 0 ? '#27ae60' : '#e74c3c';
      setTimeout(function () { msgEl.textContent = ''; msgEl.style.color = ''; }, 5000);
    });
    el.querySelector('#sr-diag').addEventListener('click', function () {
      diagCapture();
    });
    el.querySelector('#sr-clear').addEventListener('click', function () {
      var msgEl = el.querySelector('#sr-msg');
      if (!confirm('确认清空全部 ' + pendingCount + ' 件待同步数据？\n（已推送到 GitHub 的数据不受影响）')) return;
      msgEl.textContent = '清空中...';
      chrome.runtime.sendMessage({ type: 'clearPending' }, function (resp) {
        if (chrome.runtime.lastError) { msgEl.textContent = '清空失败: ' + chrome.runtime.lastError.message; return; }
        if (resp && resp.ok) {
          msgEl.textContent = '✓ 已清空 ' + pendingCount + ' 件待同步数据';
        } else {
          msgEl.textContent = '清空失败' + (resp && resp.error ? ': ' + resp.error : '');
        }
        setTimeout(function () { msgEl.textContent = ''; }, 3000);
      });
    });

    floatEl = el;
    updateFloat();
  }

  function updateFloat() {
    if (!floatEl) return;
    floatEl.classList.toggle('sr-hidden', !(recordingOn && ON_BUYER));
    var s = floatEl.querySelector('#sr-session'); if (s) s.textContent = sessionCount;
    var p = floatEl.querySelector('#sr-pending'); if (p) p.textContent = pendingCount;
    var a = floatEl.querySelector('#sr-api'); if (a) a.textContent = apiCaptureCount;
    var bn = floatEl.querySelector('#sr-browse-n'); if (bn) bn.textContent = browseCount;
    var bm = floatEl.querySelector('#sr-browse-m'); if (bm) bm.textContent = browseMonthCount;
    var bc = floatEl.querySelector('#sr-browse'); if (bc && bc.checked !== browseCapture) bc.checked = browseCapture;
    var title = floatEl.querySelector('.sr-title');
    if (title) title.textContent = recordingOn ? '虾皮录制中' : '录制已暂停';
    var dot = floatEl.querySelector('.sr-dot');
    if (dot) dot.style.animation = recordingOn ? 'sr-blink 1s infinite' : 'none';
    var ver = floatEl.querySelector('#sr-ver');
    if (ver) ver.textContent = injectVersion ? ('v' + injectVersion) : 'v?';
  }

  function setRecording(on) {
    recordingOn = !!on;
    log('录制状态:', recordingOn ? '开' : '关');
    if (recordingOn && ON_BUYER) ensureFloat();
    updateFloat();
    if (recordingOn) scrapeCards();
  }

  function downloadJSON(obj, filename) {
    try {
      var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 1500);
    } catch (e) { log('download 失败', e.message); }
  }

  // 导出当前商品详情页的「原始接口/HTML + 解析结果」诊断样本。
  // 用户把生成的 JSON 发给我，我用真实数据锁定提取逻辑，保证录制的都是真实数据。
  function diagCapture() {
    var ids = getCurrentPageItemIds();
    var msgEl = floatEl && floatEl.querySelector('#sr-msg');
    if (!ids) {
      // ★ 2026-08-26：店铺页/其他页也能导出诊断——不再强制要求商品详情页，
      //   便于排查「进店铺也是0」等问题。仅跳过需要 itemid 的主动接口/HTML 请求。
      if (msgEl) { msgEl.textContent = '诊断采集中（非详情页）…'; msgEl.style.color = ''; }
      var _sid = null;
      var _m = /shopee\.tw\/shop\/(\d+)/.exec(location.href) || /[?&]shopid=(\d+)/.exec(location.href);
      if (_m) _sid = _m[1];
      var r0 = {
        url: location.href, page: pageTag(), shopid: _sid, itemid: null, ts: Date.now(),
        api: null, html: null, parsed: null, notes: ['非商品详情页，仅导出已捕获/日志/DOM 供排查']
      };
      try {
        var _cap = [];
        for (var _k in capturedItems) { if (capturedItems.hasOwnProperty(_k)) _cap.push({ key: _k, month: capturedItems[_k].month_sold, total: capturedItems[_k].total_sold }); }
        r0.captured_items = _cap;
      } catch (e) {}
      // ★ 诊断：inject.js 发来的店铺/推荐卡原始样本 + 逐件 resolveItem 结果（定位月销=0 根因）
      r0.shop_diag = lastShopDiag;
      r0.inject_ready = apiInterceptLog.some(function (x) { return x.msg === 'inject.js 已就位'; });
      r0.intercept_log = apiInterceptLog.slice(-80);
      r0.all_requests = reqLog.slice(-40);
      r0.active_refetch = apiInterceptLog.filter(function (x) { return x.endpoint === 'active-refetch'; });
      r0.captured_requests = capturedUrlLog.slice(-20);
      var _live = (document.body ? document.body.innerText : '') || '';
      r0.live_dom_text = _live.slice(0, 12000);
      r0.live_sales = extractSalesFromLiveDOM(_live.slice(0, 4000), 'auto');
      try {
        var _ssr = collectFromPageScripts();
        r0.ssr_scan = { total: _ssr.length, sample: _ssr.slice(0, 5).map(function (s) {
          return { itemid: s.itemid != null ? s.itemid : s.item_id, shopid: s.shopid != null ? s.shopid : s.shop_id, sold: s.sold, historical_sold: s.historical_sold, name: s.name ? String(s.name).slice(0, 30) : null };
        }) };
      } catch (e) {}
      downloadJSON(r0, 'sr_diag_' + (_sid || 'page') + '_' + pageTag() + '.json');
      if (msgEl) { msgEl.textContent = '已导出诊断文件，请发我'; msgEl.style.color = '#27ae60'; setTimeout(function () { if (msgEl) { msgEl.textContent = ''; msgEl.style.color = ''; } }, 6000); }
      return;
    }
    if (msgEl) { msgEl.textContent = '诊断采集中...'; msgEl.style.color = ''; }
    var url = 'https://shopee.tw/api/v4/item/get?itemid=' + encodeURIComponent(ids.itemid) + '&shopid=' + encodeURIComponent(ids.shopid);
    var result = { url: location.href, shopid: ids.shopid, itemid: ids.itemid, ts: Date.now(), api: null, html: null, parsed: null, notes: [] };
    // 关键：inject.js 偷听到的真实接口响应（等价于 recorder.py 抓到的 item.sold / historical_sold）
    result.api_captured = capturedItems[ids.shopid + '-' + ids.itemid] || null;
    result.inject_ready = apiInterceptLog.some(function (x) { return x.msg === 'inject.js 已就位'; });
    // 2026-08-19：dump 日志增多（卖家中心无条件 dump + 每条响应 2 条），放宽到最近 80 条
    result.intercept_log = apiInterceptLog.slice(-80);
    // 页面经过嗅探器的所有请求 URL（用于确认页面到底发了哪些接口，定位捕获为 0 的根因）
    // ★ 不能直接读 window.__SR_REQ_LOG__（跨 world 读不到），用 inject.js postMessage 推送的 reqLog
    result.all_requests = reqLog.slice(-40);
    // 主动 refetch 的结果（status / sold / historical_sold 等）
    result.active_refetch = apiInterceptLog.filter(function (x) { return x.endpoint === 'active-refetch'; });
    // 已捕获的真实请求 URL（item/get / pdp/get / pdp/get_pc 等），用于确认页面发了哪些接口、我们抓没抓到
    result.captured_requests = capturedUrlLog.slice(-20);
    // 关键：抓取页面真实渲染后的 DOM 文本——这才是用户看到的真实销量文案，
    // 用于锁定「月銷 / 近30天 / 已售出」等标签的确切写法，彻底校准提取逻辑。
    var liveText = (document.body ? document.body.innerText : '') || '';
    result.live_dom_text = liveText.slice(0, 12000);
    result.live_sales = extractSalesFromLiveDOM(liveText.slice(0, 4000), 'auto');
    // ★ SSR 扫描结果：页面 script 里的商品对象（含 item.sold / historical_sold 等权威字段）
    try {
      var ssrScan = [];
      var ssrItems = collectFromPageScripts();
      for (var i = 0; i < Math.min(ssrItems.length, 10); i++) {
        var si = ssrItems[i];
        ssrScan.push({
          itemid: si.itemid != null ? si.itemid : si.item_id,
          shopid: si.shopid != null ? si.shopid : si.shop_id,
          sold: si.sold, historical_sold: si.historical_sold,
          price: si.price, name: si.name ? String(si.name).slice(0, 40) : null
        });
      }
      result.ssr_scan = { total: ssrItems.length, items: ssrScan };
    } catch (e) { result.ssr_scan = { error: e.message }; }
    // ★ SSR script 原文片段：确认虾皮 SSR 里销量字段的确切位置/写法（近30天月销可能在 __INITIAL_STATE__）
    try {
      var hitFrags = [];
      var scripts = document.querySelectorAll('script');
      for (var i = 0; i < scripts.length && hitFrags.length < 6; i++) {
        var t = scripts[i].textContent || '';
        var idx = t.indexOf('historical_sold');
        if (idx < 0) idx = t.indexOf('"sold"');
        if (idx < 0) idx = t.indexOf('item_basic');
        if (idx < 0) continue;
        hitFrags.push(t.slice(Math.max(0, idx - 120), idx + 220));
      }
      result.ssr_fragments = hitFrags;
    } catch (e) { result.ssr_fragments = []; }
    bgFetch(url, { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) {
        if (!r) { result.notes.push('api: bgFetch 返回空'); return; }
        result.api_status = r.status != null ? r.status : (r.ok ? 200 : 0);
        if (!r.ok) { result.notes.push('api: HTTP ' + result.api_status); return; }
        return r.json().then(function (j) {
          var item = (j.data && (j.data.item || (j.data.data && j.data.data.item))) || j.item || null;
          if (!item) { result.notes.push('api: 无 item'); return; }
          result.api_item_keys = Object.keys(item).filter(function (k) { return !Array.isArray(item[k]) || item[k].length < 30; });
          result.api_sold = item.sold;
          result.api_historical_sold = item.historical_sold;
          result.api_price = item.price;
          var rr = S.resolveItem(item, 'item/get');
          result.parsed = rr ? { month_sold: rr.month, total_sold: rr.total, week_sold: rr.week, price: rr.price, name: rr.name, img: rr.img } : null;
          try { result.api_item_sample = JSON.stringify(item, function (k, v) { if (Array.isArray(v) && v.length > 8) return '[array ' + v.length + ']'; return v; }, 1).slice(0, 5000); } catch (e) { result.api_item_sample = 'stringify fail: ' + e.message; }
        }).catch(function (e) { result.notes.push('api json 解析失败: ' + e.message); });
      })
      .catch(function (e) { result.notes.push('api 异常: ' + e.message); })
      .then(function () {
        return fetchDetailHTML(ids.shopid, ids.itemid).then(function (h) {
          if (h) result.html_parsed = { month_sold: h.month_sold, total_sold: h.total_sold, price: h.price };
          else result.notes.push('html: 无销量');
        });
      })
      .then(function () {
        // ★ 2026-08-19：卖家中心跨页面捕获数据（storage.local）并入诊断，
        //   便于直接确认「卖家中心捕获 → 买家页恢复」链路是否打通。
        return new Promise(function (resolve) {
          try {
            chrome.storage.local.get('sr_seller_capture', function (s) {
              var m = (s && s.sr_seller_capture) || {};
              result.seller_capture = m[ids.shopid + '-' + ids.itemid] || null;
              result.seller_capture_total = Object.keys(m).length;
              resolve();
            });
          } catch (e) { resolve(); }
        });
      })
      .then(function () {
        downloadJSON(result, 'sr_diag_' + ids.shopid + '_' + ids.itemid + '.json');
        log('诊断完成', JSON.stringify(result));
        if (msgEl) { msgEl.textContent = '已导出诊断文件，请发我'; msgEl.style.color = '#27ae60'; setTimeout(function () { if (msgEl) { msgEl.textContent = ''; msgEl.style.color = ''; } }, 6000); }
      })
      .catch(function (e) { if (msgEl) { msgEl.textContent = '诊断失败: ' + e.message; msgEl.style.color = '#e74c3c'; } log('diag 异常', e.message); });
  }

  // ---- 测试函数（也可从控制台调用）----
  function testScrape() {
    var links = document.querySelectorAll('a[href*="-i."], a[href*="/product/"]');
    if (!links.length) links = document.querySelectorAll('a[href]');
    var count = 0;
    for (var i = 0; i < links.length; i++) {
      var si = parseShopItem(links[i].href || '');
      if (si) {
        count++;
        if (count <= 3) log('  示例:', links[i].href, '->', si);
      }
    }
    var ssr = collectFromPageScripts();
    log('测试: SSR=' + ssr.length + ', 链接=' + count);
    return count;
  }
  window.__SR_TEST__ = testScrape;

  // ---- 初始化 ----
  log('脚本启动 @ ' + location.href);
  log('ON_BUYER=' + ON_BUYER + ' hostname=' + location.hostname);

  // 读取录制状态
  try {
    chrome.storage.local.get(['recording'], function (s) {
      setRecording(s.recording !== false);
    });
  } catch (e) {
    warn('storage 读取失败:', e.message);
    setRecording(true);
  }
  // ★ 2026-08-20：读取浏览即录开关（默认开）
  try {
    chrome.storage.local.get(['browseCapture'], function (s) {
      browseCapture = (s.browseCapture !== false);
    });
  } catch (e) { browseCapture = true; }
  // 实时同步开关变化（浮窗/设置切换都生效）
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.browseCapture) {
        browseCapture = (changes.browseCapture.newValue !== false);
        updateFloat();
      }
    });
  } catch (e) {}

  // 监听录制状态变化
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.recording) {
      setRecording(changes.recording.newValue !== false);
    }
  });

  // ★ 2026-08-19（关键）：恢复卖家中心跨页面捕获数据（卖家中心商品列表 → 买家详情页）。
  //   capturedItems 只是本页内存，从卖家中心跳转/另开标签到买家页后即丢失；
  //   storage.local 里的 sr_seller_capture 存有卖家中心捕获的真实销量（月销/总销），
  //   买家页启动时合并进来，点「立即同步」即可命中当前商品直达后台。
  try {
    chrome.storage.local.get('sr_seller_capture', function (s) {
      var m = (s && s.sr_seller_capture) || {};
      var n = 0;
      for (var k in m) {
        if (m.hasOwnProperty(k) && m[k]) { capturedItems[k] = m[k]; n++; }
      }
      if (n > 0) {
        log('恢复卖家中心捕获', n, '条');
        var ids0 = getCurrentPageItemIds();
        if (ids0) {
          var cap0 = capturedItems[ids0.shopid + '-' + ids0.itemid];
          if (cap0 && (cap0.month_sold > 0 || cap0.total_sold > 0 || cap0.price)) {
            var prod0 = {
              id: ids0.shopid + '-' + ids0.itemid, shopid: ids0.shopid, itemid: ids0.itemid,
              month_sold: cap0.month_sold, sold: cap0.month_sold,
              week_sold: cap0.week_sold,
              total_sold: cap0.total_sold, sold_total: cap0.total_sold,
              month_sold_estimated: false
            };
            if (cap0.price) prod0.price = cap0.price;
            if (cap0.name) prod0.name = cap0.name;
            if (cap0.img) prod0.img = cap0.img;
            log('卖家中心捕获命中当前商品', ids0.itemid, '月=' + cap0.month_sold, '总=' + cap0.total_sold);
            sendProduct(prod0, pageTag(), true);
          }
        }
      }
    });
  } catch (e) {
    warn('恢复卖家中心捕获失败:', e.message);
  }

  // ---- ★ 2026-09-11「录完这一页」：自动滚到底，把这一页 / 这家店的商品全部加载出来 ----
  // 为什么需要：现在必须手动滚，而列表是分批懒加载的 —— 快滚时中间会漏掉整批商品，
  //   手动滚一页要 1~2 分钟，还容易漏。这里只做「等价于人手动滚动」这一个动作。
  // 三条自我约束（对齐项目红线「绝不让跨境卫士登录出问题」）：
  //   ① 只滚动，不点任何按钮、不发任何额外请求 → 不新增风控面；
  //   ② 步长固定、间隔 1.2 秒；连续 3 次页面高度不增长即判定到底；
  //   ③ 最多 120 步 / 90 秒；录制开关一关立即停；全程不调 enrich（不拉详情页 HTML，避免 403）。
  var pageRecRunning = false;
  function recordWholePage() {
    return new Promise(function (resolve) {
      if (pageRecRunning) { resolve({ ok: false, error: '正在录制中，请稍候' }); return; }
      if (!recordingOn) { resolve({ ok: false, error: '录制开关没开（面板上拨到红色再试）' }); return; }
      var tag = pageTag();
      // ★ 用白名单而非黑名单：pageTag() 对搜索页返回 '搜索'、每日发现返回 '每日新发现'，
      //   只盯着 '浏览' 会让这些页面漏过去照样滚，然后报「已经录过了」—— 那是骗人。
      if (tag !== '店铺' && tag !== '商品详情') {
        // 搜索 / 每日发现 / 首页自 2026-08-25 起就不录制（低质噪音多）。如实说明，别让用户以为功能坏了。
        resolve({ ok: false, error: '这个页面不在录制范围（搜索页 / 每日发现 / 首页）——请在「店铺页」使用，或点开商品进详情页' });
        return;
      }
      pageRecRunning = true;
      pageRecTally = { keys: {}, n: 0, m30: 0 };
      var steps = 0, lastH = -1, still = 0, t0 = Date.now();
      function finish() {
        pageRecRunning = false;
        try { scrapeCards(); } catch (e) {}
        setTimeout(function () {
          var tally = pageRecTally;
          pageRecTally = null;
          try { updateFloat(); } catch (e) {}
          var added = tally ? tally.n : 0, m30 = tally ? tally.m30 : 0;
          log('录完这一页完成：新增=' + added + ' 月销≥30=' + m30 + ' 步数=' + steps);
          // 在页面上也给一个明确的结果回执：用户不用回头去看弹窗，
          // 也不会因为「等了半天什么都没看到」而怀疑功能坏了。
          try {
            var el = floatEl && floatEl.querySelector('#sr-msg');
            if (el) {
              el.textContent = '✅ 录完这一页：新增 ' + added + ' 件（月销≥30 的 ' + m30 + ' 件）· 用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒';
              el.style.color = '#27ae60';
              setTimeout(function () {
                if (el.textContent && el.textContent.indexOf('录完这一页') >= 0) { el.textContent = ''; el.style.color = ''; }
              }, 8000);
            }
          } catch (e) {}
          resolve({ ok: true, tag: tag, added: added, month30: m30,
                    total: Object.keys(sentKeyAll).length, seconds: Math.round((Date.now() - t0) / 1000) });
        }, 1200);
      }
      // ★ 2026-09-11 提速：不再每步死等 1.2 秒。
      //   旧写法固定 setTimeout(tick, 1200)：实测虾皮懒加载通常 200~600ms 就回来了，
      //   一页 20 批就白等 20 秒以上（用户主观感受「卡在那儿不动」）。
      //   现在改成「盯着页面高度」：每 150ms 看一眼新内容有没有进来，一进来立刻走下一步；
      //   没进来则最多等满 1200ms —— 所以**慢的时候与旧版耗时完全相同，快的时候成倍提前**。
      //   三重上限（连续 3 次高度不增长 / 120 步 / 90 秒）与「录制开关一关立即停」一个都没动。
      //   注意：参照高度取「本步开始滚动前的高度」，与下面 still 的判据同源 ——
      //   这样「waitGrow 认为涨了」⟺「下一步 tick 会把 still 归零」，两者不会互相矛盾。
      var POLL_MS = 150, STEP_MAX_MS = 1200;
      function waitGrow(refH, cb) {
        var waited = 0;
        function probe() {
          if (!recordingOn) { cb(); return; }
          waited += POLL_MS;
          var h = document.documentElement.scrollHeight || 0;
          if (h > refH || waited >= STEP_MAX_MS) { cb(); return; }
          setTimeout(probe, POLL_MS);
        }
        setTimeout(probe, POLL_MS);
      }
      // 进度反馈：录制最长可跑 90 秒，全程不给任何指示时用户只会以为「卡死了」，
      // 于是手动去点、去关开关 —— 反而打断录制。这里每步刷一行进度，
      // 让人一眼看出「在动」以及还要多久。
      function showProgress(steps, t0) {
        try {
          var el = floatEl && floatEl.querySelector('#sr-msg');
          if (!el || !pageRecTally) return;
          var sec = Math.round((Date.now() - t0) / 1000);
          el.textContent = '录完这一页：第 ' + steps + ' 步 · 本轮新增 ' + pageRecTally.n + ' 件 · 已用 ' + sec + ' 秒';
          el.style.color = '#e67e22';
        } catch (e) {}
      }
      function tick() {
        if (!recordingOn) { finish(); return; }
        var h = document.documentElement.scrollHeight || 0;
        window.scrollTo(0, h);
        steps++;
        if (h <= lastH) still++; else still = 0;
        lastH = h;
        showProgress(steps, t0);
        if (still >= 3 || steps >= 120 || (Date.now() - t0) > 90000) { finish(); return; }
        waitGrow(h, tick);
      }
      tick();
    });
  }

  // 监听后台推送的 pendingCount，以及面板发来的「录完这一页」指令
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'pendingCount') {
      pendingCount = msg.n || 0;
      updateFloat();
      return;
    }
    if (msg.type === 'recordPage') {
      recordWholePage().then(function (r) { sendResponse(r); })
        .catch(function (e) { sendResponse({ ok: false, error: (e && e.message) || '未知异常' }); });
      return true; // 异步回执，保持消息通道
    }
  });

  // 监听页面主环境 inject.js 偷听到的真实接口响应（MAIN world → ISOLATED world 桥接）
  window.addEventListener('message', function (ev) {
    try {
      var d = ev.data;
      if (!d) return;
      if (d.__SR_API_CAPTURE__ && d.payload) {
        handleApiCapture(d.payload);
      } else if (d.__SR_INJECT_READY__) {
        var iv = d.version || 'unknown';
        log('inject.js 嗅探器已就位（MAIN world），版本=' + iv);
        apiInterceptLog.push({ ts: Date.now(), endpoint: 'inject-ready', msg: 'inject.js 已就位，版本=' + iv });
        injectVersion = iv;
        updateFloat();
        // 就位后立刻让 inject.js 主动 refetch 一次当前商品（不依赖定时器）
        try { window.postMessage({ __SR_REQUEST_CAPTURE__: true }, '*'); } catch (e) {}
      } else if (d.__SR_REQ_LOG_SYNC__ && d.urls) {
        reqLog = d.urls; // 跨 world 读不到 window.__SR_REQ_LOG__，改用 inject.js 推送
      } else if (d.__SR_INTERCEPT_LOG__) {
        apiInterceptLog.push({ ts: Date.now(), endpoint: d.endpoint, msg: d.msg, preview: d.preview });
        // ★ 2026-08-19：卖家中心无条件 dump 后日志量大增，容量放宽到 150
        if (apiInterceptLog.length > 150) apiInterceptLog.shift();
      } else if (d.__SR_SHOP_DIAG__) {
        // ★ 诊断：inject.js 发来的店铺/推荐卡原始样本 + 逐件 resolveItem 结果
        lastShopDiag = { ts: Date.now(), endpoint: d.endpoint, count: d.count,
                         resolved: d.resolved, rawSample: d.rawSample };
      }
    } catch (e) {}
  });

  // SPA 路由监听
  try {
    var op = history.pushState, or = history.replaceState;
    function onRoute() {
      log('路由变化: ' + location.href);
      // 路由变化后 SSR script 也会刷新，清空 seenIds 允许重新扫描
      seenIds = {};
      setTimeout(scrapeCards, 600);
      setTimeout(scrapeCards, 1500);
      setTimeout(scrapeCards, 3000);
    }
    history.pushState = function () { op.apply(this, arguments); onRoute(); };
    history.replaceState = function () { or.apply(this, arguments); onRoute(); };
    window.addEventListener('popstate', onRoute);
    log('history hook 已安装');
  } catch (e) {
    warn('history hook 失败:', e.message);
  }

  // MutationObserver：监听 DOM 变化（翻页/无限滚动新插入的商品卡）
  var domTimer = null;
  try {
    var mo = new MutationObserver(function () {
      if (domTimer) return;
      domTimer = setTimeout(function () { domTimer = null; scrapeCards(); }, 1500);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    log('MutationObserver 已启动');
  } catch (e) {
    warn('MutationObserver 失败:', e.message);
  }

  // 定期扫描
  [1000, 2000, 4000, 6000, 10000, 15000, 25000, 45000].forEach(function (t) {
    setTimeout(scrapeCards, t);
  });

  // ★ 2026-08-20：每 10 秒 ping 一次 background，既保活 service worker，又确保自动同步定时器持续运行
  setInterval(function () {
    try {
      chrome.runtime.sendMessage({ type: 'ping' }, function (r) {
        if (chrome.runtime.lastError) return;
        log('保活 ping OK', r && r.ts);
      });
    } catch (e) {}
  }, 10000);

  // 2026-08-25：列表页已停止录制，批量补抓队列不再使用，避免无意义日志。

  log('content.js 初始化完成');
})();
