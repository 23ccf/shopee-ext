# -*- coding: utf-8 -*-
"""生成 Chrome Web Store 宣传素材。

- promo_tile_440x280.png  小竖幅（商店「promotional tile」位）
- marquee_1400x560.png    大横幅（商店首页「marquee」位）

风格与扩展图标一致：虾皮橙渐变底 + 白色购物袋 + 红色录制圆点。
4x 超采样后 LANCZOS 缩放，保证文字边缘清晰。
"""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "promo")
ICONS = os.path.join(os.path.dirname(HERE), "icons")

ORANGE = (238, 77, 45)
ORANGE_LIGHT = (255, 122, 82)
WHITE = (255, 255, 255)
RED = (255, 59, 48)

FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
SS = 4  # 超采样倍数


def font(path, size):
    return ImageFont.truetype(path, size * SS)


def blend(fg, bg, alpha):
    """把前景色按 alpha 比例混合到背景色（统一 RGBA 画布上 fill 丢 alpha 的兜底）。"""
    a = alpha / 255.0
    return tuple(int(round(fg[i] * a + bg[i] * (1 - a))) for i in range(3))


def gradient(size, c1, c2, horizontal=True):
    """生成渐变底图（线性插值，RGBA）。"""
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    n = w if horizontal else h
    for i in range(n):
        t = i / max(n - 1, 1)
        c = tuple(int(c1[k] + (c2[k] - c1[k]) * t) for k in range(3))
        if horizontal:
            d.line([(i, 0), (i, h)], fill=c)
        else:
            d.line([(0, i), (w, i)], fill=c)
    return img


def load_icon(size):
    """读取 128 图标并缩放到指定尺寸（保留透明通道）。"""
    p = os.path.join(ICONS, "icon128.png")
    return Image.open(p).convert("RGBA").resize((size * SS, size * SS), Image.LANCZOS)


def build_tile():
    """小竖幅 440x280：图标在上，标题在下，居中。"""
    W, H = 440, 280
    img = gradient((W * SS, H * SS), ORANGE_LIGHT, ORANGE, horizontal=True)
    d = ImageDraw.Draw(img)

    icon = load_icon(110)
    ix = (W * SS - icon.width) // 2
    iy = 34 * SS
    img.paste(icon, (ix, iy), icon)

    f_title = font(FONT_BOLD, 30)
    f_sub = font(FONT_REG, 16)
    f_en = font(FONT_REG, 13)

    t1 = "虾皮台湾选品录制器"
    t2 = "边逛边录 · 自动同步到选品库"
    t3 = "Shopee Product Recorder"

    for text, f, y, fill in (
        (t1, f_title, 162, WHITE),
        (t2, f_sub, 206, (255, 235, 230)),
        (t3, f_en, 234, (255, 215, 205)),
    ):
        bb = d.textbbox((0, 0), text, font=f)
        d.text(((W * SS - (bb[2] - bb[0])) // 2, y * SS), text, font=f, fill=fill)

    return img.resize((W, H), Image.LANCZOS)


def draw_card(d, x, y, w, h, base_rgb, bg_alpha, bar_count=3):
    """画一个半透明商品卡片示意（基于底色 base_rgb 预混合避免 Pillow 丢 alpha）。"""
    d.rounded_rectangle([x, y, x + w, y + h], radius=14 * SS, fill=blend(WHITE, base_rgb, bg_alpha))
    # 图片占位
    img_color = blend(WHITE, base_rgb, 30)
    d.rounded_rectangle(
        [x + 12 * SS, y + 12 * SS, x + w - 12 * SS, y + 12 * SS + (h - 60 * SS)],
        radius=10 * SS, fill=img_color,
    )
    for i in range(bar_count):
        by = y + h - 40 * SS + i * 13 * SS
        bw = (w - 24 * SS) * (1.0 if i == 0 else 0.62 if i == 1 else 0.4)
        a = 60 if i == 0 else 32
        d.rounded_rectangle(
            [x + 12 * SS, by, x + 12 * SS + bw, by + 7 * SS],
            radius=4 * SS, fill=blend(WHITE, base_rgb, a),
        )


def build_marquee():
    """大横幅 1400x560：左侧文案 + 图标，右侧商品卡片网格示意。"""
    W, H = 1400, 560
    img = gradient((W * SS, H * SS), ORANGE_LIGHT, ORANGE, horizontal=True)
    d = ImageDraw.Draw(img)

    # --- 左侧：图标 + 标题 ---
    icon = load_icon(150)
    img.paste(icon, (80 * SS, 150 * SS), icon)

    f_title = font(FONT_BOLD, 58)
    f_sub = font(FONT_REG, 26)
    d.text((275 * SS, 158 * SS), "虾皮台湾选品录制器", font=f_title, fill=WHITE)
    d.text((278 * SS, 244 * SS), "逛店即采集 · 月销/总销自动识别 · 一键同步选品库", font=f_sub,
           fill=(255, 238, 233))

    # 三个特性胶囊（基于画布中心橙底预混合）
    feats = ["被动录制，无需手动复制", "字段口径统一，销量不失真", "开源免费，数据归你自己"]
    base_capsule = ORANGE_LIGHT  # 大约画布中段颜色
    fx = 278 * SS
    fy = 316 * SS
    f_feat = font(FONT_REG, 21)
    for t in feats:
        bb = d.textbbox((0, 0), t, font=f_feat)
        tw = bb[2] - bb[0]
        pad = 18 * SS
        d.rounded_rectangle(
            [fx, fy, fx + tw + pad * 2, fy + 52 * SS], radius=26 * SS,
            fill=blend(WHITE, base_capsule, 60),
        )
        d.text((fx + pad, fy + 13 * SS), t, font=f_feat, fill=WHITE)
        fx += tw + pad * 2 + 16 * SS

    # --- 右侧：商品卡片网格示意 ---
    cw, ch, gap = 150 * SS, 200 * SS, 26 * SS
    gx0, gy0 = 900 * SS, 130 * SS
    base_card = ORANGE  # 卡片所在区域颜色偏深橙
    for r in range(2):
        for c in range(3):
            draw_card(d, gx0 + c * (cw + gap), gy0 + r * (ch + gap), cw, ch,
                      base_card, bg_alpha=70, bar_count=3)

    return img.resize((W, H), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, builder in (
        ("promo_tile_440x280.png", build_tile),
        ("marquee_1400x560.png", build_marquee),
    ):
        img = builder()
        p = os.path.join(OUT, name)
        img.save(p, "PNG")
        print("生成 %s  %s  %d KB" % (p, img.size, os.path.getsize(p) // 1024))


if __name__ == "__main__":
    main()
