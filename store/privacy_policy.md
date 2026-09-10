# 隐私政策 / Privacy Policy

最后更新：2026-09-09

## 中文

「虾皮台湾选品录制器」（下称「本扩展」）尊重并保护你的隐私。

### 我们收集什么

- 本扩展**只在你主动浏览虾皮台湾（shopee.tw）页面时**，采集页面上公开可见的商品信息：商品名称、价格、销量（月销/总销/周销）、评分、评价数、图片链接、店铺信息等。
- 这些数据属于「你正在浏览的商品公开信息」，不含你的个人隐私。

### 我们不收集什么

- 不采集你的虾皮账号、密码、Cookie、支付信息、收货地址等任何个人敏感信息。
- 不上传、不传输任何数据到我们（开发者）的服务器。

### 数据存在哪里、去哪

- 采集到的商品数据，只会写入**你本人配置**的数据源：
  - 你的 GitHub 仓库（需要你提供 GitHub Token），或
  - 你自己部署的后端服务（需要你提供后端地址和账号）。
- 数据去向完全由你的配置决定，本扩展不会把数据发给任何第三方。

### 权限用途说明

| 权限 | 用途 |
|---|---|
| `storage` | 保存你的配置（Token、开关状态） |
| `alarms` | 定时同步 |
| `activeTab` / `tabs` / `scripting` | 在虾皮页面采集数据 |
| `declarativeNetRequest` | 为商品图片请求设置防盗链规则，正常显示图片 |
| 访问 `shopee.tw`、GitHub、Gitee、你的后端 | 采集 + 同步数据 |

### 联系我们

如需删除数据或咨询隐私问题，请通过你获取本扩展的渠道联系开发者。

---

## English

Last updated: 2026-09-09

"Shopee TW Product Recorder" (the "Extension") respects and protects your privacy.

### What we collect

- The Extension collects publicly-visible product information **only while you actively browse Shopee Taiwan (shopee.tw)**: product name, price, sales (monthly / total / weekly), rating, review count, image URLs, shop info, etc.
- This data is public product information from pages you are browsing, and contains no personal privacy data.

### What we do NOT collect

- We do not collect your Shopee account, password, cookies, payment info, shipping address, or any personal sensitive data.
- We do not upload or transmit any data to the developer's servers.

### Where the data is stored / goes

- Captured product data is written **only to the data source you configure yourself**:
  - your GitHub repository (requires your GitHub Token), or
  - your self-hosted backend (requires your backend URL and account).
- The data destination is entirely determined by your configuration; the Extension never sends data to any third party.

### Permission usage

| Permission | Purpose |
|---|---|
| `storage` | Save your settings (token, toggle state) |
| `alarms` | Scheduled sync |
| `activeTab` / `tabs` / `scripting` | Capture data on Shopee pages |
| `declarativeNetRequest` | Set image referrer rules so product images load correctly |
| Access to `shopee.tw`, GitHub, Gitee, your backend | Capture + sync data |

### Contact

To delete data or ask about privacy, contact the developer through the channel where you obtained this Extension.
