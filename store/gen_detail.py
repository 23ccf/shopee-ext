# -*- coding: utf-8 -*-
"""生成商品详情弹窗预览 HTML（真实数据 + 网站弹窗 CSS），供 headless 截图。"""
import json
import html as H

CATALOG = "C:/Users/1/shopee_verify/catalog_full.json"
OUT = "C:/Users/1/shopee_ext/store/preview_detail.html"

d = json.load(open(CATALOG, encoding="utf-8"))
items = d.get("items", d if isinstance(d, list) else [])

# 优先洞洞鞋/拖鞋（价格合理），否则选价格合理且月销最高者
def pick(items):
    for kw in ("洞洞鞋", "拖鞋", "crocs", "Crocs", "洞洞"):
        for it in items:
            if kw in (it.get("name") or "") and 100 <= (it.get("price") or 0) <= 1500:
                return it
    cand = [it for it in items if 100 <= (it.get("price") or 0) <= 1500 and (it.get("month_sold") or 0) > 100]
    return max(cand, key=lambda x: (x.get("month_sold") or 0)) if cand else items[0]

it = pick(items)
name = it.get("name") or "商品"
img = it.get("img") or ""
shop = it.get("shop") or "店铺"
price = it.get("price") or 0
month_sold = it.get("month_sold") or 0
week_sold = it.get("week_sold") or 0
sold_total = it.get("sold_total") or it.get("total_sold") or 0

# 网站直接显示 price 原值（大多数商品已是「元」单位）
p = price

def num(n):
    return "—" if n in (None, 0) else format(int(n), ",")

CSS = """
:root{--brand:#e8453c;--accent:#4a90e2;--ink:#1f2733;--muted:#7a8699;--good:#2e9e4f;--line:#e7ebf0}
*{box-sizing:border-box}
body{margin:0;background:#f4f6f9;font-family:-apple-system,"Microsoft YaHei",sans-serif;color:var(--ink)}
.modal{position:fixed;inset:0;background:rgba(15,22,35,.55);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;z-index:50;overflow:auto}
.modal-box{background:#fff;border-radius:16px;max-width:720px;width:100%;padding:22px 24px 26px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.modal-close{position:absolute;top:12px;right:14px;border:none;background:#f1f3f6;width:30px;height:30px;border-radius:50%;font-size:15px;cursor:pointer;color:#555}
.p-head{display:flex;gap:16px;align-items:flex-start}
.p-img{width:110px;height:110px;object-fit:cover;border-radius:12px;flex-shrink:0;background:#f1f3f6}
.p-meta{flex:1;min-width:0}
.p-name{font-size:17px;font-weight:700;line-height:1.35}
.p-sub{font-size:12px;color:var(--muted);margin-top:6px}
.p-link{display:inline-block;margin-top:8px;color:var(--accent);font-size:13px;text-decoration:none}
.p-cards{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
.p-card{flex:1 1 140px;background:linear-gradient(135deg,#fff,#fff7f5);border:1px solid #ffe1db;border-radius:12px;padding:14px 16px}
.p-card .n{font-size:22px;font-weight:800;color:var(--brand);line-height:1.1}
.p-card .l{font-size:12px;color:var(--muted);margin-top:5px}
.p-tiers{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 14px}
.pill{display:inline-block;background:#fdecea;color:var(--brand);border-radius:6px;padding:2px 8px;font-size:12px}
"""

def card(n, l):
    return '<div class="p-card"><div class="n">%s</div><div class="l">%s</div></div>' % (n, l)

img_tag = ('<img class="p-img" src="%s" referrerpolicy="no-referrer" loading="eager" alt="">'
           % H.escape(img)) if img else '<div class="p-img" style="display:flex;align-items:center;justify-content:center;font-size:40px">📦</div>'

body = """
<div class="modal">
  <div class="modal-box">
    <button class="modal-close">✕</button>
    <div class="modal-body">
      <div class="p-head">
        %s
        <div class="p-meta">
          <div class="p-name">%s</div>
          <div class="p-sub">未知产地 · 店铺：%s</div>
          <a class="p-link" href="#" rel="noopener">在虾皮查看 ↗</a>
        </div>
      </div>
      <div class="p-cards">
        %s
        %s
        %s
        %s
        %s
      </div>
      <div class="p-tiers"><span class="pill">月销量 %s · 总销量 %s</span></div>
    </div>
  </div>
</div>
""" % (
    img_tag,
    H.escape(name),
    H.escape(shop),
    card("NT$" + format(int(p), ","), "售价"),
    card(num(month_sold), "月销量"),
    card(num(week_sold), "周销量"),
    card(num(sold_total), "链接总销量"),
    card("—", "评分"),
    num(month_sold), num(sold_total),
)

html = '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><style>%s</style></head><body>%s</body></html>' % (CSS, body)
open(OUT, "w", encoding="utf-8").write(html)
print("生成", OUT)
print("商品:", name[:40], "| price:", price, "->", p, "| 月销", month_sold, "总销", sold_total)
