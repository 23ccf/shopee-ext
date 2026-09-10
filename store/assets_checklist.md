# Chrome Web Store 上架资源清单 / Asset Checklist

> 上架前需准备的图片资源。当前仓库**尚未提供图标**，需补充后才能提交。

---

## 1. 图标（必填）

Chrome Web Store 要求至少一张 **128×128** 图标（PNG）。

| 尺寸 | 用途 | 状态 |
|---|---|---|
| 128×128 | 商店展示（必填） | ✅ `icons/icon128.png` |
| 16×16 / 32×32 / 48×48 | 浏览器工具栏 / 扩展管理页 | ✅ `icons/icon16/32/48.png` |

已在 `manifest.json` 中补上：

```json
"icons": {
  "16": "icons/icon16.png",
  "32": "icons/icon32.png",
  "48": "icons/icon48.png",
  "128": "icons/icon128.png"
},
"action": {
  "default_icon": { "16": "icons/icon16.png", "32": "icons/icon32.png" }
}
```

图标建议：简洁的购物袋/货架 + 「录制」圆点元素，底色用虾皮橙（#EE4D2D）或选品主色。

---

## 2. 截图（必填，至少 1 张）

Chrome Web Store 要求至少 1 张截图，尺寸 **1280×800**（或 640×400），PNG 或 JPEG。

建议 3–5 张，分别展示：

| 截图 | 内容建议 | 状态 |
|---|---|---|
| 1 | 扩展弹窗（录制开关 + 待同步数量） | ✅ `screenshots/screenshot_01_popup.png` |
| 2 | 扩展选项页（GitHub Token / 后端配置） | ✅ `screenshots/screenshot_02_options.png` |
| 3 | 选品网站商品库网格（搜索/筛选/排序） | ✅ `screenshots/screenshot_03_website_grid.png` |
| 4 | 商品详情弹窗（销量/价格/SKU） | ✅ `screenshots/screenshot_04_website_detail.png` |

> 4 张截图已生成（1280×800 PNG），由系统 Chrome headless 自动截取：
> - 网格/详情用线上真实数据（网站当前 GitHub 数据源）。
> - 弹窗/选项页为本地预览（注入 mock 扩展状态渲染，无真实 Token）。
> - 重新生成：`python gen_previews.py`（弹窗/选项页）、`python gen_detail.py`（详情弹窗），再用 `chrome --headless` 截图。

---

## 3. 宣传图（可选）

| 尺寸 | 用途 | 状态 |
|---|---|---|
| 440×280 | 小型宣传位 | ❌ 可选 |
| 920×680 | 中型宣传位 | ❌ 可选 |
| 1400×560 | 大型宣传位 | ❌ 可选 |

---

## 4. 提交前自检

- [ ] `manifest.json` 的 `name` / `description` 与商店文案一致
- [ ] 版本号 `version` 已递增（当前 3.1.6）
- [ ] 已补 `icons` 字段
- [ ] 隐私政策已就绪（`store/privacy_policy.md`，提交时粘贴到商店后台）
- [ ] 截图与宣传图已上传
- [ ] 权限与用途在描述中如实说明（对齐隐私政策里的权限表）
- [ ] 商店列表文案已填（`store/store_listing.md` 中英文）
