/**
 * Fenify ONNX inference — browser-side chess board image → FEN
 *
 * Architecture (notnil/fenify):
 *   Input:  [1, 3, 300, 300]  float32  (grayscale→3-channel, ImageNet-normalised)
 *   Output: [1, 64, 13]       float32  (64 squares × 13 piece classes)
 *
 * Piece class encoding  (_piece_from_int from board_predictor.py):
 *   0 = empty
 *   1=P  2=N  3=B  4=R  5=Q  6=K   (white, piece_type = ((i-1)%6)+1)
 *   7=p  8=n  9=b 10=r 11=q 12=k   (black, i > 6)
 *
 * Board ordering:
 *   squares[rank][file]  →  python-chess square = rank*8 + file
 *   rank 0 = a1-h1 (white back rank), rank 7 = a8-h8 (black back rank)
 *   FEN is built rank 7..0  (rank 8 first, as per FEN spec)
 *
 * Orientation assumption (stated Fenify limitation):
 *   Bottom-left of the board image = a1  (white plays from bottom — standard
 *   printed book orientation).  If the PDF has black at the bottom the caller
 *   should flip the board in the UI after inference.
 *
 * Model file:
 *   Served from /fenify/model.onnx  (excluded from git — generate it once
 *   with  scripts/convert_fenify_to_onnx.py).
 *   Override the URL by setting  NEXT_PUBLIC_FENIFY_MODEL_URL  in .env.local
 *   or in Vercel.
 */

import type { BBox } from "@/lib/types";

// ── constants ────────────────────────────────────────────────────────────────

const MODEL_SIZE = 300; // pixels — Fenify input square size
const DEFAULT_REMOTE_MODEL_URL =
  "https://huggingface.co/Westcoastrenmen/chess2pdf-fenify/resolve/main/model.onnx";
// ImageNet normalisation constants (channels R/G/B — all set to the grayscale value)
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

// Piece character lookup: index 0..12
// Matches _piece_from_int:  piece_type = ((i-1)%6)+1,  color = BLACK if i>6
const PIECE_CHARS = [
  "", // 0  empty
  "P", // 1  white pawn
  "N", // 2  white knight
  "B", // 3  white bishop
  "R", // 4  white rook
  "Q", // 5  white queen
  "K", // 6  white king
  "p", // 7  black pawn
  "n", // 8  black knight
  "b", // 9  black bishop
  "r", // 10 black rook
  "q", // 11 black queen
  "k", // 12 black king
] as const;

// ── module-level session cache ────────────────────────────────────────────────

type OrtSession = import("onnxruntime-web").InferenceSession;

let _session: OrtSession | null = null;
let _loadPromise: Promise<OrtSession | null> | null = null;
let _modelUnavailable = false; // set after the first failed load attempt

// ── public API ────────────────────────────────────────────────────────────────

/** Returns true once the ONNX session has been successfully loaded. */
export function isFenifyReady(): boolean {
  return _session !== null;
}

/**
 * Lazy-load the Fenify ONNX model.  Safe to call multiple times — subsequent
 * calls return the cached promise.  Returns null if the model file is absent
 * or the browser doesn't support WASM.
 */
export async function loadFenifyModel(): Promise<OrtSession | null> {
  if (_session !== null) return _session;
  if (_modelUnavailable) return null;
  if (_loadPromise !== null) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const ort = await import("onnxruntime-web");

      // Self-host the ORT WASM runtime so the strict CSP can keep all inference
      // assets on this origin. Override only if you intentionally host the
      // runtime elsewhere.
      const wasmBase =
        process.env.NEXT_PUBLIC_ORT_WASM_PATH ??
        "/ort/";
      ort.env.wasm.wasmPaths = wasmBase;

      const modelUrl =
        process.env.NEXT_PUBLIC_FENIFY_MODEL_URL ??
        (process.env.NODE_ENV === "production" ? DEFAULT_REMOTE_MODEL_URL : "/fenify/model.onnx");

      // Probe for the model file before trying to create a session (avoids a
      // confusing WASM crash when the file doesn't exist in dev)
      const probe = await fetch(modelUrl, { method: "HEAD" });
      if (!probe.ok) {
        // Model not deployed yet — silent fallback
        _modelUnavailable = true;
        return null;
      }

      _session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });

      return _session;
    } catch (err) {
      console.warn("[fenify] Model load failed — falling back to heuristic:", err);
      _modelUnavailable = true;
      return null;
    }
  })();

  return _loadPromise;
}

/**
 * Classify a cropped board region using the Fenify ONNX model.
 *
 * @param canvas  The full rendered PDF page canvas.
 * @param bbox    The bounding box of the detected board region on that canvas.
 * @returns  `{ fen, confidence }` or `null` if the model is not available.
 */
export async function classifyWithFenify(
  canvas: HTMLCanvasElement,
  bbox: BBox
): Promise<{ fen: string; confidence: number } | null> {
  const session = await loadFenifyModel();
  if (!session) return null;

  try {
    const ort = await import("onnxruntime-web");
    const inputData = preprocessBoard(canvas, bbox);
    const inputTensor = new ort.Tensor("float32", inputData, [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const feeds: Record<string, import("onnxruntime-web").Tensor> = {};
    feeds[session.inputNames[0]] = inputTensor;

    const results = await session.run(feeds);
    const outputTensor = results[session.outputNames[0]];

    // outputTensor.data is a Float32Array of length 1*64*13 = 832
    // Layout: [batch=0, square=0..63, class=0..12]  (row-major)
    const rawData = outputTensor.data as Float32Array;
    const numClasses = 13;

    // Argmax for each of the 64 squares
    const squarePieces: number[] = new Array(64);
    for (let sq = 0; sq < 64; sq++) {
      let bestClass = 0;
      let bestScore = rawData[sq * numClasses];
      for (let cls = 1; cls < numClasses; cls++) {
        const score = rawData[sq * numClasses + cls];
        if (score > bestScore) {
          bestScore = score;
          bestClass = cls;
        }
      }
      squarePieces[sq] = bestClass;
    }

    // Derive a confidence estimate from the average top-class margin
    const confidence = estimateConfidence(rawData, squarePieces, numClasses);
    const fen = buildFen(squarePieces);

    return { fen, confidence };
  } catch (err) {
    console.warn("[fenify] Inference error:", err);
    return null;
  }
}

// ── preprocessing ─────────────────────────────────────────────────────────────

/**
 * Crop the board region from `canvas`, resize to 300×300, convert to
 * grayscale (replicated across 3 channels), apply ImageNet normalisation,
 * and return a Float32Array in NCHW layout: [1, 3, 300, 300].
 */
function preprocessBoard(canvas: HTMLCanvasElement, bbox: BBox): Float32Array {
  // Step 1 — crop and resize to MODEL_SIZE×MODEL_SIZE
  const resized = document.createElement("canvas");
  resized.width = MODEL_SIZE;
  resized.height = MODEL_SIZE;
  const ctx = resized.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.drawImage(
    canvas,
    bbox.x,
    bbox.y,
    bbox.width,
    bbox.height,
    0,
    0,
    MODEL_SIZE,
    MODEL_SIZE
  );

  // Step 2 — get RGBA pixels
  const pixels = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data; // Uint8ClampedArray

  // Step 3 — build NCHW float tensor
  const numPixels = MODEL_SIZE * MODEL_SIZE;
  const tensor = new Float32Array(3 * numPixels);

  for (let i = 0; i < numPixels; i++) {
    const base = i * 4;
    // Standard luminance formula (matches torchvision.transforms.Grayscale)
    const gray =
      (0.299 * pixels[base] + 0.587 * pixels[base + 1] + 0.114 * pixels[base + 2]) / 255;
    // Apply ImageNet normalisation for each channel (all channels get the same gray value)
    tensor[i] = (gray - IMAGENET_MEAN[0]) / IMAGENET_STD[0]; // channel 0
    tensor[numPixels + i] = (gray - IMAGENET_MEAN[1]) / IMAGENET_STD[1]; // channel 1
    tensor[2 * numPixels + i] = (gray - IMAGENET_MEAN[2]) / IMAGENET_STD[2]; // channel 2
  }

  return tensor;
}

// ── post-processing ───────────────────────────────────────────────────────────

/**
 * Build a FEN position string from a flat array of 64 piece indices.
 *
 * Board ordering (mirrors Fenify's _post_process):
 *   squarePieces[rank*8 + file]  →  python-chess square  rank*8+file
 *   rank 0 = rank 1 (a1-h1), rank 7 = rank 8 (a8-h8)
 *   FEN iterates rank 7 → 0  (rank 8 first, standard FEN spec)
 */
function buildFen(squarePieces: number[]): string {
  const rows: string[] = [];

  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const pieceIdx = squarePieces[rank * 8 + file];
      const piece = PIECE_CHARS[pieceIdx] ?? "";
      if (!piece) {
        empty++;
      } else {
        if (empty > 0) {
          row += empty;
          empty = 0;
        }
        row += piece;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }

  // FEN side-to-move / castling etc. are set to defaults; the user can
  // correct castling rights / en-passant if needed.
  return `${rows.join("/")} w - - 0 1`;
}

/**
 * Compute a rough confidence score by averaging the softmax-max margin
 * (top class probability minus mean of remaining classes) for each square.
 * Occupancy of the board also factors in — very few pieces → lower confidence.
 */
function estimateConfidence(
  rawData: Float32Array,
  squarePieces: number[],
  numClasses: number
): number {
  let totalMargin = 0;
  const numSquares = 64;

  for (let sq = 0; sq < numSquares; sq++) {
    const base = sq * numClasses;
    const topClass = squarePieces[sq];
    const topScore = rawData[base + topClass];

    // Compute softmax numerator for gradient (simple max-based margin)
    let secondBest = -Infinity;
    for (let cls = 0; cls < numClasses; cls++) {
      if (cls !== topClass && rawData[base + cls] > secondBest) {
        secondBest = rawData[base + cls];
      }
    }
    totalMargin += Math.max(0, topScore - secondBest);
  }

  // Average margin normalised to a 0..1 confidence range
  // Clamp between 0.5 (Fenify was loaded and ran) and 0.95 (very high certainty)
  const avgMargin = totalMargin / numSquares;
  return Math.max(0.5, Math.min(0.95, 0.5 + avgMargin * 0.08));
}
