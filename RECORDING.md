# 录制器采集逻辑说明（技术参考）

本文档面向维护者，说明扩展如何采集、解析、过滤并同步虾皮台湾商品数据。数据口径经过多轮线上校验，**请勿随意改动**，改动前先跑 `shopee_verify/` 下的回归脚本。

---

## 1. 数据来源

数据只来自两处（硬规则，不可变）：
1. **跨境卫士浏览器被动录制**：用户在能访问 `shopee.tw` 的浏览器里正常浏览，扩展自动采集（`content.js` / `inject.js`）。
2. **用户授权导出的知虾数据**。

**禁令**：不得爬知虾付费 SaaS；沙箱网络封 `shopee.tw`，录制器必须在用户能联网的 Windows 机器运行。

---

## 2. 采集架构

| 文件 | 运行世界 | 作用 |
|---|---|---|
| `inject.js` | MAIN | 偷听页面 `/api/v4/item/get` 等接口响应，借真实身份兜底重发 |
| `sales_schema.js` | MAIN/ISOLATED | `S.resolveItem` / `S.locateIcs` 统一解析月/总/周销 |
| `content.js` | ISOLATED | 从 DOM + 接口提取商品字段，交给 background |
| `background.js` | Service Worker | 合并 pending、过滤、定时同步到 GitHub |

---

## 3. 销量字段口径（最高优先级）

### 月销（month）—— 权威来源
- **详情接口 `item/get` 的 `item.sold`** + 详情页 DOM 文案「月銷 X / 近30天 X」。
- 周销 = `round(月销 / 4.345)`。

### 总销（sold_total / historical_sold）
- 列表/搜索/店铺接口的 `item.sold` = **累计总销量（不是月销）**。
- DOM「已售出 X」= 累计总销（`historical_sold`），**绝不当月销**。
- `pdp/get_pc` / `pdp/get` 的 `sold` = 累计总销，不当权威月销。

### 金矿接口（最干净的月销源）
- `/api/v4/pdp/hot_sales/get_item_cards`：每卡片 `item_data.item_card_display_sold_count.monthly_sold_count` 是月销；价格 `item_card_display_price.price` 实测 ×100000（`content.js` 已 ÷100000）。
- `item_card_display_sold_count` 嵌套在 `it.item_data` 下，必须深度查找（`findIcs`/`locateIcs`），**绝不只读顶层**。

### 月销=0 的语义
- 虾皮台站隐藏月销且 `item/get` 被 403 时，**月销=0 表示「未知」而非「真 0」**；此时总销（DOM「已售出」）是唯一可靠指标，据其入库，**绝不丢弃**。

---

## 4. 价格单位换算表（勿回退）

| 数据源 | 单位 | 换算 |
|---|---|---|
| `item/get`、`pdp/get`、`pdp/get_pc`、`get_rating`、`get_item_cards` | 原币 ×100000 | ÷100000 取整 |
| `get_shop_tab`、`rcmd_items`、`hot_sales`、`search_items`、`recommend`、`get_shop_seo` | 分 ×100 | ÷100 取整 |
| `seller.shopee.tw` | 已是元 | 原值取整 |

`background.js` 的 `sanePrice()` 对 ≥1000 的价格自动 ÷10 双保险。改动后务必跑 `node --check` + `test/parse.test.js`。

---

## 5. 入库过滤规则

- **只入库「月销 > 0 或 总销 > 0」的商品**（销量为 0 的无效/占位商品丢弃）。
- **today-only 过滤字段永远用 `last_seen`，绝不用 `first_seen`**。
- slug 店铺 URL 必须被识别，否则店铺页误判为「浏览」、shopid 取不到 → 整批丢弃。

---

## 6. 时间戳单位铁律

- **全链路统一「秒」**（`doSync` 写 `Math.floor(Date.now()/1000)`）。
- 网站读取一律先过 `normTs()`（`>1e11` 视为毫秒 → ÷1000 折算秒）再比较。
- 删除写入严格递增：`ts = Math.max(normTs(旧catalog_ts)+1, 秒)`。

> 历史血案：删除逻辑误写 `Date.now()`（毫秒），导致「删除前的陈旧 CDN 副本」通过校验被当最新 → 已删商品刷新复活；同时秒级新数据被永久拒收，网站卡死在旧快照。故秒级 + normTs 归一化是底线。

---

## 7. 同步流程

1. 用户浏览 → 商品进 `pending`（内存 + `chrome.storage.local`）。
2. `doSync` 合并 pending 与 GitHub 现有 catalog，过滤后推 GitHub（Git Data API，支持 >1MB）。
3. **`doSync` 只推 pending，不重写历史**：源删除持久，重新录制会再合并回来。

### 并发互斥（铁律）
- `doSync` 有三个触发源（弹窗手动 / `setInterval` 20s / `chrome.alarms` 15s），**必须全部经过 `doSyncShared()` 互斥锁**，否则并发推送撞 Git ref 冲突（422 not a fast forward）。
- `/git/trees/{branch}` 在 catalog 与 deleted.json 之间**共用**（`fetchTreeCached`，20s TTL + in-flight 去重）。

---

## 8. 删除语义（最高优先级，三端必须一致）

**删除是最终决定，任何「重新录制即恢复」的后门都会导致商品复活。** 已删商品在以下每一处都必须**无条件**剔除，绝不再比较 `last_seen` 与删除时间的先后：

- 扩展**录制入口** `handleProducts()`（已删商品不许进 pending）
- 扩展**同步合并** `doSync()`（无条件剔除）
- 扩展**同步成功后**从 pending 清掉删除名单里的 key
- 网站 `applyCatalog` 的 `srvDel` 分支（无条件 `return false`）
- 网站 `pruneDelSet`（服务端删除名单里仍有的 id 一律不解除本机屏蔽）

**恢复路径只有一条**：网站「清空本地删除记录」→ 清空 `deleted.json` → 标记消失 → 商品可重新录入。

---

## 9. 回归验证

改完任何采集/同步/删除逻辑，必跑 `C:/Users/1/shopee_verify/` 下的脚本（见项目长期记忆中的「测试脚本」表），尤其：
- `__sim.js`（删除/复活/时间戳，5 场景）
- `__perf.js`（渲染指纹 + 缩略图，30 项）
- `__latency.js`（流畅性基准，24 项，全部 < 1 秒）
- `__ext_del.js` / `__e2e_del.js`（扩展删除不复活 + 全链路，用线上真实数据）
