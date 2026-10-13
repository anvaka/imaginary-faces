# Face detection

`faceBoxes.json` at the repo root says where the face is in every image, so the
map can place each face on land instead of stretching the image over a country.
It is written once, offline, whenever a set of images is added:

```sh
python3 -m venv .venv && .venv/bin/pip install opencv-python numpy
curl -LO https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
.venv/bin/python detect_faces.py ../../public face_detection_yunet_2023mar.onnx boxes-with-scores.json
python3 site_json.py boxes-with-scores.json ../../faceBoxes.json
```

The detector (OpenCV YuNet) runs at three input sizes and keeps faces scoring
0.82 or more. It found all 353 Grok faces and 706 of 708 Midjourney faces;
images without a face fall back to the median face position.
