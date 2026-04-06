#!/usr/bin/env python3
"""
Generates StreamRatings PNG icons using only Python stdlib (no Pillow needed).
Draws a gold star on a dark background at 16, 48, and 128px sizes.
"""

import struct
import zlib
import math
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def write_png(filename, width, height, pixels):
    """Encode a list of (R,G,B) tuples as a valid PNG file."""
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b""
    for y in range(height):
        raw += b"\x00"  # filter type: None
        for x in range(width):
            r, g, b = pixels[y * width + x]
            raw += bytes([r, g, b])

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    path = os.path.join(SCRIPT_DIR, filename)
    with open(path, "wb") as f:
        f.write(png)
    print(f"Generated {filename} ({width}x{height})")


def star_polygon(cx, cy, outer_r, inner_r, points=5):
    """Return (x, y) vertices of a star polygon."""
    vertices = []
    for i in range(points * 2):
        angle = math.pi / points * i - math.pi / 2
        r = outer_r if i % 2 == 0 else inner_r
        vertices.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return vertices


def point_in_polygon(px, py, polygon):
    """Ray-casting algorithm: True if (px, py) is inside the polygon."""
    n = len(polygon)
    inside = False
    x, y = px, py
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def render_icon(size):
    """Render a gold star on dark background at the given pixel size."""
    bg = (20, 20, 20)
    star_color = (245, 197, 24)    # #F5C518 — IMDB gold
    border_color = (30, 30, 30)

    cx, cy = size / 2, size / 2
    margin = size * 0.08
    outer_r = size / 2 - margin
    inner_r = outer_r * 0.42

    star = star_polygon(cx, cy, outer_r, inner_r)

    pixels = []
    for y in range(size):
        for x in range(size):
            if point_in_polygon(x + 0.5, y + 0.5, star):
                pixels.append(star_color)
            else:
                pixels.append(bg)

    return pixels


for size in [16, 48, 128]:
    pixels = render_icon(size)
    write_png(f"icon{size}.png", size, size, pixels)
