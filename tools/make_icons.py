#!/usr/bin/env python3
"""Generate PWA / apple-touch icons in pure Python (no external deps).

Draws a simple alpine-green Spikegolf mark: a green rounded tile with a white
ball and a little flag. Outputs PNGs at the sizes iOS / Android need.
"""
import struct
import zlib
import math
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def draw(size):
    """Return an RGBA bytearray for a size x size icon."""
    px = bytearray(size * size * 4)

    top = (0x2D, 0x6A, 0x4F)      # deep forest green
    bot = (0x40, 0x91, 0x60)      # lighter green
    ball = (0xF4, 0xFB, 0xF6)     # off-white
    ball_shadow = (0xC9, 0xE4, 0xD3)
    pole = (0x1B, 0x4B, 0x33)
    flag = (0xFF, 0x6B, 0x35)     # warm orange flag

    cx = size * 0.42
    cy = size * 0.60
    r = size * 0.20

    # flag geometry
    pole_x = size * 0.62
    pole_top = size * 0.24
    pole_bot = size * 0.66
    pole_w = max(1.0, size * 0.018)

    for y in range(size):
        t = y / (size - 1)
        bg = mix(top, bot, t)
        for x in range(size):
            i = (y * size + x) * 4
            rr, gg, bb = bg
            a = 255

            # ball
            dx = x - cx
            dy = y - cy
            dist = math.hypot(dx, dy)
            if dist <= r:
                shade = 0.5 + 0.5 * (-(dx + dy) / (r * 2))  # top-left light
                shade = max(0.0, min(1.0, shade))
                c = mix(ball_shadow, ball, shade)
                rr, gg, bb = c

            # flag pole
            if pole_top <= y <= pole_bot and abs(x - pole_x) <= pole_w:
                rr, gg, bb = pole

            # flag triangle (points right)
            fh = size * 0.16
            fw = size * 0.20
            fy0 = pole_top
            if pole_x <= x <= pole_x + fw and fy0 <= y <= fy0 + fh:
                local = (x - pole_x) / fw
                band = fh * (1 - local)
                if y <= fy0 + band:
                    rr, gg, bb = flag

            px[i] = rr
            px[i + 1] = gg
            px[i + 2] = bb
            px[i + 3] = a

    # rounded corners (transparent)
    radius = size * 0.22
    for y in range(size):
        for x in range(size):
            corner = None
            if x < radius and y < radius:
                corner = (radius, radius)
            elif x >= size - radius and y < radius:
                corner = (size - radius, radius)
            elif x < radius and y >= size - radius:
                corner = (radius, size - radius)
            elif x >= size - radius and y >= size - radius:
                corner = (size - radius, size - radius)
            if corner:
                if math.hypot(x - corner[0], y - corner[1]) > radius:
                    px[(y * size + x) * 4 + 3] = 0
    return px


def write_png(path, size):
    px = draw(size)
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0
        raw.extend(px[y * stride:(y + 1) * stride])
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + \
        chunk(b"IDAT", comp) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, size)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in (180, 192, 512):
        write_png(os.path.join(OUT, f"icon-{s}.png"), s)
