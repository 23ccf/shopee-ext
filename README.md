# 虾皮台湾选品录制器（浏览器扩展）

Shopee Taiwan Product Recorder (Browser Extension)

在跨境卫士等 Chromium 浏览器中，开启即自动录制虾皮台湾买家端浏览到的商品，并同步到选品网站。

A Chromium browser extension that auto-records Shopee Taiwan product data as you browse, and syncs it to the product-selection dashboard.

---

## 功能 / Features

- **自动录制 / Auto-record**：浏览虾皮商品页、店铺页、搜索/列表页时，自动抓取商品信息（名称、价格、月销、总销、周销、评分、图片等）。
- **同步到网站 / Sync**：定时把录制到的商品推送到选品网站（默认走 GitHub，见下）。
- **删除同步 / Delete-sync**：网站删除商品后，录制器不会再重新录入已删商品。

---

## 安装 / Installation

1. 打开 Chromium 浏览器 → `chrome://extensions`。
2. 右上角开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本目录（`shopee_ext/`）。

> 本扩展不依赖 Chrome 商店，加载目录即可用。

---

## 配置 / Configuration

打开扩展的「选项」页（Options）：

| 项 | 是否必填 | 说明 |
|---|---|---|
| GitHub Token | **必填** | 需要 `Contents: Read and write` 权限的 PAT，用于把商品写到 GitHub 仓库。 |
| 自建后端 | 可选 | 默认**关闭**。只有当你部署了自己的后端（见 `shopee_backend`）并想用账号登录时才开启。 |

### ⚠ 重要：跨境卫士用户请勿启用「自建后端」

跨境卫士浏览器内置了访问台湾虾皮的代理通道，该通道**只对虾皮相关域名做了处理**。如果你让扩展去请求自建后端（如 `workbuddy.link` 或你自己的域名），请求会**永久挂起**，表现为「同步一直转圈 / 浏览器卡顿」。

- **跨境卫士用户**：保持默认（GitHub 模式），不要勾选「自建后端」。
- **普通浏览器用户**（能直连后端域名者）：可自行部署后端后启用。

---

## 使用流程 / Workflow

1. 填好 GitHub Token（或配置自建后端）。
2. 打开扩展，开启录制开关。
3. 正常浏览虾皮台湾商品 → 商品自动进待同步队列。
4. 扩展自动推送到 GitHub（默认）→ 网站「立即同步」即可看到新商品。

---

## 与其它组件的关系 / Relationship

| 组件 | 作用 | 是否必需 |
|---|---|---|
| 本扩展 | 采集 + 同步 | 是 |
| 选品网站（`shopee_deploy`） | 展示 / 搜索 / 删除 | 是 |
| 自建后端（`shopee_backend`） | 账号 + 数据库（替代 GitHub） | 否（默认不用） |

**默认链路**：扩展 → GitHub → 网站（无需后端）。

---

## 目录说明 / Files

| 文件 | 作用 |
|---|---|
| `background.js` | Service Worker：接收商品、合并、定时同步 |
| `content.js` / `inject.js` | 页面采集（ISOLATED / MAIN world） |
| `sales_schema.js` | 销量字段解析（月销/总销/周销统一口径） |
| `bridge.js` / `bridge_main.js` | 与网站的桥接（删除记录同步） |
| `options.js` / `popup.js` | 选项页 / 弹窗 UI |
