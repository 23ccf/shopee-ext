# -*- coding: utf-8 -*-
"""生成 popup/options 的自包含预览 HTML（内联 mock chrome + 真实 JS），供 headless 截图。"""
import os

EXT = "C:/Users/1/shopee_ext"
STORE = os.path.join(EXT, "store")
MOCK = open(os.path.join(STORE, "mock_chrome.js"), encoding="utf-8").read()


def build(name):
    html = open(os.path.join(EXT, name + ".html"), encoding="utf-8").read()
    js = open(os.path.join(EXT, name + ".js"), encoding="utf-8").read()
    # 把 <script src="xxx.js"></script> 替换为内联 mock + 真实 js
    tag = '<script src="%s.js"></script>' % name
    replacement = "<script>\n%s\n</script>\n<script>\n%s\n</script>" % (MOCK, js)
    assert tag in html, "未找到 script 标签: " + tag
    html = html.replace(tag, replacement)
    out = os.path.join(STORE, "preview_" + name + ".html")
    open(out, "w", encoding="utf-8").write(html)
    print("生成", out, len(html), "bytes")


build("popup")
build("options")
print("完成")
