"""Writes smaller copies of every face image for progressive loading.

Usage: python3 scripts/make-sizes.py
Sizes are the width of one face on the map: 256 and 512 (the full size is 1024).
Midjourney images are 2x2 grids of four faces, so each face gets its own file,
<Country>-<quadrant>.webp, with quadrants numbered left to right, top to bottom.
"""
import os
from concurrent.futures import ProcessPoolExecutor
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', 'public')
SETS = [
    # (source folder, destination folder, faces across the image)
    ('images-small', 'faces/midjourney', 2),
    ('faces/grok-imagine-2', 'faces/grok-imagine-2', 1),
]
SIZES = [256, 512]


def convert(job):
    src, dst, size, across = job
    im = Image.open(src).convert('RGB')
    if across == 1:
        im.resize((size, size), Image.LANCZOS).save(dst, 'WEBP', quality=80, method=6)
        return os.path.getsize(dst)
    total = 0
    face = im.width // across
    for quadrant in range(across * across):
        x, y = quadrant % across * face, quadrant // across * face
        out = dst.replace('.webp', f'-{quadrant}.webp')
        im.crop((x, y, x + face, y + face)).resize((size, size), Image.LANCZOS).save(out, 'WEBP', quality=80, method=6)
        total += os.path.getsize(out)
    return total


def main():
    jobs = []
    for src_dir, dst_dir, across in SETS:
        for face_size in SIZES:
            out = os.path.join(ROOT, dst_dir, str(face_size))
            os.makedirs(out, exist_ok=True)
            for name in sorted(os.listdir(os.path.join(ROOT, src_dir))):
                if name.endswith('.webp'):
                    jobs.append((os.path.join(ROOT, src_dir, name), os.path.join(out, name), face_size, across))

    with ProcessPoolExecutor() as pool:
        total = sum(pool.map(convert, jobs, chunksize=8))
    print(f'{len(jobs)} images, {total / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
