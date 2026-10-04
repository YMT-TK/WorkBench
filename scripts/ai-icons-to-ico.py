# -*- coding: utf-8 -*-
"""
把 AI 生成的候选图标 PNG 规范化并导出为多尺寸 Windows .ico，
同时生成小尺寸可读性对比图。

用法:
    python scripts/ai-icons-to-ico.py --src .workbuddy/icon-candidates/ai
"""
import argparse
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
CANVAS = 1024
PAD_RATIO = 0.06  # 内容四周留白比例

# 自动扫描 --src 目录下的 *.png（跳过预览图与 normalized 子目录），按文件名排序
SKIP_NAMES = {"preview-sheet.png", "contact-sheet.png", "small-sizes.png"}


def discover(src_dir: str):
    files = []
    for f in os.listdir(src_dir):
        if not f.lower().endswith(".png"):
            continue
        if f in SKIP_NAMES or f.startswith("icon-"):
            continue
        files.append(os.path.join(src_dir, f))
    files.sort()
    return [(os.path.splitext(os.path.basename(p))[0], p) for p in files]


def trim_white_corners(img: Image.Image, verbose: bool = True) -> Image.Image:
    """把「白底 + 圆角底板」类图标的圆角外侧白色转成透明。

    思路：从四角做泛洪填充，只有与角落连通的白区才算「板外」；
    字母内部的白色被深色底板包围，泛洪到不了，因此不会被误伤。
    """
    w, h = img.size
    rgb = img.convert("RGB")

    mark = rgb.copy()
    flag = (255, 0, 255)
    for pt in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        try:
            ImageDraw.floodfill(mark, pt, flag, thresh=60)
        except Exception:
            pass

    # 与标记色的差异 → 掩码（比逐像素循环快得多）
    diff = ImageChops.difference(mark, Image.new("RGB", (w, h), flag))
    mask = diff.convert("L").point(lambda v: 255 if v < 40 else 0)
    if not mask.getbbox():
        return img

    # 膨胀 + 羽化，让圆角边缘保留抗锯齿而不是硬切
    soft = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.5))
    out = img.copy()
    out.putalpha(ImageChops.subtract(out.getchannel("A"), soft))
    if verbose:
        n = sum(mask.point(lambda v: 1 if v else 0).getdata())
        print(f"[corner] 圆角外侧白区转透明：{n} 像素")
    return out


def content_bbox(img: Image.Image):
    """优先按 alpha 裁剪；无有效 alpha 时按“非白像素”裁剪。"""
    img = img.convert("RGBA")
    alpha = img.getchannel("A")
    a_bbox = alpha.getbbox()
    # 判断 alpha 是否真的提供了边界（存在透明像素）
    has_transparency = alpha.getextrema()[0] < 250
    if has_transparency and a_bbox:
        return a_bbox

    # 转白底后按非白像素找边界
    white = Image.new("RGBA", img.size, (255, 255, 255, 255))
    flat = Image.alpha_composite(white, img).convert("RGB")
    # 与纯白的差异掩膜
    diff = Image.new("L", img.size, 0)
    px = flat.load()
    dpx = diff.load()
    w, h = flat.size
    step = 1
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px[x, y]
            if abs(r - 255) + abs(g - 255) + abs(b - 255) > 24:
                dpx[x, y] = 255
    bbox = diff.getbbox()
    return bbox or (0, 0, w, h)


def normalize(path: str) -> Image.Image:
    img = Image.open(path).convert("RGBA")
    img = trim_white_corners(img)
    bbox = content_bbox(img)
    cropped = img.crop(bbox)

    # 方形化
    w, h = cropped.size
    side = max(w, h)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cropped, ((side - w) // 2, (side - h) // 2))

    # 缩放到画布内并留白
    inner = int(CANVAS * (1 - 2 * PAD_RATIO))
    square = square.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    off = (CANVAS - inner) // 2
    canvas.paste(square, (off, off))
    return canvas


def load_font(size: int):
    for name in ("msyh.ttc", "msyhbd.ttc", "arial.ttf", "seguiemj.ttf"):
        p = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def remove_corner_mark(img: Image.Image, verbose: bool = True) -> Image.Image:
    """去掉 AI 生图常见的右下角浅色水印。

    只在「该区域背景足够均匀、且确实存在明显亮于背景的像素簇」时才动手，
    避免误伤真实图形元素。
    """
    w, h = img.size
    box = (int(w * 0.60), int(h * 0.84), int(w * 0.98), int(h * 0.995))
    region = img.crop(box).convert("RGB")
    rw, rh = region.size
    px = region.load()

    lum = []
    for y in range(0, rh, 2):
        for x in range(0, rw, 2):
            r, g, b = px[x, y]
            lum.append((r + g + b) / 3)
    if not lum:
        return img
    lum_sorted = sorted(lum)
    med = lum_sorted[len(lum_sorted) // 2]

    bright = [(x, y) for y in range(rh) for x in range(rw)
              if (sum(px[x, y]) / 3) > med + 22]
    if len(bright) < 60:
        if verbose:
            print(f"[mark] 未检出水印（亮像素 {len(bright)}，区域中位亮度 {med:.0f}），跳过")
        return img

    xs = [p[0] for p in bright]
    ys = [p[1] for p in bright]
    span_x, span_y = max(xs) - min(xs), max(ys) - min(ys)
    if span_x > rw * 0.6 or span_y > rh * 0.6:
        if verbose:
            print(f"[mark] 亮区过大（{span_x}x{span_y}），判定为真实图形，跳过")
        return img

    # 用区域中位色覆盖亮像素及其邻域
    colors = sorted((px[x, y] for x, y in bright), key=sum)
    fill = colors[len(colors) // 2]
    out = img.copy()
    opx = out.load()
    ox, oy = box[0], box[1]
    pad = 2
    touched = 0
    for x, y in bright:
        for dy in range(-pad, pad + 1):
            for dx in range(-pad, pad + 1):
                tx, ty = x + dx, y + dy
                if 0 <= tx < rw and 0 <= ty < rh:
                    opx[ox + tx, oy + ty] = fill
                    touched += 1
    if verbose:
        print(f"[mark] 已抹除水印：{len(bright)} 个亮像素（范围 {span_x}x{span_y}），填充色 {fill}")
    return out


def build_sheet(items, out_path: str):
    """每种方案一行：128px 大图 + 64/48/32/16 逐级缩小。"""
    cols = [128, 64, 48, 32, 24, 16]
    margin = 40
    gap = 26
    row_h = 168
    label_w = 200
    sheet_w = label_w + margin * 2 + sum(cols) + gap * len(cols)
    sheet_h = margin * 2 + row_h * len(items)
    sheet = Image.new("RGB", (sheet_w, sheet_h), (246, 247, 250))
    d = ImageDraw.Draw(sheet)

    font_label = load_font(26)
    font_tiny = load_font(16)
    font_hdr = load_font(18)

    # 表头
    d.text((margin, 8), "方案", font=font_hdr, fill=(90, 96, 110))
    x = label_w + margin
    for c in cols:
        d.text((x, 8), f"{c}px", font=font_hdr, fill=(90, 96, 110))
        x += c + gap

    y = margin
    for name, img in items:
        d.text((margin, y + row_h // 2 - 18), name, font=font_label, fill=(30, 34, 44))
        x = label_w + margin
        for c in cols:
            thumb = img.resize((c, c), Image.LANCZOS)
            # 棋盘底便于看透明度
            for by in range(0, c, 8):
                for bx in range(0, c, 8):
                    col = (236, 238, 242) if ((bx // 8 + by // 8) % 2 == 0) else (255, 255, 255)
                    d.rectangle([x + bx, y + (row_h - c) // 2 + by,
                                 min(x + bx + 7, x + c - 1),
                                 min(y + (row_h - c) // 2 + by + 7, y + (row_h - c) // 2 + c - 1)],
                                fill=col)
            sheet.paste(thumb, (x + c // 2 - c // 2, y + (row_h - c) // 2), thumb)
            x += c + gap
        y += row_h

    d.text((margin, sheet_h - 26), "小尺寸缩略（16px 能认出轮廓 = 合格）", font=font_tiny, fill=(120, 126, 140))
    sheet.save(out_path)
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=".workbuddy/icon-candidates/ai")
    ap.add_argument("--out", default=None)
    ap.add_argument("--pick", default=None,
                    help="只处理文件名包含该子串的方案；命中后额外写出 icon.png / icon.ico")
    ap.add_argument("--dest", default="src-tauri/icons",
                    help="--pick 命中时正式图标的写入目录")
    ap.add_argument("--no-mark-clean", action="store_true", help="跳过水印抹除")
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    out = os.path.abspath(args.out or os.path.join(src, "normalized"))
    os.makedirs(out, exist_ok=True)

    items = []
    picked = None
    for name, p in discover(src):
        if args.pick and args.pick not in name:
            continue
        img = normalize(p)
        if not args.no_mark_clean:
            img = remove_corner_mark(img)
        png_out = os.path.join(out, f"icon-{name}.png")
        ico_out = os.path.join(out, f"icon-{name}.ico")
        img.save(png_out)
        img.save(ico_out, sizes=[(s, s) for s in ICO_SIZES])
        items.append((name, img))
        picked = (name, img)
        print(f"[ok] {name} -> {os.path.basename(png_out)} / {os.path.basename(ico_out)}")

    if args.pick and picked:
        name, img = picked
        dest = os.path.abspath(args.dest)
        os.makedirs(dest, exist_ok=True)
        # 备份旧图标（带时间戳，绝不覆盖同名备份）
        import shutil
        import time
        backup_dir = os.path.abspath(os.path.join(".workbuddy", "icon-backup"))
        os.makedirs(backup_dir, exist_ok=True)
        for f in ("icon.png", "icon.ico"):
            fsrc = os.path.join(dest, f)
            if os.path.exists(fsrc):
                shutil.copy2(fsrc, os.path.join(backup_dir, f"{int(time.time())}-{f}"))
                print(f"[backup] {f} -> .workbuddy/icon-backup/{int(time.time())}-{f}")
        img.save(os.path.join(dest, "icon.png"))
        img.save(os.path.join(dest, "icon.ico"), sizes=[(s, s) for s in ICO_SIZES])
        print(f"[apply] {name} 已写入 {dest}/icon.png + icon.ico")

        # 应用内（侧边栏品牌位 / favicon）用的透明版
        web_dir = os.path.abspath("public")
        os.makedirs(web_dir, exist_ok=True)
        web = img.resize((256, 256), Image.LANCZOS)
        web.save(os.path.join(web_dir, "app-icon.png"))
        print(f"[apply] 应用内图标 -> public/app-icon.png (256x256, 透明)")

    if items:
        # --pick 时写到 out 目录，避免覆盖目录下那张多方案对比图
        sheet_path = os.path.join(out, "preview-sheet.png") if args.pick \
            else os.path.join(src, "preview-sheet.png")
        sheet = build_sheet(items, sheet_path)
        print(f"[ok] 对比图 -> {sheet}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
