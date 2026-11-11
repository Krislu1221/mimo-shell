#!/usr/bin/env python3
"""
Build the app icon from the official MiMo Code logo bitmap.

The wordmark is used exactly as supplied — no tracing, no pixel-art reduction,
no re-lettering. Downscaling is LANCZOS, which keeps the strokes clean all the
way down to 16px. (An earlier attempt rebuilt the letters as a 28×9 pixel
grid; it read as "OODE" at small sizes, which is why the bitmap is used
directly.)

The logo artwork is a white banner with notched bottom corners. It is placed
on the app's dark squircle so it reads as one piece.

usage: make-icon.py [source.png]
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"
MASTER = BUILD / "icon-master.png"
OUT_ICNS = BUILD / "icon.icns"

DEFAULT_SRC = Path.home() / "Downloads" / "图片 1.png"
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    os.environ.get("MIMO_ICON_SRC", str(DEFAULT_SRC))
)

CANVAS = 1024
CORNER = 228  # squircle radius, in canvas units
ART_WIDTH = 0.96  # artwork width as a fraction of the canvas

# iconset ladder: (pixel size, file name)
LADDER = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]


def build_master() -> Image.Image:
    """White squircle, artwork straight from the supplied logo.

    The source is a white banner with notched bottom corners; on a white
    ground that banner dissolves and what remains is the wordmark alone,
    which is the intended look.
    """
    master = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 255))

    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, CANVAS - 1, CANVAS - 1], radius=CORNER, fill=255
    )
    master.putalpha(mask)

    art = Image.open(SRC).convert("RGBA")
    w = int(CANVAS * ART_WIDTH)
    h = int(art.height * w / art.width)
    art = art.resize((w, h), Image.LANCZOS)
    master.alpha_composite(art, ((CANVAS - w) // 2, (CANVAS - h) // 2))

    # A hairline keeps the white badge from vanishing on a light background.
    edge = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [1, 1, CANVAS - 2, CANVAS - 2], radius=CORNER - 1, outline=(0, 0, 0, 18), width=2
    )
    master.alpha_composite(edge)
    return master


def main() -> int:
    if not SRC.exists():
        print(f"错误：找不到源图 {SRC}", file=sys.stderr)
        print("用法：make-icon.py <图片路径>", file=sys.stderr)
        return 1

    BUILD.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(ICONSET, ignore_errors=True)
    ICONSET.mkdir(parents=True)

    master = build_master()
    master.save(MASTER)
    print(f"✓ 主图 {MASTER}")

    for size, name in LADDER:
        master.resize((size, size), Image.LANCZOS).save(ICONSET / name)
    print(f"✓ {len(LADDER)} 档尺寸 → {ICONSET}")

    subprocess.run(
        ["/usr/bin/iconutil", "-c", "icns", str(ICONSET), "-o", str(OUT_ICNS)], check=True
    )
    print(f"✓ {OUT_ICNS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
