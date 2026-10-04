# -*- coding: utf-8 -*-
"""生成 NSIS 安装向导的 MUI 位图资源（24bit BMP，无 alpha）。

- header   150x57   安装在页眉的横幅
- sidebar  164x314  欢迎页/完成页左侧竖图
素材来自 src-tauri/icons/icon.png（圆角透明底），贴到品牌蓝底上。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SRC_ICON = "src-tauri/icons/icon.png"
OUT_DIR = "src-tauri/icons"

BRAND_TOP = (18, 42, 92)      # 深蓝
BRAND_BOTTOM = (32, 92, 186)  # 亮蓝
TEXT_MAIN = (255, 255, 255)
TEXT_SUB = (176, 205, 240)


def load_font(size, bold=False):
    windir = os.environ.get("WINDIR", r"C:\Windows")
    names = ("msyhbd.ttc", "msyh.ttc") if bold else ("msyh.ttc", "arial.ttf")
    for n in names:
        p = os.path.join(windir, "Fonts", n)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", size)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(h - 1, 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    return img


def paste_icon(canvas, box, icon):
    """把图标等比缩放后贴到 canvas 的 box=(x, y, w, h) 区域（居中）。"""
    bx, by, w, h = box
    ic = icon.copy()
    ic.thumbnail((w, h), Image.LANCZOS)
    canvas.paste(ic, (bx + (w - ic.width) // 2, by + (h - ic.height) // 2), ic)


def make_header(icon):
    w, h = 150, 57
    img = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(img)
    # 右侧品牌蓝块，左侧留白放文字
    d.rectangle([w - 46, 0, w, h], fill=BRAND_BOTTOM)
    paste_icon(img, (w - 46, 0, 46, h), icon)
    d.text((6, 12), "WorkBench", font=load_font(17, bold=True), fill=BRAND_TOP)
    d.text((7, 33), "桌面工作台", font=load_font(11), fill=(110, 122, 140))
    img.save(os.path.join(OUT_DIR, "nsis-header.bmp"), "BMP")
    return f"{OUT_DIR}/nsis-header.bmp {img.size}"


def make_sidebar(icon):
    w, h = 164, 314
    img = gradient((w, h), BRAND_TOP, BRAND_BOTTOM)
    d = ImageDraw.Draw(img)
    paste_icon(img, (12, 48, w - 24, 96), icon)
    f_main = load_font(20, bold=True)
    f_sub = load_font(11)
    t = "WorkBench"
    tw = d.textlength(t, font=f_main)
    d.text(((w - tw) / 2, 168), t, font=f_main, fill=TEXT_MAIN)
    s = "插件化桌面工作台"
    sw = d.textlength(s, font=f_sub)
    d.text(((w - sw) / 2, 196), s, font=f_sub, fill=TEXT_SUB)
    # 底部细线装饰
    d.line([(20, h - 26), (w - 20, h - 26)], fill=(120, 160, 220), width=1)
    img.save(os.path.join(OUT_DIR, "nsis-sidebar.bmp"), "BMP")
    return f"{OUT_DIR}/nsis-sidebar.bmp {img.size}"


def main():
    if not os.path.exists(SRC_ICON):
        print(f"[fail] 缺少 {SRC_ICON}")
        return 1
    icon = Image.open(SRC_ICON).convert("RGBA")
    print("[ok]", make_header(icon))
    print("[ok]", make_sidebar(icon))
    return 0


if __name__ == "__main__":
    sys.exit(main())
