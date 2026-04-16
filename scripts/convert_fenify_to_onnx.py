#!/usr/bin/env python3
"""
Download the Fenify model weights and export them to ONNX format for use
in Chess2pdf's browser-based inference (via onnxruntime-web).

Requirements:
  pip install torch torchvision onnx onnxruntime

Usage:
  python scripts/convert_fenify_to_onnx.py

Output:
  public/fenify/model.onnx   (~120 MB, FP32)

The model file is excluded from git (.gitignore).  Once generated, it must
be deployed separately (e.g. Vercel Blob, Hugging Face Hub, GitHub Release)
or served locally from public/fenify/.

For production, set the env var:
  NEXT_PUBLIC_FENIFY_MODEL_URL=https://your-cdn/model.onnx

Background — Fenify model spec (notnil/fenify):
  Input:  [1, 3, 300, 300]  float32  (grayscale→3ch, ImageNet-normalised)
  Output: [1, 64, 13]       float32  (64 squares × 13 piece classes)
  Piece classes: 0=empty, 1=P, 2=N, 3=B, 4=R, 5=Q, 6=K,
                             7=p, 8=n, 9=b, 10=r, 11=q, 12=k
"""

import argparse
import os
import urllib.request
import sys

MODEL_URL = (
    "https://github.com/notnil/fenify/releases/download/v2023-07-10/"
    "models_2023-07-10-chessboard-2D-balanced-fen-cpu.pt"
)
MODEL_CACHE = "scripts/fenify_cpu.pt"
OUTPUT_DIR = "public/fenify"
OUTPUT_ONNX = os.path.join(OUTPUT_DIR, "model.onnx")
INPUT_SHAPE = (1, 3, 300, 300)


def _reporthook(block_num: int, block_size: int, total_size: int) -> None:
    if total_size <= 0:
        return
    pct = min(100, block_num * block_size * 100 // total_size)
    sys.stdout.write(f"\r  Downloading … {pct}%")
    sys.stdout.flush()


def download_model() -> None:
    if os.path.exists(MODEL_CACHE):
        print(f"Cached weights found → {MODEL_CACHE}")
        return
    print(f"Downloading Fenify weights (~121 MB) from GitHub Releases …")
    urllib.request.urlretrieve(MODEL_URL, MODEL_CACHE, _reporthook)
    print()
    print(f"Saved to {MODEL_CACHE}")


def export_onnx(model_path: str) -> None:
    try:
        import torch
    except ImportError:
        sys.exit("torch not found. Run: pip install torch torchvision")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("Loading TorchScript model …")
    model = torch.jit.load(model_path, map_location="cpu")
    model.eval()

    dummy = torch.zeros(*INPUT_SHAPE)

    print(f"Exporting to ONNX (opset 17) → {OUTPUT_ONNX} …")
    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy,
            OUTPUT_ONNX,
            opset_version=17,
            input_names=["input"],
            output_names=["output"],
            # Fixed batch=1; no dynamic axes needed for inference
        )

    # Verify the exported model
    try:
        import onnx

        onnx_model = onnx.load(OUTPUT_ONNX)
        onnx.checker.check_model(onnx_model)
        size_mb = os.path.getsize(OUTPUT_ONNX) / 1024 / 1024
        print(f"\n✓ ONNX model verified — {OUTPUT_ONNX}  ({size_mb:.0f} MB)")

        for inp in onnx_model.graph.input:
            dims = [d.dim_value for d in inp.type.tensor_type.shape.dim]
            print(f"  input  '{inp.name}': {dims}")
        for out in onnx_model.graph.output:
            dims = [d.dim_value for d in out.type.tensor_type.shape.dim]
            print(f"  output '{out.name}': {dims}")
    except ImportError:
        print("onnx package not installed — skipping model verification (non-fatal).")

    # Optionally run a quick OnnxRuntime inference check
    try:
        import onnxruntime as ort
        import numpy as np

        print("\nRunning quick OnnxRuntime inference check …")
        sess = ort.InferenceSession(OUTPUT_ONNX, providers=["CPUExecutionProvider"])
        dummy_np = np.zeros(INPUT_SHAPE, dtype=np.float32)
        outputs = sess.run(None, {"input": dummy_np})
        print(f"  Output shape: {outputs[0].shape}  ← expected [1, 64, 13]")
        assert outputs[0].shape == (1, 64, 13), (
            f"Unexpected output shape {outputs[0].shape}. "
            "Please open an issue on the Chess2pdf repo."
        )
        print("✓ Inference check passed.")
    except ImportError:
        print("onnxruntime not installed — skipping inference check (non-fatal).")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help=f"Skip downloading — use existing {MODEL_CACHE}",
    )
    parser.add_argument(
        "--model",
        default=MODEL_CACHE,
        help="Path to a pre-downloaded .pt weights file",
    )
    args = parser.parse_args()

    model_path = args.model if args.skip_download else MODEL_CACHE

    if not args.skip_download:
        download_model()

    if not os.path.exists(model_path):
        sys.exit(f"Model file not found: {model_path}\n"
                 "Re-run without --skip-download to download it.")

    export_onnx(model_path)

    print(
        "\nNext steps:\n"
        f"  • local dev:    model is now at {OUTPUT_ONNX}\n"
        "  • production:   host model.onnx on a CDN and set\n"
        "                  NEXT_PUBLIC_FENIFY_MODEL_URL=<url> in Vercel"
    )


if __name__ == "__main__":
    main()
