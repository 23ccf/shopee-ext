# -*- coding: utf-8 -*-
"""生成虾皮台湾选品录制器扩展图标（16/32/48/128 PNG）。
虾皮橙底 + 白色购物袋 + 红色录制圆点。512 超采样后 LANCZOS 缩放保证清晰。
"""
from PIL import Image, ImageDraw
import os

S = 512
OUT = os.path.dirname(os.path.abspath(__file__))

ORANGE = (238, 77, 45, 255)      # 虾皮橙 #EE4D2D
WHITE = (255, 255, 255, 255)
RED = (255, 59, 48, 255)         # 录制红 #FF3B30


def build_base():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 1) 圆角方形背景（虾皮橙）
    d.rounded_rectangle([20, 20, S - 20, S - 20], radius=110, fill=ORANGE)

    # 2) 购物袋提手（两个白色半圆弧，底部随后被袋身盖住）
    lw = 32
    d.arc([150, 138, 250, 270], start=180, end=360, fill=WHITE, width=lw)
    d.arc([262, 138, 362, 270], start=180, end=360, fill=WHITE, width=lw)

    # 3) 袋身（白色圆角矩形，盖住提手底部）
    d.rounded_rectangle([140, 215, 372, 435], radius=30, fill=WHITE)

    # 4) 录制圆点（白环 + 红点），右上角
    d.ellipse([358, 58, 454, 154], fill=WHITE)      # 白环外圈
    d.ellipse([376, 76, 436, 136], fill=RED)        # 红点

    return img


def main():
    base = build_base()
    sizes = [16, 32, 48, 128]
    for size in sizes:
        out = base.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT, "icon%d.png" % size)
        out.save(path, "PNG")
        print("生成 %s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
