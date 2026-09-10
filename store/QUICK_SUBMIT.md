# Chrome Web Store 上架速查（一页纸）

> 完整版见 `SUBMIT_GUIDE.md`。这份是「照着点就行」的精简版。

---

## 前置：材料已备齐 ✅

| 材料 | 文件 |
|---|---|
| 扩展包 | `release/shopee_selector_ext-3.1.6.zip` |
| 图标 128 | `icons/icon128.png` |
| 截图 ×4 | `store/screenshots/*.png`（1280×800） |
| 宣传图 ×2 | `store/promo/marquee_1400x560.png`（1400×560）、`promo_tile_440x280.png`（440×280） |
| 商店文案 | `store/store_listing.md`（复制粘贴） |
| 隐私政策 | `store/privacy_policy.md`（需传成公开链接） |

---

## 第 1 步：注册开发者（一次性 5 美元）

1. 打开 https://chromewebstore.google.com/developer/dashboard
2. Google 账号登录
3. 同意协议 → 付 **5 美元**（Visa / Mastercard / Google Pay）
4. 完成，成为开发者

---

## 第 2 步：上传扩展包

1. 后台 → **「新增项目」**（New Item）
2. 上传 `release/shopee_selector_ext-3.1.6.zip`
3. 等待自动解析 manifest

---

## 第 3 步：填商店列表（Store Listing）

### 基本信息
- **名称**：`虾皮台湾选品录制器`
- **短描述**：`逛 Shopee 台湾时被动录制商品、月销、总销，一键同步到 GitHub 选品库，无需手动复制`
- **类别**：Productivity
- **语言**：中文（简体）

### 详细描述
打开 `store_listing.md`，复制「详细描述」整段粘贴。

### 上传图片
- **图标**：`icons/icon128.png`
- **截图**（按顺序上传 4 张）：
  1. `screenshot_03_website_grid.png`（商品库网格）
  2. `screenshot_04_website_detail.png`（商品详情）
  3. `screenshot_01_popup.png`（扩展弹窗）
  4. `screenshot_02_options.png`（选项页）
- **Marquee 大横幅**：`promo/marquee_1400x560.png`（勾选「参与推荐计划」才会出现这个位置）
- **Promo tile 小竖幅**：`promo/promo_tile_440x280.png`

---

## 第 4 步：填隐私实践（Privacy Practices）★最易被拒★

### 权限用途（照抄）

| 权限 | 用途 |
|---|---|
| `storage` | 本地存储 GitHub Token、录制数据、待同步队列，不上传第三方服务器 |
| `activeTab` | 读取当前标签页 URL 与 DOM 识别商品页，仅在用户点击图标或开启录制时使用 |
| `scripting` | 在 Shopee 页面注入脚本拦截 API 响应，仅限 shopee.tw 域名 |
| `shopee.tw` | 被动监听商品数据，仅当用户访问该域名时生效 |
| `raw.githubusercontent.com` | 从公开 GitHub 仓库读取共享选品库 |
| `api.github.com` | 推送本机录制数据到用户自己的 GitHub 仓库 |

### 数据使用勾选
- ✅ **本地存储**（录制数据、Token）— 仅 chrome.storage.local
- ✅ **网页内容** — 仅 shopee.tw 域名的商品 API 响应
- ⬜ 个人身份信息 / 位置 / 浏览活动 / 通讯录 — 全部不勾

### 隐私政策 URL（二选一）

**方案 A — Gist（最快）**
1. 打开 https://gist.github.com/
2. 粘贴 `store/privacy_policy.md` 内容
3. Create public gist
4. 点 **Raw** 按钮，复制地址栏 URL
5. 填进后台

**方案 B — 放代码仓库**
推送到 GitHub 后，用 `https://raw.githubusercontent.com/23ccf/shopee-ext/main/PRIVACY.md`

### 单一用途声明

> 本扩展唯一用途：被动记录用户在 Shopee 台湾站浏览的商品信息，并自动同步到用户自己的 GitHub 仓库选品库。

---

## 第 5 步：分发设置（Distribution）

- **Visibility**：Public
- **地区**：全球（默认）
- **Pricing**：Free
- **In-app purchases**：无

---

## 第 6 步：提交前自检（13 项）

```
[ ] manifest_version = 3
[ ] version 格式 x.y.z（3.1.6 ✅）
[ ] icons 字段指向真实 PNG
[ ] 每条 host_permission 都有用途说明
[ ] 数据使用问卷如实勾选
[ ] 隐私政策 URL 可访问
[ ] 至少 1 张截图（我们 4 张）
[ ] 名称 ≤ 75 字符
[ ] 短描述 ≤ 132 字符
[ ] 详细描述含功能/人群/步骤/隐私
[ ] 无「最」「第一」「绝对」等违禁词
[ ] 无外部下载链接
[ ] 包内无 .bak / 测试脚本 / 临时文件
```

前 3 项和最后 1 项可以自动检：`python publish.py`

---

## 第 7 步：提交审核

1. 点右上 **「提交审核」**（Submit for Review）
2. 状态变 **Submitted**
3. **首次审核 1~7 个工作日**（通常 2~3 天）
4. 结果邮件通知：
   - 通过 → 自动发布，状态 **Published**
   - 被拒 → 看邮件原因，改完重提（无次数限制）

---

## 被拒常见原因 & 修复

| 拒审原因 | 修复 |
|---|---|
| 权限用途说明不充分 | 按第 4 步表格逐条补全 |
| 缺隐私政策 URL | 建 Gist 填入 |
| 单用途描述不清 | 用第 4 步那句话 |
| 描述有夸大词 | 删「最」「第一」「绝对」 |
| manifest 字段错 | 改完 `python pack.py` 重传 |

---

## 以后更新版本

1. 改 `manifest.json` 的 `version`（必须递增）
2. `python pack.py` 重新打包
3. `python publish.py` 自检
4. 后台 → Package → 上传新 zip
5. Submit for Review（更新审核通常 24h~3 天，比首发快）

---

**祝一次通过！** 🚀