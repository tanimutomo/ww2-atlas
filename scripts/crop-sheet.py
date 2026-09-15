#!/usr/bin/env python3
"""小さい画像の座標系（既定 1400px 幅）で窓を切り、出力を必ず 1200px 幅に揃える。
大きいまま出すと表示側で縮められ、読んだ画素が縮尺ぶんずれる。
使い方: crop.py <jpg> <cx> <cy> <w> <h> <out> [small_w]
読んだ窓内の画素 (ix,iy) → 小画像座標:  px = x0 + ix/S,  py = y0 + iy/S   （S は下に出る）"""
import sys
from PIL import Image
OUT_W = 1200.0
f, cx, cy, w, h, out = sys.argv[1], *map(float, sys.argv[2:6]), sys.argv[6]
small_w = float(sys.argv[7]) if len(sys.argv) > 7 else 1400.0
im = Image.open(f); k = im.size[0]/small_w
x0, y0 = cx-w/2, cy-h/2
box = (int(x0*k), int(y0*k), int((cx+w/2)*k), int((cy+h/2)*k))
c = im.crop(box)
c = c.resize((int(OUT_W), int(OUT_W*c.size[1]/c.size[0])), Image.LANCZOS)
S = OUT_W/w
print(f"{out}  x0={x0} y0={y0}  S={S:.4f}  出力 {c.size[0]}x{c.size[1]}")
print(f"  戻し方: px = {x0} + ix/{S:.4f} ,  py = {y0} + iy/{S:.4f}")
c.save(out, quality=93)
