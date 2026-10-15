"""Render the bizinsights icons from the mark in src/components/Brand.tsx (MARK).

    python apps/web/scripts/make-icons.py        (from the repository root; needs Pillow)

Writes:
  apps/web/src/app/favicon.ico            16, 32 and 48 px, the rounded tile (icon.svg is the vector one)
  apps/web/src/app/apple-icon.png         180 px, full-bleed square (iOS rounds it itself)
  shopify-app/listing/app-icon-1200.png   Shopify App Store icon, plus a -sizes contact sheet

Shopify's listing spec: 1200 x 1200 PNG, the mark 750-900 px across with >= 75 px clear margin,
no text, and a full square (Shopify rounds the corners).

Everything is drawn at 8x and downsampled with LANCZOS for clean edges.
"""
import math
import re
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
SS = 8

TILE = (0x1B, 0x1C, 0x19)
TOP = (0x7B, 0xE3, 0xA8)
FOOT = (0x23, 0x93, 0x5C)

# MARK.bars, as SVG path data on the 28-unit grid, with each bar's opacity.
BARS = [
    ("M3 17a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2V23a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z", 0.75),
    ("M11 11.5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2V23a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z", 0.88),
    ("M19 9.4c0-1.4 1-2.6 2.4-2.9l2.1-.4c.8-.2 1.5.4 1.5 1.2V23c0 1.1-.9 2-2 2h-2c-1.1 0-2-.9-2-2z", 1.0),
]
# The bars' bounding box on the grid.
BOX = (3.0, 6.1, 25.0, 25.0)


def flatten(d, steps=24):
    """Points along an SVG path made of M, a (quarter circles), c, l, h, V and z, relative or absolute."""
    tokens = re.findall(r"[MmAaCcLlHhVvZz]|-?\d*\.?\d+", d)
    pts, i, cmd = [], 0, None
    x = y = 0.0

    def num():
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd in "Zz":
                continue
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            x, y = num(), num()
            pts.append((x, y))
        elif c == "L":
            dx, dy = num(), num()
            x, y = (x + dx, y + dy) if rel else (dx, dy)
            pts.append((x, y))
        elif c == "H":
            v = num()
            x = x + v if rel else v
            pts.append((x, y))
        elif c == "V":
            v = num()
            y = y + v if rel else v
            pts.append((x, y))
        elif c == "C":
            c1x, c1y, c2x, c2y, ex, ey = (num() for _ in range(6))
            if rel:
                c1x, c1y, c2x, c2y, ex, ey = c1x + x, c1y + y, c2x + x, c2y + y, ex + x, ey + y
            for s in range(1, steps + 1):
                t = s / steps
                u = 1 - t
                pts.append((
                    u**3 * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t**3 * ex,
                    u**3 * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t**3 * ey,
                ))
            x, y = ex, ey
        elif c == "A":
            # Only the clockwise quarter-circle corners the bars use: rx ry rot large sweep x y.
            r, _, _, _, _, ex, ey = (num() for _ in range(7))
            if rel:
                ex, ey = ex + x, ey + y
            # The centre is a corner of the quarter's square: the one the arc turns +90° around.
            for cx, cy in ((x, ey), (ex, y)):
                a0 = math.atan2(y - cy, x - cx)
                turn = (math.atan2(ey - cy, ex - cx) - a0 + math.pi) % (2 * math.pi) - math.pi
                if abs(turn - math.pi / 2) < 1e-6:
                    break
            for s in range(1, steps + 1):
                a = a0 + turn * s / steps
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
            x, y = ex, ey
    return pts


def mark(size, span, rounded):
    """The tile at `size` px with the mark `span` px across; `rounded` gives it MARK's corner radius."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    bg = ImageDraw.Draw(img)
    if rounded:
        bg.rounded_rectangle([0, 0, n - 1, n - 1], radius=n * 6.5 / 28, fill=TILE + (255,))
    else:
        bg.rectangle([0, 0, n - 1, n - 1], fill=TILE + (255,))

    k = span * SS / (BOX[2] - BOX[0])
    ox = n / 2 - (BOX[0] + BOX[2]) / 2 * k
    oy = n / 2 - (BOX[1] + BOX[3]) / 2 * k
    for d, opacity in BARS:
        poly = [(ox + px * k, oy + py * k) for px, py in flatten(d)]
        top = min(p[1] for p in poly)
        foot = max(p[1] for p in poly)
        shape = Image.new("L", (n, n), 0)
        ImageDraw.Draw(shape).polygon(poly, fill=255)
        fill = Image.new("RGBA", (n, n))
        rows = ImageDraw.Draw(fill)
        for row in range(int(top), int(foot) + 1):
            t = min(1.0, max(0.0, (row - top) / (foot - top)))
            rows.line([(0, row), (n, row)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, FOOT)) + (255,))
        alpha = shape.point(lambda v: round(v * opacity))
        img.paste(fill, (0, 0), alpha)
    return img.resize((size, size), Image.LANCZOS)


def main():
    app = ROOT / "apps/web/src/app"
    # Favicon: the tile as icon.svg draws it (mark 0.76 of the 22-unit box on a 28 tile).
    sizes = [16, 32, 48]
    ico = [mark(s, s * 22 * 0.76 / 28, rounded=True) for s in sizes]
    ico[-1].save(app / "favicon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=ico[:-1])
    mark(180, 180 * 0.62, rounded=False).convert("RGB").save(app / "apple-icon.png", optimize=True)

    listing = ROOT / "shopify-app/listing"
    icon = mark(1200, 820, rounded=False).convert("RGB")
    icon.save(listing / "app-icon-1200.png", optimize=True)
    sheet = Image.new("RGB", (600, 200), (255, 255, 255))
    x = 24
    for size in (160, 96, 64, 48, 32):
        sheet.paste(icon.resize((size, size), Image.LANCZOS), (x, 20 + (160 - size) // 2))
        x += size + 24
    sheet.save(listing / "app-icon-1200-sizes.png", optimize=True)
    print("wrote favicon.ico, apple-icon.png, app-icon-1200.png (+ sizes)")


if __name__ == "__main__":
    main()
