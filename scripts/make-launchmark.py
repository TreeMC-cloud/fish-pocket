#!/usr/bin/env python3
"""把 LaunchMark 画成 Σ。

上一轮的版本其实还是旧的 Z（两条横线 + 一道斜杠），系统启动屏一直显示它，
所以「换了 logo 却没换」的观感始终存在。这里用几何绘制，不依赖任何外部库。

Σ 的形状：上横、右上短竖折向左下、下横，中间一道斜线连接。
用超采样抗锯齿，保证在小尺寸和放大时都干净。
"""
import struct, zlib, sys, os

def draw(size, ink):
    SS = 4                      # 超采样倍数
    W = size * SS
    # 归一化坐标（0..1）下的 Σ 骨架，用多段折线描边
    # 上横：从右上到左上；斜：左上→中心→左下；下横：左下→右下
    lw = 0.085 * W              # 笔画宽度
    # 关键点（x, y），y 向下
    x0, x1 = 0.16 * W, 0.84 * W
    y0, y1 = 0.20 * W, 0.80 * W
    yc = 0.50 * W
    xm = 0.58 * W
    path = [
        [(x1, y0), (x0, y0)],                    # 上横
        [(x0, y0), (xm, yc)],                    # 上斜
        [(xm, yc), (x0, y1)],                    # 下斜
        [(x0, y1), (x1, y1)],                    # 下横
    ]

    img = bytearray(W * W * 4)   # RGBA，初始全透明

    def seg_dist(px, py, ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
        t = ((px - ax) * dx + (py - ay) * dy) / L2
        t = max(0.0, min(1.0, t))
        cx, cy = ax + t * dx, ay + t * dy
        return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5

    half = lw / 2
    r, g, b = ink
    for y in range(W):
        for x in range(W):
            d = min(
                seg_dist(x + 0.5, y + 0.5, seg[0][0], seg[0][1], seg[1][0], seg[1][1])
                for seg in path
            )
            if d <= half:
                a = 255
            elif d <= half + 1:
                a = int(255 * (half + 1 - d))
            else:
                a = 0
            if a:
                o = (y * W + x) * 4
                img[o], img[o+1], img[o+2], img[o+3] = r, g, b, a

    # 下采样到目标尺寸（盒式平均）
    out = bytearray(size * size * 4)
    n = SS * SS
    for y in range(size):
        for x in range(size):
            rr = gg = bb = aa = 0
            for dy in range(SS):
                for dx in range(SS):
                    o = ((y * SS + dy) * W + (x * SS + dx)) * 4
                    a = img[o+3]
                    rr += img[o] * a; gg += img[o+1] * a; bb += img[o+2] * a; aa += a
            o = (y * size + x) * 4
            if aa:
                out[o] = rr // aa; out[o+1] = gg // aa; out[o+2] = bb // aa; out[o+3] = aa // n
            else:
                out[o] = out[o+1] = out[o+2] = out[o+3] = 0
    return bytes(out), size

def write_png(path, pixels, size):
    raw = b''.join(b'\x00' + pixels[y*size*4:(y+1)*size*4] for y in range(size))
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)

def main():
    base = 'app/DshIOS/Assets.xcassets/LaunchMark.imageset'
    jobs = [
        ('LaunchMark@2x.png', 144, (24, 24, 26)),
        ('LaunchMark@3x.png', 216, (24, 24, 26)),
        ('LaunchMark-Dark@2x.png', 144, (245, 245, 247)),
        ('LaunchMark-Dark@3x.png', 216, (245, 245, 247)),
    ]
    for name, size, ink in jobs:
        px, s = draw(size, ink)
        write_png(os.path.join(base, name), px, s)
        print('wrote', name, size, 'x', size)

if __name__ == '__main__':
    main()
