# Chrome Web Store 上架操作手册

本手册带你从注册开发者账号到上架审核通过的全流程。所有材料已备齐（在 `store/` 目录下），你只要在 Chrome Web Store 后台按步骤上传即可。

预计耗时：账号注册 30 分钟（含 5 美元一次性注册费），提交审核 1 周。

---

## 第 1 步：注册开发者账号

1. 打开 https://chromewebstore.google.com/developer/dashboard
2. 用你的 Google 账号登录（建议用个人 Gmail，别用公司邮箱）
3. 同意开发者协议
4. **支付 5 美元一次性注册费**（用 Visa/Mastercard/Google Pay 均可）
5. 注册成功后成为「Chrome Web Store Developer」，可以无限提交扩展

> 提示：账号注册只需 5 美元，无年费。

---

## 第 2 步：上传扩展包

1. 在开发者后台点 **「新增项目」**（New Item）
2. 上传 `shopee_ext/publish.py` 生成的发布包 zip（约 90KB）
3. 后台会自动解析 manifest.json，验证基本字段

**常见错误**：
- ❌ `manifest_version` 必须是 3
- ❌ `version` 必须是 `1.0.0` 格式（数字+点号+数字+点号+数字，1~4 位）
- ❌ 压缩包内不能有 `__MACOSX` 等 macOS 残留目录
- ❌ 文件名不能含中文（manifest 引用资源必须 ASCII 或纯 UTF-8）

---

## 第 3 步：填写商店列表（Store Listing Tab）

### 3.1 基础信息

| 字段 | 填什么 | 来源文件 |
|---|---|---|
| **名称（Title）** | `虾皮台湾选品录制器` | `store_listing.md` 第 1 节 |
| **短描述（Summary）** | `逛 Shopee 台湾时被动录制商品、月销、总销，一键同步到 GitHub 选品库，无需手动复制` | `store_listing.md` 第 2 节（≤ 132 字符） |
| **类别（Category）** | Productivity（生产力） | — |
| **语言（Language）** | 中文（简体） | — |

### 3.2 详细描述（Description）

直接把 `store_listing.md` 第 3 节「详细描述」全文粘贴进后台。中文与英文版本分别上传两次，对应不同语言选项。

### 3.3 图标（Icon）

| 尺寸 | 用途 | 文件 |
|---|---|---|
| **128×128** | 商店列表展示 | `icons/icon128.png` |

> 后台只要求 128×128，小尺寸（16/32/48）会从 manifest 自动读取。

### 3.4 截图（Screenshots）

**至少上传 1 张，建议 4 张**（后台限制最多 5 张）。顺序按重要性排：

1. `screenshots/screenshot_03_website_grid.png` — 选品网站商品库（最直观展示功能价值）
2. `screenshots/screenshot_04_website_detail.png` — 商品详情（字段齐全）
3. `screenshots/screenshot_01_popup.png` — 扩展弹窗（录制开关）
4. `screenshots/screenshot_02_options.png` — 选项页（GitHub Token）

尺寸全部已严格 1280×800。

### 3.5 宣传图（可选但强烈建议）

| 类型 | 尺寸 | 文件 |
|---|---|---|
| **Promotional tile（小竖幅）** | 440×280 | `promo/promo_tile_440x280.png` |
| **Marquee（大横幅）** | 1400×560 | `promo/marquee_1400x560.png` |

> 后台会问「是否参与 Chrome Web Store 推荐计划」——勾选 **是**，宣传图才会出现在商店首页。审核会稍严但不会因为这个被拒。

---

## 第 4 步：填写隐私实践（Privacy Practices Tab）

这是**最常被拒的环节**，务必仔细。

### 4.1 权限用途说明

扩展用到的所有权限都在 manifest.json 里。后台会让你**逐个写用途**：

| 权限 | 用途说明（直接复制） |
|---|---|
| `storage` | 在用户浏览器本地存储 GitHub Token、录制数据、未同步队列，不会上传到任何第三方服务器 |
| `activeTab` | 读取当前活动标签页的 URL 与 DOM 用于识别商品页，仅在用户点击扩展图标或自动录制开启时使用 |
| `scripting` | 在 Shopee 页面注入内容脚本以拦截 API 响应，仅限 shopee.tw / seller.shopee.tw 域名 |
| `host_permissions: shopee.tw` | 在 Shopee 台湾站点被动监听商品数据，仅当用户访问该域名时生效 |
| `host_permissions: raw.githubusercontent.com` | 从公开 GitHub 仓库读取共享 catalog（选品库）数据 |
| `host_permissions: api.github.com` | 调用 GitHub API 推送用户本机的录制数据到用户自己的 GitHub 仓库 |
| `host_permissions: gitee.com`（可选）| 调用 Gitee API 推送数据备份（中国大陆加速用） |

### 4.2 数据使用

后台会问「你收集/使用/传输哪些数据？」，按实际情况勾选：

- ✅ **本地存储**：录制数据、待同步列表、Token、用户设置 → 仅存本机 chrome.storage.local
- ✅ **认证凭据**：GitHub PAT（用户自己填写）→ 仅存本机 chrome.storage.local
- ⬜ **个人身份信息**：无
- ⬜ **位置**：无
- ⬜ **浏览活动**：无（虽然注入到 shopee 页面，但不收集跨站活动）
- ⬜ **网页内容**：✅ 仅在 shopee.tw 域名下读取商品 API 响应内容
- ⬜ **通讯录**：无

### 4.3 隐私政策链接

需要一个公网 URL 提供隐私政策。两个方案：

- **方案 A（推荐）**：用 Gist。`store/privacy_policy.md` 粘贴到 https://gist.github.com/ 创建的 Gist，点 Raw 拿到 URL，类似 `https://gist.githubusercontent.com/23ccf/xxx/raw/privacy_policy.md`
- **方案 B**：放在自己的 GitHub 仓库根目录，URL 类似 `https://raw.githubusercontent.com/23ccf/shopee-ext/main/PRIVACY.md`

把链接填进后台「Privacy policy URL」字段。

### 4.4 单一用途声明（Single Purpose）

> 扩展的唯一用途是：被动记录用户在 Shopee 台湾站浏览的商品信息，并自动同步到用户自己的 GitHub 仓库选品库。

---

## 第 5 步：分发（Distribution Tab）

### 5.1 可见性

- **Visibility**：Public（公开）—— 上架后任何人可搜索到
- **Discoverable** ✅

### 5.2 地区

默认全球（无地区限制）。

### 5.3 付费与试用

- **Pricing**：Free（免费）
- **Trial**：无（免费扩展不需要试用）
- **In-app purchases**：无

---

## 第 6 步：自检清单（提交前最后一遍）

下面 13 项全 ✅ 才能提交，否则大概率被拒：

- [ ] **manifest_version** = 3（V2 已禁止上架）
- [ ] **version** 格式合规（`3.1.6` 这样）
- [ ] **icons** 字段指向真实 PNG 文件
- [ ] 所有 host_permissions 都有用途说明
- [ ] 数据使用问卷如实勾选
- [ ] 隐私政策 URL 可访问
- [ ] 至少 1 张截图
- [ ] 名称 ≤ 75 字符
- [ ] 短描述 ≤ 132 字符
- [ ] 详细描述含功能说明、适用人群、安装步骤、隐私承诺
- [ ] 没有出现「免费」「限时」「最」「第一」等违反《商店政策》的绝对化用语
- [ ] 没有外部下载链接（不允许引导去其他网站）
- [ ] 扩展包里没有 `*.bak`、`.zip.bak`、测试脚本、临时文件

可以用 `shopee_ext/publish.py` 一键校验第 1、3、13 项。

---

## 第 7 步：提交审核

1. 全部填完后点右上 **「提交审核」**（Submit for Review）
2. 后台显示「正在审核」（Submitted）状态
3. **首次审核** 通常 1~7 个工作日（2024 年实际经验：通常 2~3 天）
4. 审核结果会通过注册邮箱通知：
   - **通过**：自动发布到商店，开发者后台显示「Published」
   - **被拒**：邮件说明原因，可修改后再次提交（无次数限制）

---

## 第 8 步：被拒后怎么办？

### 常见拒审原因与修复

| 拒审原因 | 修复方法 |
|---|---|
| 权限用途说明不充分 | 在 Privacy Practices Tab 重新填写，每条权限都要具体说明 |
| 缺少隐私政策 URL | 按 4.3 节创建 Gist 并填入 |
| 单用途描述不清 | 改写为「被动录制 + 自动同步到 GitHub 选品库」一句话 |
| 截图中出现真实 Token / 个人信息 | 重新截图（我们的截图都是 mock 数据，不会出现） |
| 功能描述夸大 | 删除「最」「第一」「绝对」等绝对化用语 |
| manifest 字段错误 | 重新打包上传 |

### 申诉流程

1. 后台 → 拒审记录 → 选具体一项 → 「Appeal」（申诉）
2. 说明已修复的具体内容，附修改前后对比
3. 通常 3~5 工作日回复

---

## 第 9 步：更新版本

后续每次修改代码后：

1. 修改 `manifest.json` 的 `version`（必须递增，如 `3.1.6` → `3.1.7`）
2. 跑 `python pack.py` 重新生成 zip
3. 跑 `python publish.py` 跑自检
4. 后台 → 选已有扩展 → 「Package」Tab → 上传新 zip
5. 在「Store Listing」Tab 可选择性更新描述/截图
6. 点 Submit for Review
7. **更新审核通常比首发快**（24 小时~3 天）

---

## 附录 A：审核员常问的问题

> Q: 这个扩展用 `activeTab` 权限做什么？
> A: 仅当用户点击扩展图标或开启自动录制时，读取当前 shopee.tw 标签页的 URL 与 DOM 来识别商品页。扩展不监听跨站活动。

> Q: 数据会上传到你的服务器吗？
> A: 不会。扩展只会上传到用户**自己在选项页填写的 GitHub / Gitee 仓库**。开发者无法访问用户数据。

> Q: 为什么需要 `<all_urls>` 或所有站点权限？
> A: 不需要。扩展只声明 `https://shopee.tw/*` 与 `https://seller.shopee.tw/*` 两个 host，不监听任何其他站点。

---

## 附录 B：上线后维护清单

- [ ] 每周查看一次用户评论（后台 → Ratings / Reviews）
- [ ] 每月检查一次核心 API（`/api/v4/item/get`、`/api/v4/pdp/get`）是否变更
- [ ] 每次 Shopee 大改版（春节、双 11、双 12）后做一次端到端冒烟测试
- [ ] 半年更新一次隐私政策（Shopee 数据结构变更时要同步更新）

---

## 联系

有上架相关问题或想看我的真实后台填表示例，可以参考 `https://chromewebstore.google.com/category/extensions/productivity` 看同类上架产品的描述风格。

🚀 祝你一次通过！