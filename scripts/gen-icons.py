#!/usr/bin/env python3
"""生成 WorkBench 应用图标（圆角方块 + 白色 W），零第三方依赖。

为什么自己画：仓库里原先只有 32x32 的纯色占位图，托盘/任务栏放大后发糊。
这里用「高倍渲染 + 盒式降采样」自绘一套多尺寸图标，避免引入 Pillow。

用法：
    python scripts/gen-icons.py

产物（覆盖 src-tauri/icons/）：
    icon.png   256x256 主图（bundle icon）
    icon.ico   多尺寸 ICO（16/24/32/48/64/128/256，PNG 压缩条目）
"""

from __future__ import annotations

import math
import os
import struct
import sys
import zlib

ACCENT = (0x00, 0x64, 0xE0)  # 与 tokens.css --accent 一致
WHITE = (0xFF, 0xFF, 0xFF)
SIZE = 256
SS = 3  # 超采样倍数（渲染 3 倍后降采样，得到平滑边缘）

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def _rounded_rect_inside(x: float, y: float, w: float, h: float, r: float) -> bool:
    """圆角矩形内部判定（标准 SDF：把点夹到内缩矩形再比距离）。"""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    """点到线段的距离。"""
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)


def _render_master(size: int, ss: int) -> list[list[tuple[int, int, int, int]]]:
    """渲染 size*size 的 RGBA 主图（内部按 ss 倍超采样）。"""
    hi = size * ss
    # 圆角方块
    radius = 0.24 * hi

    # W 的骨架（单位化后映射到中心区域）
    iw, ih = 0.50 * hi, 0.36 * hi
    x0, y0 = (hi - iw) / 2, (hi - ih) / 2
    pts = [
        (x0 + 0.02 * iw, y0 + 0.04 * ih),
        (x0 + 0.28 * iw, y0 + 1.00 * ih),
        (x0 + 0.50 * iw, y0 + 0.34 * ih),
        (x0 + 0.72 * iw, y0 + 1.00 * ih),
        (x0 + 0.98 * iw, y0 + 0.04 * ih),
    ]
    half = 0.5 * 0.175 * iw  # 笔画半宽

    # 1) 超采样渲染成覆盖计数（每像素记录 bg / fg 的命中次数）
    bg = [0] * (size * size)
    fg = [0] * (size * size)
    for hy in range(hi):
        y = hy + 0.5
        row_ok = y < hi
        for hx in range(hi):
            if not row_ok:
                break
            x = hx + 0.5
            idx = (hy // ss) * size + (hx // ss)
            if not _rounded_rect_inside(x, y, hi, hi, radius):
                continue
            bg[idx] += 1
            # W 在方块内部，命中即判为前景
            d = min(
                _seg_dist(x, y, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1)
            )
            if d <= half:
                fg[idx] += 1

    # 2) 盒式降采样 → 每像素归一化 alpha
    total = ss * ss
    out: list[list[tuple[int, int, int, int]]] = []
    for y in range(size):
        row = []
        for x in range(size):
            i = y * size + x
            b, f = bg[i], fg[i]
            if b == 0:
                row.append((0, 0, 0, 0))
                continue
            a = int(round(255 * b / total))
            if f == 0:
                row.append((*ACCENT, a))
            else:
                # 前景覆盖率 = f / b，据此在强调色与白色之间插值
                cov = min(1.0, f / b)
                rgb = tuple(int(round(ACCENT[c] * (1 - cov) + WHITE[c] * cov)) for c in range(3))
                row.append((rgb[0], rgb[1], rgb[2], a))
        out.append(row)
    return out


def _resize(master: list[list[tuple[int, int, int, int]]], dst: int):
    """从主图（SIZE）盒式缩放到 dst（dst <= SIZE）。"""
    if dst == SIZE:
        return master
    step = SIZE / dst
    out = []
    for y in range(dst):
        row = []
        y0, y1 = int(y * step), max(int(y * step) + 1, int((y + 1) * step))
        for x in range(dst):
            x0, x1 = int(x * step), max(int(x * step) + 1, int((x + 1) * step))
            sr = sg = sb = sa = n = 0
            for yy in range(y0, min(y1, SIZE)):
                for xx in range(x0, min(x1, SIZE)):
                    r, g, b, a = master[yy][xx]
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


def _png(rows: list[list[tuple[int, int, int, int]]]) -> bytes:
    """编码为 PNG（RGBA / 8bit，逐行 filter=0）。"""
    h = len(rows)
    w = len(rows[0])
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

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


def _ico(images: list[tuple[int, bytes]]) -> bytes:
    """多尺寸 ICO（每个条目内嵌 PNG，Vista+ 支持）。"""
    header = struct.pack("<HHH", 0, 1, len(images))
    entries, payloads, offset = b"", b"", 6 + 16 * len(images)
    for size, data in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack(
            "<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset
        )
        payloads += data
        offset += len(data)
    return header + entries + payloads


def main() -> int:
    icons_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "icons")
    icons_dir = os.path.normpath(icons_dir)
    if not os.path.isdir(icons_dir):
        print(f"icons dir not found: {icons_dir}", file=sys.stderr)
        return 1

    print(f"rendering {SIZE}x{SIZE} (supersample x{SS}) ...")
    master = _render_master(SIZE, SS)

    png256 = _png(master)
    with open(os.path.join(icons_dir, "icon.png"), "wb") as f:
        f.write(png256)
    print("wrote icon.png (256x256)")

    entries = [(s, _png(_resize(master, s))) for s in ICO_SIZES]
    with open(os.path.join(icons_dir, "icon.ico"), "wb") as f:
        f.write(_ico(entries))
    print(f"wrote icon.ico ({'/'.join(str(s) for s in ICO_SIZES)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
