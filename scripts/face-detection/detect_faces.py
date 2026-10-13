# Detects the main face in every map image with OpenCV's YuNet and writes
# face boxes as fractions of the part of the image the map shows (the crop).
# Usage: python detect_faces.py <public dir> <yunet.onnx> <out.json> [debug dir]
import json
import sys
from pathlib import Path

import cv2
import numpy as np

public, model_path, out_path = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
debug_dir = Path(sys.argv[4]) if len(sys.argv) > 4 else None
SCORE = 0.82

detector = cv2.FaceDetectorYN.create(model_path, "", (320, 320), SCORE, 0.3, 50)


def detect(img):
    """Best face as [x, y, w, h, score] in fractions of img, or None."""
    h, w = img.shape[:2]
    best = None
    # Several input sizes: big close-up faces are missed at full resolution
    for size in (320, 640, 1024):
        scale = size / max(w, h)
        small = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        detector.setInputSize((small.shape[1], small.shape[0]))
        _, faces = detector.detect(small)
        if faces is None:
            continue
        for f in faces:
            x, y, fw, fh, score = f[0] / scale, f[1] / scale, f[2] / scale, f[3] / scale, float(f[14])
            # Prefer big, confident faces: the subject, not people in the background
            rank = score * fw * fh
            if best is None or rank > best[0]:
                best = (rank, [x / w, y / h, fw / w, fh / h, score])
    return best and best[1]


def clamp_box(b):
    x, y, w, h, s = b
    x0, y0 = max(0.0, x), max(0.0, y)
    x1, y1 = min(1.0, x + w), min(1.0, y + h)
    return [round(float(v), 3) for v in (x0, y0, x1 - x0, y1 - y0)] + [round(float(s), 2)]


result = {"grok-imagine-2": {}, "midjourney": {}}
stats = {"grok-imagine-2": [0, 0], "midjourney": [0, 0]}
misses = []

for path in sorted((public / "faces" / "grok-imagine-2").glob("*.webp")):
    country, person = path.stem.rsplit("-", 1)
    img = cv2.imread(str(path))
    box = detect(img)
    stats["grok-imagine-2"][1] += 1
    if box:
        stats["grok-imagine-2"][0] += 1
        result["grok-imagine-2"].setdefault(country, {})[person] = clamp_box(box)
    else:
        result["grok-imagine-2"].setdefault(country, {})[person] = None
        misses.append(f"grok/{path.stem}")
    if debug_dir and box:
        pass

for path in sorted((public / "images-small").glob("*.webp")):
    img = cv2.imread(str(path))
    H, W = img.shape[:2]
    quads = []
    for q in range(4):
        x0, y0 = (q % 2) * W // 2, (q // 2) * H // 2
        crop = img[y0:y0 + H // 2, x0:x0 + W // 2]
        box = detect(crop)
        stats["midjourney"][1] += 1
        if box:
            stats["midjourney"][0] += 1
        else:
            misses.append(f"mj/{path.stem}/q{q}")
        quads.append(clamp_box(box) if box else None)
    result["midjourney"][path.stem] = quads

out_path.write_text(json.dumps(result, separators=(",", ":")))
for k, (hit, total) in stats.items():
    print(f"{k}: {hit}/{total} = {hit / total:.1%}")
print("misses:", len(misses))
print("\n".join(misses))
