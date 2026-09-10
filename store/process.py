# -*- coding: utf-8 -*-
"""把 raw 截图处理成 1280×800 标准尺寸。"""
from PIL import Image, ImageChops
import os

d = "C:/Users/1/shopee_ext/store/screenshots"


def trim_white(img):
    bg = Image.new("RGB", img.size, (255, 255, 255))
    diff = ImageChops.difference(img.convert("RGB"), bg)
    bbox = diff.getbbox()
    return img.crop(bbox) if bbox else img


def fit_to(img, W=1280, H=800):
    scale = min(W / img.width, H / img.height)
    nw, nh = int(img.width * scale), int(img.height * scale)
    img = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    canvas.paste(img, ((W - nw) // 2, (H - nh) // 2))
    return canvas


# popup：trim 白边后缩放居中
popup = trim_white(Image.open(os.path.join(d, "_popup_raw.png")).convert("RGB"))
fit_to(popup).save(os.path.join(d, "screenshot_01_popup.png"))
print("popup:", popup.size)

# options：2560×1600 → 1280×800（比例一致，直接缩放）
opt = Image.open(os.path.join(d, "_options_raw.png")).convert("RGB")
opt.resize((1280, 800), Image.LANCZOS).save(os.path.join(d, "screenshot_02_options.png"))
print("options:", opt.size)

for f in ("_popup_raw.png", "_options_raw.png"):
    os.remove(os.path.join(d, f))
print("完成")
