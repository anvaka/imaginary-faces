# Converts faceBoxes.json (per crop, with scores) into the file the site would
# ship: { "<image url>": [[x, y, w, h], ...] } in fractions of the whole image.
# Usage: python site_json.py <faceBoxes.json> <out.json>
import json
import sys

boxes = json.load(open(sys.argv[1]))
out = {}
for stem, people in boxes['grok-imagine-2'].items():
    for person, b in people.items():
        if b:
            out[f'faces/grok-imagine-2/{stem}-{person}.webp'] = [[round(v, 3) for v in b[:4]]]
for stem, quads in boxes['midjourney'].items():
    faces = []
    for q, b in enumerate(quads):
        if b:
            ox, oy = (q % 2) / 2, (q // 2) / 2
            faces.append([round(ox + b[0] / 2, 3), round(oy + b[1] / 2, 3), round(b[2] / 2, 3), round(b[3] / 2, 3)])
    out[f'images-small/{stem}.webp'] = faces
json.dump(out, open(sys.argv[2], 'w'), separators=(',', ':'))
