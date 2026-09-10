# 贡献指南

欢迎为虾皮台湾选品录制器贡献代码！在提交之前，请先阅读本指南。

---

## 项目结构

```
shopee_ext/
├── manifest.json          # Chrome MV3 清单
├── background.js          # 后台脚本：录制合并 + GitHub 同步
├── content.js             # 内容脚本：注入 shopee.tw 抓 API
├── inject.js              # MAIN world：拦截 fetch 响应
├── sales_schema.js        # 销量字段统一解析器
├── bridge.js / bridge_main.js  # 跨域桥接
├── popup.html / popup.js  # 弹窗
├── options.html / options.js # 选项页
├── icons/                 # 图标资源
├── store/                 # 上架资料
├── test/                  # 测试脚本
├── pack.py                # 打包脚本
└── publish.py             # 发布自检
```

---

## 开发环境

- **Node.js** ≥ 20（推荐 22 LTS）
- **Python** ≥ 3.10（脚本用，非运行依赖）
- **Chrome / Edge / 跨境卫士** ≥ 100（Manifest V3 要求）

## 提交代码

1. Fork 仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交代码：`git commit -m "feat: 描述你的改动"`
4. 推送：`git push origin feature/your-feature`
5. 创建 Pull Request

**Commit 规范**（参考 Conventional Commits）：

- `feat:` 新功能
- `fix:` 修复 bug
- `docs:` 文档变更
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 杂项

---

## 测试

修改 `background.js` 或 `sales_schema.js` 后**必须**运行测试套件：

```bash
cd /d C:/Users/1/shopee_verify
node __ext_del.js
node __ext_backend.js
node __e2e_del.js
```

全部必须通过（绿），PR 才会被接受。

修改 `content.js` 或 `inject.js` 时，需要在真实跨境卫士环境下冒烟：

1. 安装本地扩展 `chrome://extensions/` → 加载未打包 → 选本目录
2. 打开 `https://shopee.tw/product/...` 一个真实商品
3. 检查 `background.js` 控制台是否成功打印「收到商品」
4. 检查 GitHub 仓库 catalog.json 是否新增记录

---

## 字段口径（必须严格遵守）

录制器采集的核心字段含义有严格定义，**改之前务必读 `RECORDING.md`**：

- **month_sold**：近 30 天销量，权威源 = 详情接口 `item/get` 的 `item.sold`
- **week_sold** = round(month_sold / 4.345)
- **total_sold**：累计总销量，权威源 = 详情页 DOM「已售出 X」
- **price**：店铺页面 / 列表接口用「分」（÷100），详情接口用「元×100000」（÷100000）
- **last_seen**：秒级时间戳（不是毫秒！），用于 today-only 过滤
- **first_seen**：首次录入时间，绝不当 today-only 过滤字段

---

## 性能底线

- 同步互斥锁必须保持（避免并发推送 GitHub 422 冲突）
- `/git/trees/{branch}` 在 catalog 与 deleted.json 之间必须共用缓存
- 录制入口过滤：只录入「月销 > 0 或 总销 > 0」的商品

---

## 不要做

- ❌ 不要硬编码任何 GitHub Token / 个人凭据
- ❌ 不要修改 manifest.json 的 `version` 字段（PR 中让维护者统一升版本）
- ❌ 不要提交 `*.bak`、`*.zip.bak`、`__restore_zip/` 目录
- ❌ 不要把完整 catalog 数据 commit 到仓库（catalog 在 data repo 里，不在代码仓库）

---

## 提出 Issue

报告 Bug 请附：

1. 跨境卫士 / Chrome 版本号
3. 复现步骤
2. `background.js` 控制台输出
3. 出问题的商品 URL（脱敏后可）

提出功能建议请先搜一下 Issues，避免重复。

---

## 联系方式

- GitHub Issues：首选
- 邮件：见仓库的 main branch

---

感谢你的贡献！🎉