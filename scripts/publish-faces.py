# Converts generated images to WebP under public/faces/<set>/ and prints the
# countries/variants that have no image (to list as unavailable in sources.js).
# Usage: python3 scripts/publish-faces.py explore/out-xai-full xai grok-imagine-2
import json, os, sys
from PIL import Image

src_dir, provider, set_name = sys.argv[1:4]
out_dir = os.path.join('public', 'faces', set_name)
os.makedirs(out_dir, exist_ok=True)
results = json.load(open(os.path.join(src_dir, 'results.json')))
missing = {}
total = 0
for e in results:
    if e['provider'] != provider:
        continue
    if 'error' in e:
        missing.setdefault(e['country'], []).append(e['gender'])
        continue
    target = os.path.join(out_dir, f"{e['country'].replace(' ', '_')}-{e['gender']}.webp")
    Image.open(os.path.join(src_dir, e['file'])).convert('RGB').save(target, 'WEBP', quality=82, method=6)
    total += os.path.getsize(target)
print(f'{len(os.listdir(out_dir))} images, {total / 1e6:.1f} MB in {out_dir}')
print('unavailable:', json.dumps(missing, sort_keys=True))
