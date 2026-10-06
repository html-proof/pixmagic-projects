"""Render the Insights app icon to Shopify's App Store listing spec.

Spec (shopify.dev "App Store requirements" / "Visual design"):
  - 1200 x 1200 px, PNG
  - the mark occupies 750-900 px of the canvas
  - >= 75 px margin free of visual elements
  - no text, no screenshots, no Shopify trademarks
  - Shopify rounds the corners itself, so we ship a full square

The mark is three ascending pills that brighten as they rise: one idea, legible at 32 px.
Drawn at 4x and downsampled with LANCZOS for clean antialiasing.
"""
import sys
from PIL import Image, ImageDraw

S, N = 4, 1200
GREEN = (47, 111, 79)     # --accent  #2f6f4f
CREAM = (247, 247, 245)   # --bg      #f7f7f5

def sc(v):
    return int(round(v * S))

def mix(t):
    """t of the way from the background green to cream."""
    return tuple(int(round(a + t * (b - a))) for a, b in zip(GREEN, CREAM))

img = Image.new("RGB", (N * S, N * S), GREEN)
d = ImageDraw.Draw(img)

# mark: 750 px wide and 750 px tall, centred -> a 225 px clear margin on every side
BASE, BW = 975, 200
for x, top, t in ((225, 605, 0.45), (500, 415, 0.70), (775, 225, 1.0)):
    d.rounded_rectangle([sc(x), sc(top), sc(x + BW), sc(BASE)], radius=sc(BW / 2), fill=mix(t))

out = img.resize((N, N), Image.LANCZOS)
dest = sys.argv[1]
out.save(dest, "PNG", optimize=True)
print("wrote", dest, out.size, out.mode)

sheet = Image.new("RGB", (600, 200), (255, 255, 255))
x = 24
for size in (160, 96, 64, 48, 32):
    sheet.paste(out.resize((size, size), Image.LANCZOS), (x, 20 + (160 - size) // 2))
    x += size + 24
sheet.save(dest.replace(".png", "-sizes.png"), "PNG")
print("contact sheet written")
