#!/usr/bin/env python3
"""生成 WorkBench 应用图标（多方案可选），零第三方依赖。

为什么自己画：本机没有 Pillow；且图标必须在小尺寸（16/32px）下依然清晰，
用「高倍超采样 + 盒式降采样」自绘能精确控制形状，比拉一张位图再缩放靠谱。

用法：
    python scripts/gen-icons.py                     # 按 DEFAULT_VARIANT 写入 src-tauri/icons/
    python scripts/gen-icons.py -v panels           # 指定方案写入
    python scripts/gen-icons.py --all --out DIR     # 渲染全部候选 + 对比图到 DIR（供挑选）

产物（默认模式，覆盖 src-tauri/icons/）：
    icon.png   256x256 主图（bundle icon）
    icon.ico   多尺寸 ICO（16/24/32/48/64/128/256，PNG 压缩条目）

设计约束（改图标前请遵守）：
    - 全部形状以 0..1 归一化坐标描述，与渲染分辨率解耦。
    - 小尺寸可读性优先：最短笔画不低于 ~0.055（16px 下约 1px），别加细线。
    - ⛔ 不要再用「蓝底 + 白色字母」——与 Microsoft Office 视觉同构，易被误认成 Word。
"""

from __future__ import annotations

import argparse
import math
import os
import struct
import sys
import zlib

SIZE = 256
SS = 3  # 超采样倍数（渲染 3 倍后降采样，得到平滑边缘）
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
RADIUS = 0.24  # 圆角方块圆角半径（占边长比例）

WHITE = (0xFF, 0xFF, 0xFF)


# --------------------------------------------------------------------------
# 几何 / 颜色基础件（全部吃 0..1 归一化坐标）
# --------------------------------------------------------------------------


def rrect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    """点是否落在圆角矩形内（把点夹到内缩矩形再比距离，标准 SDF 判定）。"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    """点到线段的距离。"""
    dx, dy = bx - ax, by - ay
    d2 = dx * dx + dy * dy
    t = 0.0 if d2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / d2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def grad(c0, c1):
    """竖直渐变（y=0 → c0，y=1 → c1）。"""

    def f(x: float, y: float):
        return (
            c0[0] + (c1[0] - c0[0]) * y,
            c0[1] + (c1[1] - c0[1]) * y,
            c0[2] + (c1[2] - c0[2]) * y,
        )

    return f


def solid(c):
    return lambda x, y: (float(c[0]), float(c[1]), float(c[2]))


def l_rect(x0, y0, x1, y1, r, color, t=1.0):
    """圆角矩形图层。返回 (r,g,b,不透明度)。"""

    def f(x, y):
        if rrect(x, y, x0, y0, x1, y1, r):
            return (float(color[0]), float(color[1]), float(color[2]), t)
        return None

    return f


def l_circle(cx, cy, rad, color, t=1.0):
    r2 = rad * rad

    def f(x, y):
        if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
            return (float(color[0]), float(color[1]), float(color[2]), t)
        return None

    return f


def l_capsule(ax, ay, bx, by, w, color, t=1.0):
    """圆头粗线段（用于笔画/连线）。"""
    half = w / 2.0

    def f(x, y):
        if seg_dist(x, y, ax, ay, bx, by) <= half:
            return (float(color[0]), float(color[1]), float(color[2]), t)
        return None

    return f


def l_erase(inner, bg):
    """把 inner 命中的区域用背景色填掉（做「凹槽」用）。"""

    def f(x, y):
        if inner(x, y) is None:
            return None
        r, g, b = bg(x, y)
        return (r, g, b, 1.0)

    return f


# --------------------------------------------------------------------------
# 方案定义
# --------------------------------------------------------------------------


class Design:
    """一个图标方案 = 圆角方块底 + 若干图层（自底向上叠加）。"""

    def __init__(self, key: str, title: str, bg, layers):
        self.key = key
        self.title = title
        self.bg = bg
        self.layers = layers

    def shade(self, x: float, y: float):
        if not rrect(x, y, 0.0, 0.0, 1.0, 1.0, RADIUS):
            return (0, 0, 0, 0.0)
        r, g, b = self.bg(x, y)
        for layer in self.layers:
            c = layer(x, y)
            if c is None:
                continue
            cr, cg, cb, t = c
            if t >= 1.0:
                r, g, b = cr, cg, cb
            else:
                r = r * (1 - t) + cr * t
                g = g * (1 - t) + cg * t
                b = b * (1 - t) + cb * t
        return (r, g, b, 1.0)


def _d_current():
    """现状：蓝底 + 白色 W（保留作为对照，⛔ 不再作为新设计起点）。"""
    bg = solid((0x00, 0x64, 0xE0))
    iw, ih = 0.50, 0.36
    x0, y0 = (1 - iw) / 2, (1 - ih) / 2
    pts = [
        (x0 + 0.02 * iw, y0 + 0.04 * ih),
        (x0 + 0.28 * iw, y0 + 1.00 * ih),
        (x0 + 0.50 * iw, y0 + 0.34 * ih),
        (x0 + 0.72 * iw, y0 + 1.00 * ih),
        (x0 + 0.98 * iw, y0 + 0.04 * ih),
    ]
    w = 0.175 * iw
    layers = [l_capsule(*pts[i], *pts[i + 1], w, WHITE) for i in range(len(pts) - 1)]
    return Design("w", "蓝底白 W（现状，与 Word 撞脸）", bg, layers)


def _tiles(x0, y0, x1, y1, gap, r, specs):
    """按 2x2 网格铺四块圆角矩形。specs 为 [(color, t) x4]，顺序：左上/右上/左下/右下。"""
    w = (x1 - x0 - gap) / 2
    h = (y1 - y0 - gap) / 2
    boxes = [
        (x0, y0, x0 + w, y0 + h),
        (x0 + w + gap, y0, x1, y0 + h),
        (x0, y0 + h + gap, x0 + w, y1),
        (x0 + w + gap, y0 + h + gap, x1, y1),
    ]
    return [
        l_rect(bx0, by0, bx1, by1, r, color, t)
        for (bx0, by0, bx1, by1), (color, t) in zip(boxes, specs)
    ]


def _d_panels():
    """面板网格：2x2 卡片，对角高亮 —— 直译「数据中心 / 插件卡片」。"""
    bg = grad((0x8B, 0x5C, 0xF6), (0x4F, 0x46, 0xE5))
    layers = _tiles(
        0.215, 0.215, 0.785, 0.785, 0.085, 0.055,
        [(WHITE, 0.95), (WHITE, 0.45), (WHITE, 0.45), (WHITE, 0.95)],
    )
    return Design("panels", "面板网格（紫罗兰）", bg, layers)


def _d_cards():
    """卡片叠层：三张错位白卡 —— 表达「多面板并置的工作台」。"""
    bg = grad((0x2D, 0xD4, 0xBF), (0x0D, 0x94, 0x88))
    cw, ch, r = 0.50, 0.34, 0.06
    specs = [((0.33, 0.17), 0.42), ((0.255, 0.305), 0.72), ((0.18, 0.44), 1.0)]
    layers = [l_rect(cx, cy, cx + cw, cy + ch, r, WHITE, t) for (cx, cy), t in specs]
    return Design("cards", "卡片叠层（青绿）", bg, layers)


def _d_nodes():
    """插件节点：中心枢纽 + 三个卫星节点，粗连线 —— 表达「插件挂载」。"""
    bg = grad((0x1E, 0x29, 0x3B), (0x0B, 0x12, 0x20))
    cyan = (0x22, 0xD3, 0xEE)
    cx, cy = 0.5, 0.5
    sats = [(0.50, 0.200), (0.230, 0.710), (0.770, 0.710)]
    layers = [l_capsule(cx, cy, sx, sy, 0.075, cyan, 0.85) for sx, sy in sats]
    layers += [l_circle(sx, sy, 0.115, cyan, 1.0) for sx, sy in sats]
    layers.append(l_circle(cx, cy, 0.150, WHITE, 1.0))
    return Design("nodes", "插件节点（深空 + 青）", bg, layers)


def _d_puzzle():
    """拼图插件：白色拼图块（上凸 + 右凹）—— 最直白的「插件」。"""
    bg = grad((0xFB, 0xBF, 0x24), (0xF9, 0x73, 0x16))
    body = l_rect(0.20, 0.24, 0.80, 0.84, 0.075, WHITE)
    knob = l_circle(0.50, 0.24, 0.130, WHITE)
    notch = l_erase(l_circle(0.80, 0.560, 0.105, WHITE), bg)
    return Design("puzzle", "拼图插件（琥珀）", bg, [body, knob, notch])


def _d_bars():
    """柱状数据：三根递增圆头柱 —— 表达「信息统计」。"""
    bg = grad((0x34, 0xD3, 0x99), (0x05, 0x96, 0x69))
    base = 0.735
    spec = [((0.315, 0.560), 0.55), ((0.500, 0.415), 0.78), ((0.685, 0.270), 1.0)]
    layers = []
    for (bx, ty), t in spec:
        layers.append(l_capsule(bx, base, bx, ty, 0.135, WHITE, t))
    return Design("bars", "柱状数据（翡翠绿）", bg, layers)


def _d_window():
    """工作台窗口：白窗 + 三个色点 + 两条内容条 —— 表达「桌面应用本体」。"""
    bg = grad((0xFB, 0x71, 0x85), (0xE1, 0x1D, 0x48))
    rose = (0xE1, 0x1D, 0x48)
    layers = [
        l_rect(0.19, 0.23, 0.81, 0.77, 0.075, WHITE),
        l_circle(0.295, 0.335, 0.031, rose),
        l_circle(0.375, 0.335, 0.031, rose),
        l_circle(0.455, 0.335, 0.031, rose),
        l_rect(0.285, 0.475, 0.615, 0.545, 0.030, rose),
        l_rect(0.285, 0.610, 0.500, 0.680, 0.030, rose),
    ]
    return Design("window", "工作台窗口（玫红）", bg, layers)


def _d_dash():
    """仪表盘：深色底 + 一大两小彩色块 —— 彩色块比纯白块在 16px 下辨识度高得多。"""
    bg = grad((0x1E, 0x29, 0x3B), (0x0F, 0x17, 0x2A))
    cyan = (0x22, 0xD3, 0xEE)
    violet = (0xA7, 0x8B, 0xFA)
    amber = (0xFB, 0xBF, 0x24)
    layers = [
        l_rect(0.210, 0.210, 0.505, 0.790, 0.060, cyan),
        l_rect(0.545, 0.210, 0.790, 0.480, 0.060, violet),
        l_rect(0.545, 0.520, 0.790, 0.790, 0.060, amber),
    ]
    return Design("dash", "仪表盘（深色 + 三色块）", bg, layers)


VARIANTS: dict[str, Design] = {
    d.key: d
    for d in [
        _d_current(),
        _d_panels(),
        _d_cards(),
        _d_nodes(),
        _d_puzzle(),
        _d_bars(),
        _d_window(),
        _d_dash(),
    ]
}

# 当前生效方案。挑定新图标后把这里改成对应 key，再跑一次默认模式即可「安装」。
DEFAULT_VARIANT = "w"


# --------------------------------------------------------------------------
# 渲染 / 编码
# --------------------------------------------------------------------------


def render(size: int, ss: int, design: Design):
    """渲染 size×size 的 RGBA 图（内部 ss 倍超采样后盒式降采样）。"""
    hi = size * ss
    total = float(ss * ss)
    acc = [[0, 0, 0, 0] for _ in range(size * size)]
    inv = 1.0 / hi
    shade = design.shade
    for hy in range(hi):
        y = (hy + 0.5) * inv
        rowbase = (hy // ss) * size
        for hx in range(hi):
            x = (hx + 0.5) * inv
            r, g, b, a = shade(x, y)
            if a <= 0.0:
                continue
            c = acc[rowbase + hx // ss]
            c[0] += r
            c[1] += g
            c[2] += b
            c[3] += 1

    out = []
    for yy in range(size):
        row = []
        base = yy * size
        for xx in range(size):
            sr, sg, sb, cnt = acc[base + xx]
            if cnt == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append(
                    (
                        int(sr / cnt + 0.5),
                        int(sg / cnt + 0.5),
                        int(sb / cnt + 0.5),
                        int(cnt / total * 255 + 0.5),
                    )
                )
        out.append(row)
    return out


def resize(master, dst: int):
    """从主图（SIZE）盒式缩放到 dst。"""
    if dst == SIZE:
        return master
    step = SIZE / dst
    out = []
    for y in range(dst):
        row = []
        y0 = int(y * step)
        y1 = max(y0 + 1, int((y + 1) * step))
        for x in range(dst):
            x0 = int(x * step)
            x1 = max(x0 + 1, int((x + 1) * step))
            sr = sg = sb = sa = n = 0
            for yy in range(y0, min(y1, SIZE)):
                mrow = master[yy]
                for xx in range(x0, min(x1, SIZE)):
                    r, g, b, a = mrow[xx]
                    sr += r * a
                    sg += g * a
                    sb += b * a
                    sa += a
                    n += 1
            if sa == 0 or n == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((sr // sa, sg // sa, sb // sa, sa // n))
        out.append(row)
    return out


def png(rows) -> bytes:
    """编码为 PNG（RGBA / 8bit，逐行 filter=0）。"""
    h = len(rows)
    w = len(rows[0])
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((int(r), int(g), int(b), int(a)))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def ico(images) -> bytes:
    """多尺寸 ICO（每个条目内嵌 PNG，Vista+ 支持）。"""
    header = struct.pack("<HHH", 0, 1, len(images))
    entries, payloads, offset = b"", b"", 6 + 16 * len(images)
    for size, data in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        payloads += data
        offset += len(data)
    return header + entries + payloads


# --------------------------------------------------------------------------
# 对比图（把候选并排画在一张 PNG 上，方便一眼取舍）
# --------------------------------------------------------------------------

# 5x7 点阵数字，只用于给对比图编号（本机无字体渲染能力）
_DIGITS = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
}


def _draw_digit(canvas, ox, oy, digit, scale, color):
    pat = _DIGITS.get(digit)
    if not pat:
        return
    for gy, line in enumerate(pat):
        for gx, ch in enumerate(line):
            if ch != "1":
                continue
            for dy in range(scale):
                py = oy + gy * scale + dy
                if py < 0 or py >= len(canvas):
                    continue
                row = canvas[py]
                for dx in range(scale):
                    px = ox + gx * scale + dx
                    if 0 <= px < len(row):
                        row[px] = color


def _blank(w, h, color):
    return [[color for _ in range(w)] for _ in range(h)]


def _paste(canvas, img, ox, oy, w, h):
    for y in range(h):
        irow = img[y]
        crow = canvas[oy + y]
        for x in range(w):
            r, g, b, a = irow[x]
            if a == 0:
                continue
            if a >= 255:
                crow[ox + x] = (int(r), int(g), int(b))
            else:
                cr, cg, cb = crow[ox + x]
                t = a / 255.0
                crow[ox + x] = (
                    int(cr * (1 - t) + r * t + 0.5),
                    int(cg * (1 - t) + g * t + 0.5),
                    int(cb * (1 - t) + b * t + 0.5),
                )


def contact_sheet(designs, masters, out_path):
    """把各方案按 3 列网格排成一张对比图，左上角标序号。"""
    cell, pad, cols = 176, 12, 3
    icon = 144
    rows = (len(designs) + cols - 1) // cols
    w = pad + cols * (cell + pad)
    h = pad + rows * (cell + pad)
    canvas = _blank(w, h, (241, 245, 249))
    # 每格画一个浅色底板，便于看清图标边界
    for i, d in enumerate(designs):
        cx = pad + (i % cols) * (cell + pad)
        cy = pad + (i // cols) * (cell + pad)
        for y in range(cell):
            row = canvas[cy + y]
            for x in range(cell):
                row[cx + x] = (226, 232, 240)
        img = resize(masters[d.key], icon)
        _paste(canvas, img, cx + (cell - icon) // 2, cy + (cell - icon) // 2, icon, icon)
        _draw_digit(canvas, None, cx + 8, cy + 8, str(i + 1), 3, (30, 41, 59))
    with open(out_path, "wb") as f:
        f.write(png([[(r, g, b, 255) for r, g, b in row] for row in canvas]))
    return w, h


def size_strip(designs, masters, out_path, sizes=(16, 24, 32, 48, 64)):
    """每个方案一行，展示各小尺寸下的实际效果（可读性体检）。"""
    label_w, cell, pad = 26, 72, 10
    w = label_w + len(sizes) * (cell + pad) + pad
    h = pad + len(designs) * (cell + pad)
    canvas = _blank(w, h, (226, 232, 240))
    for i, d in enumerate(designs):
        y = pad + i * (cell + pad)
        _draw_digit(canvas, None, pad, y + cell // 2 - 10, str(i + 1), 3, (30, 41, 59))
        for j, s in enumerate(sizes):
            img = resize(masters[d.key], s)
            ox = label_w + j * (cell + pad) + (cell - s) // 2
            oy = y + cell - s - 6
            _paste(canvas, img, ox, oy, s, s)
    with open(out_path, "wb") as f:
        f.write(png([[(r, g, b, 255) for r, g, b in row] for row in canvas]))
    return w, h


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------


def _icons_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "src-tauri", "icons"))


def _install(design: Design) -> int:
    d = _icons_dir()
    if not os.path.isdir(d):
        print(f"icons dir not found: {d}", file=sys.stderr)
        return 1
    print(f"rendering [{design.key}] {design.title} {SIZE}x{SIZE} (supersample x{SS}) ...")
    master = render(SIZE, SS, design)
    with open(os.path.join(d, "icon.png"), "wb") as f:
        f.write(png(master))
    print("wrote icon.png (256x256)")
    entries = [(s, png(resize(master, s))) for s in ICO_SIZES]
    with open(os.path.join(d, "icon.ico"), "wb") as f:
        f.write(ico(entries))
    print(f"wrote icon.ico ({'/'.join(str(s) for s in ICO_SIZES)})")
    return 0


def _render_all(out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    designs = list(VARIANTS.values())
    masters = {}
    for i, d in enumerate(designs):
        print(f"[{i + 1}/{len(designs)}] {d.key:8s} {d.title}")
        masters[d.key] = render(SIZE, SS, d)
        stem = f"{i + 1}-{d.key}"
        with open(os.path.join(out_dir, stem + ".png"), "wb") as f:
            f.write(png(masters[d.key]))
        entries = [(s, png(resize(masters[d.key], s))) for s in ICO_SIZES]
        with open(os.path.join(out_dir, stem + ".ico"), "wb") as f:
            f.write(ico(entries))

    w, h = contact_sheet(designs, masters, os.path.join(out_dir, "contact-sheet.png"))
    print(f"wrote contact-sheet.png ({w}x{h})")
    w, h = size_strip(designs, masters, os.path.join(out_dir, "small-sizes.png"))
    print(f"wrote small-sizes.png ({w}x{h})")
    print("\n方案顺序：")
    for i, d in enumerate(designs):
        print(f"  {i + 1}. {d.key:8s} {d.title}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 WorkBench 应用图标")
    ap.add_argument("-v", "--variant", choices=sorted(VARIANTS), help="指定方案写入 src-tauri/icons/")
    ap.add_argument("--all", action="store_true", help="渲染全部候选方案到 --out 目录")
    ap.add_argument("--out", default=".workbuddy/icon-candidates", help="候选方案输出目录")
    args = ap.parse_args()

    if args.all:
        return _render_all(args.out)
    return _install(VARIANTS[args.variant or DEFAULT_VARIANT])


if __name__ == "__main__":
    raise SystemExit(main())
