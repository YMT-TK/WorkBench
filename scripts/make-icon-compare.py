# -*- coding: utf-8 -*-
"""生成「旧图标 vs 新图标」对比图（含小尺寸行），用于人工确认换图标效果。"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = ".workbuddy/icon-candidates/icon-compare.png"


def load_font(size):
    windir = os.environ.get("WINDIR", r"C:\Windows")
    for name in ("msyh.ttc", "msyhbd.ttc", "arial.ttf"):
        p = os.path.join(windir, "Fonts", name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def main():
    old = Image.open(".workbuddy/icon-backup/1791117270-icon.png").convert("RGBA")
    new = Image.open("src-tauri/icons/icon.png").convert("RGBA")

    cols = [128, 64, 48, 32, 16]
    big = 256
    margin, gap = 48, 32
    label_h = 60
    row_h = big + label_h
    w = margin * 2 + big * 2 + gap * 3 + sum(cols) + gap * len(cols)
    h = margin * 2 + row_h * 2 + 40

    canvas = Image.new("RGB", (w, h), (247, 248, 251))
    d = ImageDraw.Draw(canvas)
    f_label = load_font(24)
    f_row = load_font(20)
    f_note = load_font(15)

    y = margin
    for title, img in (("旧图标（蓝底 W）", old), ("新图标（3 号 · WB 终端箭头）", new)):
        x = margin
        thumb = img.resize((big, big), Image.LANCZOS)
        # 棋盘底
        for by in range(0, big, 16):
            for bx in range(0, big, 16):
                c = (238, 240, 244) if ((bx // 16 + by // 16) % 2 == 0) else (255, 255, 255)
                d.rectangle([x + bx, y + by, x + bx + 15, y + by + 15], fill=c)
        canvas.paste(thumb, (x, y), thumb)
        d.text((x, y + big + 12), title, font=f_row, fill=(40, 44, 56))
        x += big + gap

        d.text((x, y + 6), "实际显示尺寸", font=f_note, fill=(130, 136, 150))
        yy = y + 34
        for c in cols:
            t = img.resize((c, c), Image.LANCZOS)
            for by in range(0, c, 8):
                for bx in range(0, c, 8):
                    cc = (238, 240, 244) if ((bx // 8 + by // 8) % 2 == 0) else (255, 255, 255)
                    d.rectangle([x + bx, yy + by, min(x + bx + 7, x + c - 1),
                                 min(yy + by + 7, yy + c - 1)], fill=cc)
            canvas.paste(t, (x + c // 2, yy), t)
            x += c + gap
        y += row_h

    d.text((margin, h - 34),
           "注：新图标 .ico 含 16/24/32/48/64/128/256 七个尺寸，Windows 编译期嵌入 exe，重启后生效。",
           font=f_note, fill=(120, 126, 140))
    canvas.save(OUT)
    print(f"[ok] {OUT} ({canvas.size[0]}x{canvas.size[1]})")


if __name__ == "__main__":
    sys.exit(main())
