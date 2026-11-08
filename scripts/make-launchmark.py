#!/usr/bin/env python3
"""把 LaunchMark 画成 Σ。

历史：第一版路径画反了（少两个折角），出来像数字 5，已被推进仓库一次。
这里用 numpy 向量化重写，顺便把形状定义成一眼能核对的坐标。

Σ 骨架（y 向下）：
    右上 ──────── 左上
      │              ╲
      │               ╲ 尖角朝左
      │               ╱
      │              ╱
    右下 ──────── 左下
  两个短竖折角：上横右端向下、下横右端向上。
"""
import struct, zlib, os
import numpy as np
from PIL import Image, ImageDraw

SS = 4  # 超采样

def draw(size, ink):
    W = size * SS
    img = Image.new('L', (W, W), 0)
    d = ImageDraw.Draw(img)
    lw = max(1, int(round(0.082 * W)))

    xl, xr = 0.14, 0.86
    yt, yb = 0.16, 0.84
    yc = 0.50
    xm = 0.60
    drop = 0.10

    P = lambda x, y: (x * W, y * W)
    # 上横 + 右上折角
    d.line([P(xr, yt), P(xl, yt)], fill=255, width=lw, joint='curve')
    d.line([P(xr, yt), P(xr, yt + drop)], fill=255, width=lw)
    # 上斜 / 下斜（尖角在 xm）
    d.line([P(xl, yt), P(xm, yc)], fill=255, width=lw, joint='curve')
    d.line([P(xm, yc), P(xl, yb)], fill=255, width=lw, joint='curve')
    # 下横 + 右下折角
    d.line([P(xl, yb), P(xr, yb)], fill=255, width=lw, joint='curve')
    d.line([P(xr, yb), P(xr, yb - drop)], fill=255, width=lw)

    img = img.resize((size, size), Image.LANCZOS)
    a = np.array(img, dtype=np.uint8)
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = ink
    rgba[..., 3] = a
    return rgba

def write_png(path, rgba):
    Image.fromarray(rgba, 'RGBA').save(path)

def preview(rgba, cols=44):
    h, w = rgba.shape[:2]
    step = max(1, h//18); xs = max(1, w//cols)
    for y in range(0, h, step):
        print('  ' + ''.join('#' if rgba[y, x, 3] > 128 else ('+' if rgba[y, x, 3] > 40 else '.')
                             for x in range(0, w, xs)))

def main():
    base = 'app/DshIOS/Assets.xcassets/LaunchMark.imageset'
    jobs = [
        ('LaunchMark@2x.png', 144, (24, 24, 26)),
        ('LaunchMark@3x.png', 216, (24, 24, 26)),
        ('LaunchMark-Dark@2x.png', 144, (245, 245, 247)),
        ('LaunchMark-Dark@3x.png', 216, (245, 245, 247)),
    ]
    for name, size, ink in jobs:
        rgba = draw(size, ink)
        write_png(os.path.join(base, name), rgba)
        print('wrote', name)
        if name == 'LaunchMark@2x.png':
            preview(rgba)

if __name__ == '__main__':
    main()
