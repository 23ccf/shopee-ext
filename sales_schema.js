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
        name: ['name', 'title'], img: IMG_PATHS
      },
      'item/get_rating': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        month: [k('sold'), k('monthly_sold'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('total_sold'), icsc('total')],
        price: price(['price', 'price_min'], 100000), name: ['name', 'title'], img: IMG_PATHS
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
        img: IMG_PATHS,  // ★ 2026-09-19：含 images（静态主图），排除视频封面（见 pickImg）
        // 价格：列表/店铺接口 price/price_min 为「分」(×100)，实测原始值即分（如 ¥77 商品原始值=7700）。
        // ★ 2026-09-18：strategy:'min' —— price 字段可能是「划线原价」（实测森馬洞洞鞋
        //   price=199700 分 → NT$1,997，而实卖折后价在 item_card_display_price.price=199.7），
        //   蝦皮卡片展示价 = 各候选来源换算后的【最小值】（展示价本身也取最低规格），
        //   对「主键是原价」「主键缺失」「无折价」三种情况都稳健；price_max 跟随胜出来源的 unit。
        price: price(['price', 'price_min'], 100, { keys: ['item_data.item_card_display_price.price'], unit: 100000, strategy: 'min' })
      },
      'get_item_cards': {
        itemWrap: 'item_data',
        id: ['itemid', 'item_id', 'item_data.itemid'],
        shopid: ['shopid', 'shop_id', 'item_data.shopid'],
        month: [icsc('month')],
        total: [icsc('total')],
        name: ['name', 'title'],
        img: IMG_PATHS,  // ★ 2026-09-19：含 images（静态主图），排除视频封面（见 pickImg）
        // 金矿接口：item_data.item_card_display_price.price 实测 ×100000
        price: price(['item_data.item_card_display_price.price'], 100000)
      },
      'rcmd_items': {
        itemWrap: 'item_data', id: ['itemid', 'item_id', 'item_data.itemid'],
        shopid: ['shopid', 'shop_id', 'item_data.shopid'],
        month: [icsc('month')], total: [icsc('total')],
        // ★ 2026-09-17：补 name/img（此前未定义 → 店铺页商品缺名称缺图，网站显示「未采集到名称」）
        name: ['name', 'title'],
        img: IMG_PATHS,  // ★ 2026-09-19：含 images（静态主图），排除视频封面（见 pickImg）
        // ★ 2026-09-19c：补 item_card_display_price 的 alt（×100000）——新版卡片把实卖价放在这，
        //   顶层 price 缺失时 price=undefined → 网站「价格未采集」（线上实测 rcmd/hot 卡整批无价）。
        //   strategy:'min' 与 get_shop_tab 同源：取各候选最小值=展示价。
        price: price(['price', 'price_min'], 100, { keys: ['item_data.item_card_display_price.price'], unit: 100000, strategy: 'min' })
      },
      'hot_sales': {
        itemWrap: 'item_data', id: ['itemid', 'item_id', 'item_data.itemid'],
        shopid: ['shopid', 'shop_id', 'item_data.shopid'],
        month: [icsc('month')], total: [icsc('total')],
        // ★ 2026-09-17：补 name/img（同 rcmd_items）
        name: ['name', 'title'],
        img: IMG_PATHS,  // ★ 2026-09-19：含 images（静态主图），排除视频封面（见 pickImg）
        price: price(['price', 'price_min'], 100, { keys: ['item_data.item_card_display_price.price'], unit: 100000, strategy: 'min' })
      },
      'search_items': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        // 列表 item_basic.sold = 近30天月销（recorder.py 已验证）
        month: [k('sold'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('total_sold'), k('sold')],
        price: price(['price', 'price_min'], 100, { keys: ['item_data.item_card_display_price.price'], unit: 100000, strategy: 'min' }),
        // ★ 2026-09-19：补 name/img（此前未定义 → 这两类端点进来的商品「未采集到名称」且无主图）
        name: ['name', 'title'], img: IMG_PATHS
      },
      'recommend': {
        id: ['itemid', 'item_id'], shopid: ['shopid', 'shop_id'],
        month: [k('sold'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('total_sold'), k('sold')],
        price: price(['price', 'price_min'], 100, { keys: ['item_data.item_card_display_price.price'], unit: 100000, strategy: 'min' }),
        name: ['name', 'title'], img: IMG_PATHS
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
        // ★ 2026-09-18：与 get_shop_tab 同构 —— 卡片包在 item_data 下，
        //   不加 itemWrap 则 id/name/price/image 全部取不到（深搜也救不了 id 缺失直接丢弃）
        itemWrap: 'item_data',
        id: ['itemid', 'item_id', 'item_data.itemid'], shopid: ['shopid', 'shop_id', 'item_data.shopid'],
        month: [k('sold'), icsc('month')],
        total: [k('historical_sold'), k('sold_total'), k('sold')],
        // ★ 2026-09-17：补 name/img（同 rcmd_items）
        name: ['name', 'title'],
        img: IMG_PATHS,  // ★ 2026-09-19：含 images（静态主图），排除视频封面（见 pickImg）
        price: price(['price', 'price_min'], 100)
      }
    }
  };

  // ---- 通用工具 ----
  function k(key) { return { type: 'key', k: key }; }
  function icsc(which) { return { type: 'icsc', which: which }; }
  function dom(re) { return { type: 'dom', re: re }; }
  function price(keys, unit, alt) { return { type: 'price', keys: keys, unit: unit, alt: alt || null, strategy: (alt && alt.strategy) || null }; }
  // 价格区间上限（2026-09-10 新增）：虾皮对「多规格」商品用 price_max 表示最高价。
  // 换算单位与 price 共用同一 unit，避免「下限除过、上限没除」的错位。
  var PRICE_MAX_KEYS = ['price_max', 'item_data.item_card_display_price.price_max'];

  // ★ 2026-09-19【问题1 主图采集错误】：虾皮「视频商品」在列表/店铺卡片接口里返回的主图字段
  //   其实是【视频封面】—— URL 以 _cover 结尾（实测 tw-xxx_cover 返回 200、去掉后缀则 404）。
  //   直接当主图会让网站显示成「视频首页」（线上 48 件里 12 件、历史 1023 件里 59 件命中）。
  //   解法：候选池按「非 _cover 优先」挑选（静态主图常在 images / image_info 里）；
  //   若全是封面则退回第一张（有图胜过无图），并置 imgIsCover=true 交上游触发详情页精修覆盖。
  var VIDEO_COVER_RE = /_cover(?:@|[?]|$)/i;
  function isVideoCover(u) {
    return u != null && u !== '' && VIDEO_COVER_RE.test(String(u));
  }
  // 统一图片候选路径。★ 去掉 thumb_url：它就是视频缩略图字段，是「视频首页」的来源之一。
  var IMG_PATHS = ['images', 'image', 'image_info.image_url', 'image_url'];
  function pickImg(it, paths) {
    var cands = [];
    function push(v) {
      if (v == null) return;
      if (Array.isArray(v)) { for (var n = 0; n < v.length && n < 8; n++) push(v[n]); return; }
      if (typeof v !== 'string') return;
      var t = v.trim();
      if (t && cands.indexOf(t) < 0) cands.push(t);
    }
    var ps = paths || [];
    for (var i = 0; i < ps.length; i++) push(deepGet(it, ps[i]));
    if (!cands.length) return null;
    for (var j = 0; j < cands.length; j++) { if (!isVideoCover(cands[j])) return cands[j]; }
    return cands[0];
  }
  // 深搜版挑图：主路径取不到（或只取到视频封面）时用。
  // 与 findTextDeep 同口径排除 shop/brand/items 容器（防店铺 logo 冒充商品主图），
  // 但额外支持 images 数组，并且【优先返回非视频封面】的那一张。
  function pickImgDeep(it, keys) {
    var found = [];
    function walk(obj, depth) {
      if (depth > 6 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { for (var i = 0; i < obj.length && i < 8; i++) walk(obj[i], depth); return; }
      for (var kk in obj) {
        if (!obj.hasOwnProperty(kk)) continue;
        if (TEXT_SKIP.indexOf(kk) >= 0) continue;
        if (keys.indexOf(kk) >= 0) {
          var v = obj[kk];
          if (Array.isArray(v)) {
            for (var n = 0; n < v.length && n < 4; n++) {
              if (typeof v[n] === 'string' && v[n] && found.indexOf(v[n]) < 0) found.push(v[n]);
            }
          } else if (typeof v === 'string' && v.length > 0 && v.length <= 400 && found.indexOf(v) < 0) {
            found.push(v);
          }
        }
      }
      for (var k2 in obj) {
        if (!obj.hasOwnProperty(k2)) continue;
        if (TEXT_SKIP.indexOf(k2) >= 0) continue;
        var v2 = obj[k2];
        if (v2 && typeof v2 === 'object') walk(v2, depth + 1);
      }
    }
    walk(it, 0);
    if (!found.length) return null;
    for (var j = 0; j < found.length; j++) { if (!isVideoCover(found[j])) return found[j]; }
    return found[0];
  }

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
  // ★ 2026-09-18：name/img 深搜兜底。部分店铺卡（广告卡/新结构）把 name/image 藏在
  //   非标准容器里，主路径 firstDeep(精确点分) 落空 → 整批「未采集到名称」。
  //   排除 SKIP（变体/营销）与 shop/seller/brand 系容器，防止店铺名/品牌名冒充商品名；
  //   只收 1~300 字符的字符串值。仅作兜底，主路径命中即不走这里。
  var TEXT_SKIP = SKIP.concat(['shop', 'shop_info', 'shop_detailed', 'seller',
                               'seller_info', 'brand', 'shop_rating', 'items', 'item_cards']);
  function findTextDeep(obj, keys, depth) {
    if (depth == null) depth = 0;
    if (depth > 6 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        var r0 = findTextDeep(obj[i], keys, depth);
        if (r0 != null) return r0;
      }
      return null;
    }
    for (var kk in obj) {
      if (!obj.hasOwnProperty(kk)) continue;
      if (TEXT_SKIP.indexOf(kk) >= 0) continue;
      if (keys.indexOf(kk) >= 0) {
        var v0 = obj[kk];
        if (typeof v0 === 'string' && v0.length > 0 && v0.length <= 300) return v0;
      }
    }
    for (var k3 in obj) {
      if (!obj.hasOwnProperty(k3)) continue;
      if (TEXT_SKIP.indexOf(k3) >= 0) continue;
      var v3 = obj[k3];
      if (v3 && typeof v3 === 'object') {
        var r3 = findTextDeep(v3, keys, depth + 1);
        if (r3 != null) return r3;
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
    // ★ 2026-09-18：保留 2 位小数。蝦皮卖家真实挂价可带小数（实测 179.41 / 199.7），
    //   一律取整会失真；只归整换算浮点噪声（198.99999 -> 199）。
    return Math.round(n / unit * 100) / 100;
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

  // ★ 2026-09-19：规格词不是商品名 —— 变体名（款式/顏色/尺寸…）会被主路径或深搜兜底
  //   当成 name 下发，卡片显示成「款式」且无价格（线上实测 12 件）。一律视为缺失。
  var SPEC_NAME_RE = /^(款式|顏色|颜色|尺寸|規格|规格|型號|型号|選項|选项|分類|分类|類別|类别)$/;
  function isSpecName(s) {
    if (s == null) return true;
    var t = String(s).replace(/\s+/g, '');
    if (!t) return true;
    return SPEC_NAME_RE.test(t);
  }
  // ★ 2026-09-19：price_max 单位错位防线 —— max 必须与 price 同量纲。
  //   老端点(unit=100)遇到新版嵌套 ×100000 的 max 值会放大 1000 倍（实测 189 → 355000，
  //   真值 3550）。规则：max ≥ price×50 即视为错位，÷100/÷1000 落回 (price, price×50) 才收，否则丢弃。
  function saneMax(mv, pv) {
    if (mv == null || pv == null || !(pv > 0) || !isFinite(mv)) return null;
    if (mv > pv && mv < pv * 50) return mv;
    for (var d = 100; d <= 1000; d *= 10) {
      var c = Math.round(mv / d * 100) / 100;
      if (c > pv && c < pv * 50) return c;
    }
    return null;
  }
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
    var priceVal, priceMaxVal;
    if (ep.price && ep.price.type === 'price') {
      if (ep.price.strategy === 'min') {
        // ★ 2026-09-18：候选制取最小 = 卡片展示价；price_max 取「胜出来源」同源的 max 键、
        //   用该来源自己的 unit 换算（避免 price_max 用 ×100 去解 ×100000 的 display 价导致 1000 倍错位）。
        var _cands = [];
        (ep.price.keys || []).forEach(function (k) {
          var v = convertPrice(firstDeep(it, [k]), ep.price.unit);
          if (v != null) _cands.push({ v: v, u: ep.price.unit, mr: firstDeep(it, ['price_max']) });
        });
        if (ep.price.alt) (ep.price.alt.keys || []).forEach(function (k) {
          var v = convertPrice(firstDeep(it, [k]), ep.price.alt.unit);
          if (v != null) _cands.push({ v: v, u: ep.price.alt.unit,
            mr: firstDeep(it, [String(k).replace(/\.price$/, '.price_max')]) });
        });
    if (_cands.length) {
          var _win = _cands.reduce(function (a, b) { return b.v < a.v ? b : a; });
          priceVal = _win.v;
          var _mv = saneMax(convertPrice(_win.mr, _win.u), priceVal);
          if (_mv != null) priceMaxVal = _mv;
        }
      } else {
        // 主键首个命中；缺失时按 alt 键组回退（不同键可能量纲不同，须按各自 unit 换算）
        priceVal = convertPrice(firstDeep(it, ep.price.keys), ep.price.unit);
        if (priceVal == null && ep.price.alt) {
          var _alt = convertPrice(firstDeep(it, ep.price.alt.keys), ep.price.alt.unit);
          if (_alt != null) priceVal = _alt;
        }
        // ★ 价格区间上限：仅当商品确有 price_max 且严格高于现价时才记录（否则视为单一价格）。
        //   2026-09-19：过 saneMax 单位错位防线（详见函数注释）。
        var _m = saneMax(convertPrice(firstDeep(it, ep.price.maxKeys || PRICE_MAX_KEYS), ep.price.unit), priceVal);
        if (_m != null) priceMaxVal = _m;
      }
    }
    // ★ 2026-09-17：ctime = 商品上架时间（unix 秒，全端点语义一致）。缺失 = null（三态）。
    // ★ 2026-09-24 修复：虾皮 item/get / 店铺接口真实字段名是 create_time（非 ctime），
    //   旧代码只读 ctime 导致 listed_at 永远抓不到。这里把 create_time 放首位，ctime 仅作旧结构兜底。
    var ctime = coerceIntLocal(firstDeep(it, ['create_time', 'ctime', 'item_data.create_time', 'item_data.ctime']));
    var name = firstDeep(it, ep.name || []);
    // ★ 2026-09-18：主路径缺失时深搜兜底（findTextDeep，排除 shop/brand 容器）
    if (name == null) name = findTextDeep(it, ['name', 'title']);
    // ★ 2026-09-19：规格词（款式/顏色/尺寸…）不是商品名，视为缺失（宁可留空走体检条重录）
    if (isSpecName(name)) name = null;
    // ★ 2026-09-19：走 pickImg（非视频封面优先）；主路径落空、或只拿到视频封面时，
    //   再走深搜兜底换真图（深搜同样排除 thumb_url 与 shop/brand 容器）。
    var img = pickImg(it, ep.img || []);
    if (img == null || isVideoCover(img)) {
      var _deepImg = pickImgDeep(it, ['images', 'image', 'image_url']);
      if (_deepImg && (!isVideoCover(_deepImg) || img == null)) img = _deepImg;
    }
    return {
      itemid: String(id), shopid: String(sid),
      month: month, total: total, week: week,
      price: priceVal,
      // ★ tri-state 约定：无区间 = null（不是 undefined），与 month/total 同口径，下游 === null 判断可靠
      priceMax: (priceMaxVal == null ? null : priceMaxVal), name: name, img: img,
      imgIsCover: isVideoCover(img),   // ★ 上游据此触发详情页精修，用真主图覆盖
      ctime: (ctime != null && ctime > 0) ? ctime : null
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
    parseNumLocal: parseNumLocal,
    isVideoCover: isVideoCover,
    pickImg: pickImg,
    pickImgDeep: pickImgDeep,
    IMG_PATHS: IMG_PATHS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.__SR_SCHEMA__ = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
