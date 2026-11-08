"""Shrink oversized PNG artwork in place (same file names, so no code changes).

The quality badges, award logos and addon badges shipped as 1248x1248 / 2468px-tall PNGs
(65-95 MB in total) but are drawn at 20-100 CSS px. Each image is capped at a size that is
still sharp at 3x device pixel ratio, then saved optimised; flat artwork is also reduced to a
256-colour palette when that is smaller. Re-run after adding new artwork:
    python3 scripts/shrink-images.py
"""

import io
import os
import sys

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

# folder -> (max dimension in px, palette allowed)
RULES = {
    "src/assets/badges": (288, True),  # drawn at <= 90 CSS px wide
    "src/assets/addon-badges": (288, True),
    "src/assets/addon-logos": (256, True),  # logos <= 64 CSS px
    "public/awards": (400, True),  # award logos <= ~105 CSS px tall
    "public/avatars": (384, False),
    "public/services": (384, True),
    "src/assets/theme-previews": (720, False),  # settings thumbnails
    "src/assets/preview": (960, False),
    "src/assets/onboarding": (960, False),
    "src/assets": (512, False),  # loose files (default avatar ...)
}
MIN_BYTES = 120 * 1024


def rule_for(rel_dir):
    best = None
    for folder, rule in RULES.items():
        if rel_dir == folder or rel_dir.startswith(folder + "/"):
            if best is None or len(folder) > len(best[0]):
                best = (folder, rule)
    return best[1] if best else None


def encode(im, palette):
    out = io.BytesIO()
    im.save(out, "PNG", optimize=True)
    best = out.getvalue()
    if palette:
        q = im.convert("RGBA").quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        out2 = io.BytesIO()
        q.save(out2, "PNG", optimize=True)
        if len(out2.getvalue()) < len(best):
            best = out2.getvalue()
    return best


def main():
    before = after = changed = 0
    for top in ("src", "public"):
        for dirpath, _, files in os.walk(os.path.join(ROOT, top)):
            rel_dir = os.path.relpath(dirpath, ROOT).replace(os.sep, "/")
            rule = rule_for(rel_dir)
            if not rule:
                continue
            cap, palette = rule
            for name in files:
                if not name.lower().endswith(".png"):
                    continue
                path = os.path.join(dirpath, name)
                size = os.path.getsize(path)
                if size < MIN_BYTES:
                    continue
                im = Image.open(path)
                im.load()
                w, h = im.size
                scale = min(1.0, cap / max(w, h))
                if scale < 1.0:
                    im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
                data = encode(im, palette)
                before += size
                if len(data) < size:
                    with open(path, "wb") as f:
                        f.write(data)
                    after += len(data)
                    changed += 1
                else:
                    after += size
    print(f"[shrink-images] {changed} files: {before / 1048576:.1f} MB -> {after / 1048576:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
