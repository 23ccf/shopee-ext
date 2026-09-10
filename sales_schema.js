/*
 * sales_schema.js —— 虾皮选品录制器「单一字段字典 / 单一真相源」
 *
 * 用途：
 *  - 统一所有接口（item/get、pdp/get_pc、get_shop_tab、get_item_cards、search_items …）
 *    的「月销 / 总销 / 周销 / 价格 / id / shopid」提取逻辑，消除此前 15+ 个函数各自
 *    硬编码、互相矛盾的 key 列表（这是「月销反复算错」的根因）。
 *  - 字段语义「端点化」：同一字段 `sold` 在 item/get = 月销，在 pdp/get_pc = 累计总销，
 *    在列表接口 = 累计总销。所有语义只在本文件一处定义。
 *  - 零 DOM / 零 window 依赖，浏览器两端（MAIN/ISOLATED world）与 Node 测试共用。
 *
 * 设计要点（对应复盘 5 个错误）：
 *  错误1 语义混淆 → 本文件 endpoints 把字段语义端点化，单点定义。
 *  错误3 逻辑分散 → 所有提取走 S.resolveItem 单一入口，删除分散函数。
 *  错误4 脆弱依赖 → get_shop_tab/get_item_cards 月销主源是卡片自带 icsc，item/get 仅覆盖层。
 *  错误5 零即坏   → resolveItem 对未知字段返回 null（不是 0），下游据此显示「未知」。
 */
(function (global) {
  'use strict';

  // 变体/营销容器不深入：里面的 sold 是单 SKU 销量，会污染商品级月销
  var SKIP = ['model_list', 'tier_variation', 'variations', 'add_on_deal_info',
              'flash_sale', 'bundle_deal', 'add_on_deal'];

  // 端点注册表：每个端点的字段路径 + 价格单位 + 字段语义
  // source 类型：
  //   {type:'key',  k:'sold'}             → 在商品对象里按 key 深搜取值
  //   {type:'icsc', which:'month'|'total'} → 从 item_card_display_sold_count 对象取值
  //   {type:'dom',  re:'月銷'}             → 占位，DOM 文案兜底在 content.js 另处处理
  //   {type:'price',keys:[...],unit:N}     → 价格原始字段 + 换算单位
  var SR_SCHEMA = {
    skip: SKIP,
    icsc: {
      locateKey: 'item_card_display_sold_count',
      month: {
        num: ['monthly_sold_count', 'rounded_local_monthly_sold_count',
              'rounded_global_monthly_sold_count', 'local_monthly_sold_count'],
        text: ['monthly_sold_count_text', 'local_monthly_sold_count_text',
               'global_monthly_sold_count_text']
      },
      total: {
        num: ['historical_sold_count', 'rounded_local_historical_sold_count',
              'rounded_global_historical_sold_count', 'display_sold_count'],
        text: ['historical_sold_count_text', 'local_historical_sold_count_text',
               'global_historical_sold_count_text', 'display_sold_count_text']
      }
    },
    endpoints: {
      'item/get': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        // ★ sold = 近30天月销（权威）；historical_sold = 累计。这是「唯一正确」的真值来源。
        month: [k('sold'), k('monthly_sold'), k('month_sales'), k('recent_sold'),
                k('sold_count'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('total_sold'),
                k('cumulative_sold'), icsc('total')],
        week: [k('week_sold'), k('weekly_sold')],
        price: price(['price', 'price_min'], 100000),
        name: ['name', 'title'], img: ['image', 'images']
      },
      'item/get_rating': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        month: [k('sold'), k('monthly_sold'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('total_sold'), icsc('total')],
        price: price(['price', 'price_min'], 100000), name: ['name', 'title'], img: ['image', 'images']
      },
      'pdp/get_pc': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        // ★ sold 在此 = 累计总销，绝不当月销（曾误当权威 → 月销=2000 错误）
        month: [icsc('month'), dom('月銷')],
        total: [k('sold'), k('historical_sold'), k('sold_total'), icsc('total')],
        price: price(['price', 'price_min'], 100000)
      },
      'pdp/get': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        month: [icsc('month'), dom('月銷')],
        total: [k('sold'), k('historical_sold'), k('sold_total'), icsc('total')],
        price: price(['price', 'price_min'], 100000)
      },
      'get_shop_tab': {
        itemWrap: 'item_data', // 每张卡片 item 在 item_data 下
        id: ['itemid', 'item_id', 'item_data.itemid'],
        shopid: ['shopid', 'shop_id', 'item_data.shopid'],
        // ★ 卡片自带 icsc 是主源（反转 item/get 依赖）
        month: [icsc('month')],
        total: [icsc('total')],
        name: ['name', 'title'],
        img: ['image', 'image_info.image_url', 'image_url', 'thumb_url'],
        // 价格：列表/店铺接口 price/price_min 为「分」(×100)，实测原始值即分（如 ¥77 商品原始值=7700）。
        // 旧值误写 10 → 价格大 10 倍且带小数。÷100 还原。
        price: price(['price', 'price_min'], 100)
      },
      'get_item_cards': {
        itemWrap: 'item_data',
        id: ['itemid', 'item_id', 'item_data.itemid'],
        shopid: ['shopid', 'shop_id', 'item_data.shopid'],
        month: [icsc('month')],
        total: [icsc('total')],
        name: ['name', 'title'],
        img: ['image', 'image_info.image_url', 'image_url', 'thumb_url'],
        // 金矿接口：item_data.item_card_display_price.price 实测 ×100000
        price: price(['item_data.item_card_display_price.price'], 100000)
      },
      'rcmd_items': {
        itemWrap: 'item_data', id: ['itemid', 'item_id', 'item_data.itemid'],
        shopid: ['shopid', 'shop_id', 'item_data.shopid'],
        month: [icsc('month')], total: [icsc('total')],
        price: price(['price', 'price_min'], 100)
      },
      'hot_sales': {
        itemWrap: 'item_data', id: ['itemid', 'item_id', 'item_data.itemid'],
        shopid: ['shopid', 'shop_id', 'item_data.shopid'],
        month: [icsc('month')], total: [icsc('total')],
        price: price(['price', 'price_min'], 100)
      },
      'search_items': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        // 列表 item_basic.sold = 近30天月销（recorder.py 已验证）
        month: [k('sold'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('total_sold'), k('sold')],
        price: price(['price', 'price_min'], 100)
      },
      'recommend': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        month: [k('sold'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('total_sold'), k('sold')],
        price: price(['price', 'price_min'], 100)
      },
      'seller.*': { // 卖家中心：裸 sold = 累计，仅 30d 语义字段当月销
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        month: [k('monthly_sold'), k('month_sales'), k('sold_30d'), k('recent_sales'),
                k('sales_30d'), k('month_sold_count'), k('sold_in_30_days'),
                k('sold30'), k('recent_sold'), k('monthSold')],
        total: [k('sold'), k('sold_count')],
        price: price(['price', 'price_min'], 1)
      },
      'get_shop_seo': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        month: [k('sold'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('sold')],
        price: price(['price', 'price_min'], 100)
      }
    }
  };

  // ---- 通用工具 ----
  function k(key) { return { type: 'key', k: key }; }
  function icsc(which) { return { type: 'icsc', which: which }; }
  function dom(re) { return { type: 'dom', re: re }; }
  function price(keys, unit) { return { type: 'price', keys: keys, unit: unit }; }
  // 价格区间上限（2026-09-10 新增）：虾皮对「多规格」商品用 price_max 表示最高价。
  // 换算单位与 price 共用同一 unit，避免「下限除过、上限没除」的错位。
  var PRICE_MAX_KEYS = ['price_max', 'item_data.item_card_display_price.price_max'];

  function coerceIntLocal(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? Math.round(v) : null;
    if (typeof v === 'string') {
      var m = String(v).replace(/[^\d]/g, '');
      var n = parseInt(m, 10);
      return isNaN(n) ? null : n;
    }
    if (typeof v === 'object') {
      return coerceIntLocal(v.sold) || coerceIntLocal(v.monthly_sold) ||
             coerceIntLocal(v.sold_count) || coerceIntLocal(v.sales);
    }
    return null;
  }
  function parseNumLocal(str) {
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

  // 深度取数：path 为点分字符串，支持 'a.b'、'arr[2]'
  function deepGet(obj, path) {
    if (obj == null) return undefined;
    var segs = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < segs.length; i++) {
      if (cur == null) return undefined;
      var seg = segs[i];
      var am = seg.match(/^(.*)\[(\d+)\]$/);
      if (am) { cur = cur[am[1]]; if (cur) cur = cur[parseInt(am[2], 10)]; }
      else cur = cur[seg];
    }
    return cur;
  }
  // 受控深搜：遇 SKIP 容器不深入，命中 keys 之一即 coerceInt 返回（首命中优先）
  function findByKeyDeep(obj, keys, depth) {
    if (depth == null) depth = 0;
    if (depth > 6 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        var r = findByKeyDeep(obj[i], keys, depth);
        if (r != null) return r;
      }
      return null;
    }
    for (var kk in obj) {
      if (!obj.hasOwnProperty(kk)) continue;
      if (SKIP.indexOf(kk) >= 0) continue;
      if (keys.indexOf(kk) >= 0) {
        var v = coerceIntLocal(obj[kk]);
        if (v != null) return v;
      }
    }
    for (var k2 in obj) {
      if (!obj.hasOwnProperty(k2)) continue;
      if (SKIP.indexOf(k2) >= 0) continue;
      var v2 = obj[k2];
      if (v2 && typeof v2 === 'object') {
        var r2 = findByKeyDeep(v2, keys, depth + 1);
        if (r2 != null) return r2;
      }
    }
    return null;
  }
  // ★ 合并旧 findIcs(inject) 与 locateIcs(content) 的唯一实现
  function locateIcs(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 6) return null;
    if (obj[SR_SCHEMA.icsc.locateKey] && typeof obj[SR_SCHEMA.icsc.locateKey] === 'object') {
      return obj[SR_SCHEMA.icsc.locateKey];
    }
    if (obj.monthly_sold_count != null || obj.monthly_sold_count_text != null ||
        obj.historical_sold_count != null) return obj;
    for (var key in obj) {
      if (!obj.hasOwnProperty(key)) continue;
      var v = obj[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        var r = locateIcs(v, (depth || 0) + 1);
        if (r) return r;
      }
    }
    return null;
  }
  function readIcscNum(obj, which) {
    var spec = SR_SCHEMA.icsc[which];
    var o = locateIcs(obj);
    if (!o) return null;
    for (var i = 0; i < spec.num.length; i++) {
      var n = coerceIntLocal(o[spec.num[i]]);
      if (n != null && n > 0) return n;
    }
    for (var j = 0; j < spec.text.length; j++) {
      var t = parseNumLocal(o[spec.text[j]]);
      if (t != null && t > 0) return t;
    }
    return null;
  }
  function convertPrice(raw, unit) {
    if (raw == null) return undefined;
    var n = (typeof raw === 'number') ? raw : parseFloat(String(raw).replace(/,/g, ''));
    if (isNaN(n) || n <= 0) return undefined;
    return Math.round(n / unit);
  }
  function firstDeep(it, paths) {
    if (!paths) return null;
    for (var i = 0; i < paths.length; i++) {
      var v = deepGet(it, paths[i]);
      if (v != null) return v;
    }
    return null;
  }
  // 解包：合并 item_basic / item / itemWrap(item_data) 到同一平面对象，便于深搜
  function unwrapItem(item, ep) {
    if (!item || typeof item !== 'object') return null;
    var merged = {};
    ['item_basic', 'item', ep.itemWrap, ''].forEach(function (tag) {
      var src = tag ? item[tag] : item;
      if (src && typeof src === 'object') {
        for (var key in src) {
          if (src.hasOwnProperty(key) && merged[key] == null) merged[key] = src[key];
        }
      }
    });
    return merged;
  }
  function resolveSources(it, sources) {
    if (!sources) return null;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var v = null;
      if (s.type === 'key') v = findByKeyDeep(it, [s.k], 0);
      else if (s.type === 'icsc') v = readIcscNum(it, s.which);
      // dom 兜底由 content.js 在别处补充，这里忽略
      if (v != null) return v;
    }
    return null;
  }
  // ★ 统一解析入口：返回 tri-state（未知 = null，绝不补 0）
  function resolveItem(item, endpoint) {
    var epKey = matchEndpoint(endpoint);
    var ep = SR_SCHEMA.endpoints[epKey];
    if (!ep) return null;
    var it = unwrapItem(item, ep);
    if (!it) return null;
    var id = firstDeep(it, ep.id);
    var sid = firstDeep(it, ep.shopid);
    if (id == null || sid == null) return null;
    var month = resolveSources(it, ep.month);
    var total = resolveSources(it, ep.total);
    var week = resolveSources(it, ep.week || []);
    if (week == null && month != null && month > 0) week = Math.round(month / 4.345);
    var priceVal = (ep.price && ep.price.type === 'price')
      ? convertPrice(firstDeep(it, ep.price.keys), ep.price.unit) : undefined;
    // ★ 价格区间上限：仅当商品确有 price_max 且严格高于现价时才记录（否则视为单一价格）。
    var priceMaxVal;
    if (ep.price && ep.price.type === 'price') {
      var _m = convertPrice(firstDeep(it, ep.price.maxKeys || PRICE_MAX_KEYS), ep.price.unit);
      if (_m != null && priceVal != null && _m > priceVal) priceMaxVal = _m;
    }
    var name = firstDeep(it, ep.name || []);
    var img = firstDeep(it, ep.img || []);
    return {
      itemid: String(id), shopid: String(sid),
      month: month, total: total, week: week,
      price: priceVal, priceMax: priceMaxVal, name: name, img: img
    };
  }
  function matchEndpoint(endpoint) {
    if (!endpoint) return null;
    if (SR_SCHEMA.endpoints[endpoint]) return endpoint;
    if (endpoint.indexOf('seller.') >= 0) return 'seller.*';
    if (endpoint.indexOf('/pdp/get_pc') >= 0) return 'pdp/get_pc';
    if (endpoint.indexOf('/pdp/get') >= 0) return 'pdp/get';
    if (endpoint.indexOf('/get_shop_tab') >= 0) return 'get_shop_tab';
    if (endpoint.indexOf('/get_item_cards') >= 0) return 'get_item_cards';
    if (endpoint.indexOf('/rcmd_items') >= 0) return 'rcmd_items';
    if (endpoint.indexOf('/hot_sales') >= 0) return 'hot_sales';
    if (endpoint.indexOf('/search_items') >= 0) return 'search_items';
    if (endpoint.indexOf('/recommend') >= 0) return 'recommend';
    if (endpoint.indexOf('/get_shop_seo') >= 0) return 'get_shop_seo';
    if (endpoint.indexOf('/item/get_rating') >= 0) return 'item/get_rating';
    if (endpoint.indexOf('/item/get') >= 0) return 'item/get';
    return null;
  }

  var api = {
    SR_SCHEMA: SR_SCHEMA,
    PRICE_MAX_KEYS: PRICE_MAX_KEYS,
    deepGet: deepGet,
    findByKeyDeep: findByKeyDeep,
    locateIcs: locateIcs,
    readIcscNum: readIcscNum,
    convertPrice: convertPrice,
    resolveItem: resolveItem,
    matchEndpoint: matchEndpoint,
    coerceIntLocal: coerceIntLocal,
    parseNumLocal: parseNumLocal
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.__SR_SCHEMA__ = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
