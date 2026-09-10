# -*- coding: utf-8 -*-
"""发布前自检 + 生成干净的 release zip。

用法：
    python publish.py                  # 仅自检 + 打包当前目录
    python publish.py --dry-run        # 只自检，不打包

检查项（任一失败即退出码非 0）：
  1. manifest.json 合法性 + 必要字段（manifest_version=3 / version 格式 / icons）
  2. 所有 manifest 引用的资源文件都存在
  3. icons/icon{16,32,48,128}.png 全部存在
  4. 无硬编码的 GitHub PAT（ghp_/github_pat_）+ 真实 token
  5. 不会把测试/备份/上架资料/图标生成脚本打入发布 zip
"""
import json
import os
import re
import sys
import zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(BASE, "manifest.json")
ICONS = ("icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png")
PUBLISH_FILES = [
    "manifest.json", "background.js", "content.js", "inject.js", "sales_schema.js",
    "popup.html", "popup.js", "options.html", "options.js",
    "bridge.js", "bridge_main.js", "rules.json", "README.txt", "README.md",
    "RECORDING.md",
] + list(ICONS)


def ok(msg):
    print("  \u2705 " + msg)


def fail(msg):
    print("  \u274c " + msg)
    sys.exit(1)


def check_manifest():
    print("[1/5] manifest.json 检查")
    if not os.path.exists(MANIFEST):
        fail("manifest.json 不存在")
    try:
        m = json.load(open(MANIFEST, encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"manifest.json JSON 解析失败: {e}")

    if m.get("manifest_version") != 3:
        fail(f"manifest_version 必须是 3，当前是 {m.get('manifest_version')}")

    version = m.get("version", "")
    if not re.match(r"^\d+\.\d+\.\d+(\.\d+)?$", version):
        fail(f"version 格式错误: {version!r}（需要形如 3.1.6）")

    icons = m.get("icons") or {}
    if not all(k in icons for k in ("16", "32", "48", "128")):
        fail(f"icons 字段不完整: {icons}")

    action = m.get("action") or {}
    di = action.get("default_icon") or {}
    if not di:
        fail("action.default_icon 未配置（弹窗无图标）")

    ok(f"version={version}, name={m.get('name')}")


def check_resources():
    print("[2/5] 资源文件检查")
    m = json.load(open(MANIFEST, encoding="utf-8"))
    refs = set()
    for icon_path in (m.get("icons") or {}).values():
        refs.add(icon_path)
    for ipath in (m.get("action") or {}).get("default_icon", {}).values():
        refs.add(ipath)
    refs.add("popup.html")  # action.default_popup
    if (m.get("background") or {}).get("service_worker"):
        refs.add(m["background"]["service_worker"])
    for f in (m.get("web_accessible_resources") or []):
        if isinstance(f, dict):
            refs.update(f.get("resources") or [])
        else:
            refs.add(f)

    for ref in sorted(refs):
        p = os.path.join(BASE, ref)
        if not os.path.exists(p):
            fail(f"manifest 引用的资源缺失: {ref}")

    for icon in ICONS:
        if not os.path.exists(os.path.join(BASE, icon)):
            fail(f"图标缺失: {icon}")

    ok(f"所有 {len(refs)} 个引用资源 + {len(ICONS)} 个图标齐全")


def check_secrets():
    print("[3/5] 敏感信息扫描")
    patterns = [
        (r"ghp_[A-Za-z0-9]{20,}", "GitHub PAT (ghp_)"),
        (r"github_pat_[A-Za-z0-9_]{20,}", "GitHub PAT (github_pat_)"),
        (r"x-access-token:[^\s'\"]+", "OAuth token 头"),
        (r"AKIA[0-9A-Z]{16}", "AWS Access Key"),
    ]
    # 跳过已知安全的位置（icon/backup/store）
    skip_dirs = ("icons", "store", "test", "__restore_zip")
    findings = 0
    for root, dirs, files in os.walk(BASE):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for fn in files:
            if fn.startswith(".") or fn.endswith((".bak", ".tmp", ".pyc")):
                continue
            if not fn.endswith((".js", ".json", ".html", ".css", ".md", ".txt")):
                continue
            p = os.path.join(root, fn)
            try:
                content = open(p, encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                continue
            for pat, name in patterns:
                if re.search(pat, content):
                    print(f"  \u26a0\ufe0f 疑似 {name} in {os.path.relpath(p, BASE)}")
                    findings += 1
    if findings:
        fail(f"发现 {findings} 处疑似硬编码密钥，必须清理")
    ok("未发现硬编码密钥")


def check_pack_clean():
    print("[4/5] 发布包文件清单检查")
    # 不应打入发布包的文件类型
    forbidden = [
        ".bak", ".bak-", ".tmp", ".pyc", ".zip",
        "_test_", "__gh_", "__catalog_",
    ]
    forbidden_dirs = {"test", "__restore_zip", "store", ".git"}
    for f in PUBLISH_FILES:
        if any(tok in f for tok in forbidden):
            fail(f"PUBLISH_FILES 包含备份/测试文件: {f}")
    for d in forbidden_dirs:
        if any(f.startswith(d + "/") for f in PUBLISH_FILES):
            fail(f"PUBLISH_FILES 包含禁止目录: {d}")
    ok(f"共 {len(PUBLISH_FILES)} 个文件，干净")


def pack():
    print("[5/5] 打包 release zip")
    m = json.load(open(MANIFEST, encoding="utf-8"))
    version = m["version"]
    out_dir = os.path.join(BASE, "release")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"shopee_selector_ext-{version}.zip")

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in PUBLISH_FILES:
            p = os.path.join(BASE, f)
            z.write(p, f)
    ok(f"打包完成: {out_path}")
    ok(f"  文件数: {len(PUBLISH_FILES)}")
    ok(f"  大小:   {os.path.getsize(out_path) / 1024:.1f} KB")


def main():
    dry = "--dry-run" in sys.argv
    print(f"=== 发布前自检 ({'dry-run' if dry else '完整打包'}) ===")
    check_manifest()
    check_resources()
    check_secrets()
    check_pack_clean()
    if not dry:
        pack()
    print("\n\u2705 全部检查通过")


if __name__ == "__main__":
    main()