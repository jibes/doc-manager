# docaligner-lc100.onnx

Document corner detector from **DocAligner** by DocsaidLab
(<https://github.com/DocsaidLab/DocAligner>), heatmap-regression model with an
LCNet-100 backbone and BiFPN neck, 256x256 input. Distributed unmodified, as
published by the authors for their `docaligner-docsaid` Python package
(model file `lcnet100_h_e_bifpn_256_fp32.onnx`).

Licensed under the Apache License, Version 2.0; see `LICENSE-Apache-2.0.txt`
in this directory. Copyright DocsaidLab.

# ppocrv5-det.onnx, ppocrv5-latin-rec.onnx, ppocrv5-latin-dict.txt

Text detection and Latin-script text recognition models from **PaddleOCR**
(PP-OCRv5 mobile; <https://github.com/PaddlePaddle/PaddleOCR>), Copyright
PaddlePaddle Authors, licensed under the Apache License, Version 2.0 (see
`LICENSE-Apache-2.0.txt` in this directory). Distributed unmodified in the
ONNX conversions published at
<https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx> (`ppocrv5_det.onnx`) and
<https://huggingface.co/monkt/paddleocr-onnx> (`languages/latin/rec.onnx`,
`languages/latin/dict.txt`), both Apache-2.0.

# Checksums (SHA-256)

```
f4117b786e3a18470f3865c93f3c2bd69d9b998edd60f385574a5c665e79594e  docaligner-lc100.onnx
1eb7b4f7ab657ebd1c66d5f79bca7497f29768a2e3c15e52daecbba1a8e4a039  ppocrv5-det.onnx
614ffc2d6d3902d360fad7f1b0dd455ee45e877069d14c4e51a99dc4ef144409  ppocrv5-latin-rec.onnx
3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff  ppocrv5-latin-dict.txt
```

The service worker (`public/sw.js`) keeps them after first use and refreshes them in the background, so a
replaced model is used from the next scan on. They come from the doc-scanner app (jibes/doc-scanner).
