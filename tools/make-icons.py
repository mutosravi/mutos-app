#!/usr/bin/env python3
"""Makes the app icons from assets/logo-original.png (navy logo on white): run after changing the logo."""
import pathlib
from PIL import Image
root = pathlib.Path(__file__).resolve().parent.parent
src = Image.open(root / 'assets' / 'logo-original.png').convert('RGBA')
# trim the white margin, keep it square
mask = src.convert('L').point(lambda v: 255 if v < 235 else 0)
l, t, r, b = mask.getbbox()
side = max(r - l, b - t); cx, cy = (l + r) // 2, (t + b) // 2
logo = Image.new('RGBA', (side, side), (255, 255, 255, 255))
logo.paste(src.crop((cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)), (0, 0))
def icon(size, fill, name):
    c = Image.new('RGB', (size, size), (255, 255, 255))
    n = round(size * fill)
    c.paste(logo.resize((n, n), Image.LANCZOS).convert('RGB'), ((size - n) // 2, (size - n) // 2))
    c.save(root / 'public' / name, optimize=True)
icon(180, .84, 'icon-180.png')        # iPhone home screen
icon(192, .84, 'icon-192.png')        # Android, browser tab
icon(512, .84, 'icon-512.png')
icon(512, .66, 'icon-maskable.png')   # Android shapes (circle, squircle) cut the edges, so the logo sits smaller
icon(64, .9, 'favicon.png')
# white logo for the sign-in page (dark background): ink becomes white, paper becomes transparent
g = logo.convert('L').resize((360, 360), Image.LANCZOS)
alpha = g.point(lambda v: 0 if v > 235 else min(255, round((235 - v) * 255 / 175)))
white = Image.new('RGBA', g.size, (255, 255, 255, 0)); white.putalpha(alpha)
white.save(root / 'public' / 'logo-white.png', optimize=True)
print('icons made')
