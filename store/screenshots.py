# -*- coding: utf-8 -*-
"""生成 Chrome Web Store 上架所需的 4 张截图。

- screenshot_01_popup.png      扩展弹窗（mock chrome 状态）
- screenshot_02_options.png    扩展选项页（GitHub 模式）
- screenshot_03_website_grid.png  选品网站商品库网格（真实数据）
- screenshot_04_website_detail.png 商品详情弹窗（真实数据）

统一输出 1280×800。popup/options 是本地文件，需注入 mock chrome API 才能渲染。
"""
import os
from playwright.sync_api import sync_playwright
from PIL import Image

EXT = "C:/Users/1/shopee_ext"
SITE = "https://23ccf.github.io/shopee-site"
OUT = os.path.join(EXT, "store", "screenshots")
os.makedirs(OUT, exist_ok=True)

MOCK_CHROME = r"""
window.chrome = {
  runtime: {
    sendMessage: (msg) => {
      if (msg.type === 'getState') return Promise.resolve({
        recording: true,
        pending: { a: 1, b: 2, c: 3 },
        lastSync: { ok: true, ts: Date.now() - 3600000, added: 5 },
        giteeCfg: {},
        lastGiteeSync: null
      });
      if (msg.type === 'setRecording') return Promise.resolve({ ok: true });
      if (msg.type === 'manualSync') return Promise.resolve({ ok: true, added: 3, total: 414 });
      if (msg.type === 'clearPending') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    },
    getURL: (p) => 'file:///C:/Users/1/shopee_ext/' + p,
    openOptionsPage: () => {},
    lastError: null
  },
  storage: { local: {
    get: (keys) => {
      const o = {};
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        if (k === 'browseCapture') o[k] = true;
        else if (k === 'cfg') o[k] = { token: '', owner: '23ccf', repo: 'shopee-sync', branch: 'main', catalogPath: 'catalog.json', syncPath: 'sync.json' };
        else if (k === 'giteeCfg') o[k] = { enabled: false, owner: '', repo: 'shopee-sync', branch: 'master', token: '', catalogPath: 'catalog.json', syncPath: 'sync.json' };
        else if (k === 'backend') o[k] = { enabled: false, url: 'http://127.0.0.1:3000', username: '', password: '' };
      }
      return Promise.resolve(o);
    },
    set: () => Promise.resolve()
  }},
  tabs: { create: (o, cb) => { if (cb) cb(); } }
};
"""


def fit_to_store(src, dst, bg=(255, 255, 255)):
    """把任意尺寸截图缩放到 1280×800，保持宽高比、白底居中。"""
    img = Image.open(src).convert("RGBA")
    W, H = 1280, 800
    scale = min(W / img.width, H / img.height)
    nw, nh = int(img.width * scale), int(img.height * scale)
    img = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), bg)
    canvas.paste(img, ((W - nw) // 2, (H - nh) // 2), img)
    canvas.save(dst, "PNG")
    return dst


def shot_popup(p):
    raw = os.path.join(OUT, "_popup_raw.png")
    ctx = p.chromium.launch().new_context(viewport={"width": 320, "height": 760},
                                          device_scale_factor=2)
    page = ctx.new_page()
    page.add_init_script(MOCK_CHROME)
    page.goto("file:///" + EXT + "/popup.html")
    page.wait_for_timeout(1000)
    page.screenshot(path=raw, full_page=True)
    ctx.close()
    dst = fit_to_store(raw, os.path.join(OUT, "screenshot_01_popup.png"))
    os.remove(raw)
    print("OK popup ->", dst)


def shot_options(p):
    raw = os.path.join(OUT, "_options_raw.png")
    ctx = p.chromium.launch().new_context(viewport={"width": 1280, "height": 800},
                                          device_scale_factor=2)
    page = ctx.new_page()
    page.add_init_script(MOCK_CHROME)
    page.goto("file:///" + EXT + "/options.html")
    page.wait_for_timeout(1000)
    page.screenshot(path=raw, full_page=True)
    ctx.close()
    dst = fit_to_store(raw, os.path.join(OUT, "screenshot_02_options.png"))
    os.remove(raw)
    print("OK options ->", dst)


def shot_site(p):
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.goto(SITE, wait_until="load")
    try:
        page.wait_for_selector("#libGrid .pcard", timeout=25000)
    except Exception as e:
        print("等待卡片超时:", e)
    page.wait_for_timeout(4000)  # 等缩略图尽量加载
    page.screenshot(path=os.path.join(OUT, "screenshot_03_website_grid.png"))
    print("OK website grid")
    try:
        first = page.query_selector("#libGrid .pcard")
        if first:
            first.click()
            page.wait_for_timeout(2500)
            page.screenshot(path=os.path.join(OUT, "screenshot_04_website_detail.png"))
            print("OK website detail")
        else:
            print("无卡片可点，跳过详情")
    except Exception as e:
        print("详情截图失败:", e)
    browser.close()


def main():
    with sync_playwright() as p:
        shot_popup(p)
        shot_options(p)
        shot_site(p)
    print("全部完成")


if __name__ == "__main__":
    main()
