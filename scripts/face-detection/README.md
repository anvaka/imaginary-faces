# Face detection

`faceBoxes.json` at the repo root says where the face is in every image, so the
map can place each face on land instead of stretching the image over a country.
It is written once, offline, whenever a set of images is added:

```sh
python3 -m venv .venv && .venv/bin/pip install opencv-python
curl -LO https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
# Only the named sets are redone; without names, every set is
.venv/bin/python detect_faces.py ../../public face_detection_yunet_2023mar.onnx ../../faceBoxes.json <set>
```

The detector (OpenCV YuNet) runs at three input sizes and keeps faces scoring
0.82 or more, preferring the biggest. That is usually the person the image is
about, but not always: it also boxes dogs, phones, clothing patterns and
passers-by, and misses faces under a burqa or turned away. So every new set
gets checked by eye, and wrong boxes go into `corrections.json`, which the
script applies on every run. Images still without a face fall back to the
median face position.

The checked sets so far needed 22 corrections out of 1,764 faces, most of them
in Gemini's wide street scenes.
