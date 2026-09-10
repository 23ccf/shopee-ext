# 隐私政策 / Privacy Policy

最后更新 / Last updated：2026-09-10

---

## 中文

「虾皮台湾选品录制器」（下称「本扩展」）尊重并保护你的隐私。

### 我们收集什么

- 本扩展**只在你主动浏览虾皮台湾（shopee.tw）页面时**，采集页面上公开可见的商品信息：商品名称、价格、销量（月销/总销/周销）、评分、评价数、图片链接、店铺信息等。
- 这些数据属于「你正在浏览的商品公开信息」，不含你的个人隐私。

### 我们不收集什么

- 不采集你的虾皮账号、密码、Cookie、支付信息、收货地址等任何个人敏感信息。
- 不上传、不传输任何数据到我们（开发者）的服务器。
- 不追踪你的跨站浏览活动。

### 数据存在哪里、去哪

- 采集到的商品数据，只会写入**你本人配置**的数据源：
  - 你的 GitHub 仓库（需要你提供 GitHub Token），或
  - 你自己部署的后端服务（需要你提供后端地址和账号）。
- 数据去向完全由你的配置决定，本扩展不会把数据发给任何第三方。
- 你的 GitHub Token 仅保存在你本机浏览器的 `chrome.storage.local` 中，不会上传。

### 数据保留与删除

- 录制数据一直保存在你本机，直到成功同步到你配置的数据源。
- 你可以随时在扩展选项页「清空本地数据」，或在你的 GitHub 仓库中直接删除数据文件。
- 卸载扩展会自动清除本机所有存储数据。

### 权限用途说明

| 权限 | 用途 |
|---|---|
| `storage` | 保存你的配置（Token、开关状态）及待同步的录制数据 |
| `alarms` | 定时触发同步 |
| `activeTab` / `tabs` / `scripting` | 在虾皮页面采集商品数据 |
| `declarativeNetRequest` | 为商品图片请求设置防盗链规则，使图片正常显示 |
| 访问 `shopee.tw` | 采集商品数据（仅该域名） |
| 访问 GitHub / Gitee / 你的后端 | 同步数据到你配置的数据源 |

### 儿童隐私

本扩展不面向 13 岁以下儿童，也不会有意收集儿童个人信息。

### 政策变更

如本政策有重大变更，会在 GitHub 仓库更新本文件并修改「最后更新」日期。

### 联系我们

- GitHub Issues：https://github.com/23ccf/shopee-ext/issues
- 如需删除数据或咨询隐私问题，请通过上述渠道联系开发者。

---

## English

"Shopee TW Product Recorder" (the "Extension") respects and protects your privacy.

### What we collect

- The Extension collects publicly-visible product information **only while you actively browse Shopee Taiwan (shopee.tw)**: product name, price, sales (monthly / total / weekly), rating, review count, image URLs, shop info, etc.
- This data is public product information from pages you are browsing, and contains no personal privacy data.

### What we do NOT collect

- We do not collect your Shopee account, password, cookies, payment info, shipping address, or any personal sensitive data.
- We do not upload or transmit any data to the developer's servers.
- We do not track your cross-site browsing activity.

### Where the data is stored / goes

- Captured product data is written **only to the data source you configure yourself**:
  - your GitHub repository (requires your GitHub Token), or
  - your self-hosted backend (requires your backend URL and account).
- The data destination is entirely determined by your configuration; the Extension never sends data to any third party.
- Your GitHub Token is stored only in your browser's local `chrome.storage.local` and is never uploaded.

### Data retention & deletion

- Recorded data stays on your device until it is successfully synced to your configured data source.
- You can clear local data anytime in the Extension options page, or delete the data files directly in your GitHub repository.
- Uninstalling the Extension removes all locally stored data.

### Permission usage

| Permission | Purpose |
|---|---|
| `storage` | Save your settings (token, toggle state) and pending recorded data |
| `alarms` | Trigger scheduled sync |
| `activeTab` / `tabs` / `scripting` | Capture product data on Shopee pages |
| `declarativeNetRequest` | Set image referrer rules so product images load correctly |
| Access to `shopee.tw` | Capture product data (this domain only) |
| Access to GitHub / Gitee / your backend | Sync data to your configured destination |

### Children's privacy

This Extension is not directed to children under 13, and we do not knowingly collect personal information from children.

### Changes to this policy

If we make material changes, we will update this file in the GitHub repository and revise the "Last updated" date.

### Contact

- GitHub Issues: https://github.com/23ccf/shopee-ext/issues
- To delete data or ask about privacy, contact the developer through the channel above.
