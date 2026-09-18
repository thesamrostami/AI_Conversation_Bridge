"""Generate extension icons (PNG) at 16/32/48/128/512 px.
Run: python tools/make-icons.py
"""
from PIL import Image, ImageDraw
import os

S = 1024  # render size, downsampled for anti-aliasing
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def gradient_tile(size, c1, c2, radius):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            px[x, y] = lerp(c1, c2, t) + (255,)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    return img

def bubble(draw, box, tail, fill, radius):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=radius, fill=fill)
    # tail: small triangle at bottom-left or top-right
    if tail == "bl":
        draw.polygon([(x0 + radius * 0.4, y1 - 4), (x0 + radius * 0.4, y1 + radius * 0.9), (x0 + radius * 1.5, y1 - 4)], fill=fill)
    else:
        draw.polygon([(x1 - radius * 0.4, y0 + 4), (x1 - radius * 0.4, y0 - radius * 0.9), (x1 - radius * 1.5, y0 + 4)], fill=fill)

def render():
    base = gradient_tile(S, (79, 70, 229), (13, 148, 136), radius=int(S * 0.22))  # indigo -> teal
    d = ImageDraw.Draw(base)
    white = (255, 255, 255, 255)
    soft = (255, 255, 255, 190)
    r = int(S * 0.09)
    # left/back bubble
    bubble(d, (S * 0.14, S * 0.22, S * 0.58, S * 0.52), "bl", soft, r)
    # right/front bubble
    bubble(d, (S * 0.42, S * 0.48, S * 0.86, S * 0.78), "tr", white, r)
    # bridge: thick arc connecting bubbles
    w = int(S * 0.055)
    d.arc((S * 0.30, S * 0.30, S * 0.72, S * 0.72), start=200, end=340, fill=white, width=w)
    # arrow head at end of arc (pointing right/down)
    ax, ay = S * 0.705, S * 0.445
    d.polygon([(ax - S * 0.07, ay - S * 0.03), (ax + S * 0.02, ay - S * 0.02), (ax - S * 0.035, ay + S * 0.06)], fill=white)
    # text lines inside front bubble
    for i, ln in enumerate((0.26, 0.18)):
        y = S * (0.57 + i * 0.07)
        d.rounded_rectangle((S * 0.49, y, S * (0.49 + ln), y + S * 0.03), radius=S * 0.015, fill=(13, 148, 136, 255))
    return base

img = render()
for size in (16, 32, 48, 128, 512):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))
print("icons written to", os.path.abspath(OUT))
