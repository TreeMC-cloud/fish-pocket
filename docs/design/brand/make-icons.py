#!/usr/bin/env python3
"""Build the app icon, launch mark and README mascot from mascot-icon.png.

Run from the repository root: docs/design/brand/make-icons.py
"""
from PIL import Image, ImageDraw, ImageOps

CATALOG = "app/DshIOS/Assets.xcassets/"


def rounded(image, size):
    """The drawing on a transparent canvas with the icon's corners, for use outside the app icon."""
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), size, fill=255)
    result = image.resize((size, size), Image.LANCZOS).convert("RGBA")
    result.putalpha(mask.resize((size, size), Image.LANCZOS))
    return result


icon = Image.open("docs/design/brand/mascot-icon.png").convert("RGB").resize((1024, 1024), Image.LANCZOS)
icons = CATALOG + "AppIcon.appiconset/"
icon.save(icons + "AppIcon.png", optimize=True)
icon.save(icons + "AppIcon-Dark.png", optimize=True)
ImageOps.grayscale(icon).save(icons + "AppIcon-Tinted.png", optimize=True)
icon.resize((192, 192), Image.LANCZOS).save("docs/assets/icon.png", optimize=True)
rounded(icon, 640).save("docs/assets/mascot.png", optimize=True)

for scale, suffix in [(2, "@2x"), (3, "@3x")]:
    mark = rounded(icon, 72 * scale)
    mark.save(CATALOG + f"LaunchMark.imageset/LaunchMark{suffix}.png", optimize=True)
    mark.save(CATALOG + f"LaunchMark.imageset/LaunchMark-Dark{suffix}.png", optimize=True)
