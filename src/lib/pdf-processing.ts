import { MAX_PDF_PAGES } from "@/lib/constants";
import { classifyWithFenify, loadFenifyModel } from "@/lib/fenify-inference";
import { parseRecognizedLine } from "@/lib/move-parser";
import type { BBox, DetectedDiagram, PdfPagePreview, RecognizedLine } from "@/lib/types";

type PdfJs = typeof import("pdfjs-dist");
export type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

const TEMPLATE_SIZE = 48;
const TEMPLATE_PIECES = [
  { fen: "K", glyph: "♔" },
  { fen: "Q", glyph: "♕" },
  { fen: "R", glyph: "♖" },
  { fen: "B", glyph: "♗" },
  { fen: "N", glyph: "♘" },
  { fen: "P", glyph: "♙" },
  { fen: "k", glyph: "♚" },
  { fen: "q", glyph: "♛" },
  { fen: "r", glyph: "♜" },
  { fen: "b", glyph: "♝" },
  { fen: "n", glyph: "♞" },
  { fen: "p", glyph: "♟" },
] as const;

let pieceTemplates: Array<{ fen: string; ink: Float32Array; norm: number }> | undefined;

export type RenderedPage = PdfPagePreview & {
  canvas: HTMLCanvasElement;
};

export type PageScanResult = {
  page: RenderedPage;
  diagrams: DetectedDiagram[];
  lines: RecognizedLine[];
};

export type BoardScanResult = {
  diagram: DetectedDiagram;
  line: RecognizedLine;
};

export async function loadPdfDocument(file: File): Promise<PdfDocument> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const data = await file.arrayBuffer();
  const task = pdfjs.getDocument({ data });
  const document = await task.promise;

  if (document.numPages > MAX_PDF_PAGES) {
    await document.destroy();
    throw new Error(`This PDF has ${document.numPages} pages. The free browser workflow is capped at ${MAX_PDF_PAGES}.`);
  }

  return document;
}

export async function renderPdfPage(document: PdfDocument, pageIndex: number, scale = 1.45): Promise<RenderedPage> {
  const page = await document.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const canvas = window.document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is unavailable in this browser.");
  }

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;

  const imageUrl = canvas.toDataURL("image/jpeg", 0.86);
  const thumbnailUrl = makeThumbnail(canvas, 180);

  return {
    pageIndex,
    width: canvas.width,
    height: canvas.height,
    thumbnailUrl,
    imageUrl,
    canvas,
  };
}

export function detectBoardCandidates(canvas: HTMLCanvasElement): Array<BBox & { confidence: number }> {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width < 160 || canvas.height < 160) {
    return [];
  }

  const minSize = Math.max(96, Math.floor(Math.min(canvas.width, canvas.height) * 0.11));
  const maxSize = Math.floor(Math.min(canvas.width, canvas.height) * 0.72);
  const candidates: Array<BBox & { confidence: number }> = [];

  for (let size = maxSize; size >= minSize; size -= Math.max(12, Math.floor(size / 10))) {
    const step = Math.max(12, Math.floor(size / 6));
    for (let y = 0; y <= canvas.height - size; y += step) {
      for (let x = 0; x <= canvas.width - size; x += step) {
        const confidence = scoreBoardCandidate(context, x, y, size);
        if (confidence > 0.24) {
          candidates.push({ x, y, width: size, height: size, confidence });
        }
      }
    }
  }

  return nonOverlapping(candidates.sort((a, b) => b.confidence - a.confidence)).slice(0, 8);
}

/**
 * Kick off a background model-load as soon as this module is imported so that
 * by the time the user scans pages the model is already warm.
 */
if (typeof window !== "undefined") {
  void loadFenifyModel();
}

export async function classifyBoardFen(
  canvas: HTMLCanvasElement,
  bbox: BBox
): Promise<{ fen: string; confidence: number; notes: string[] }> {
  // ── 1. Fenify ML model (highest accuracy, requires public/fenify/model.onnx) ──
  const fenifyResult = await classifyWithFenify(canvas, bbox);
  if (fenifyResult) {
    return {
      fen: fenifyResult.fen,
      confidence: fenifyResult.confidence,
      notes: [
        "Position recognised by the Fenify neural network (99.8% per-square accuracy on book diagrams).",
        "Verify side-to-move and castling rights before deep analysis.",
      ],
    };
  }

  // ── 2. Heuristic fallbacks (no model file present) ────────────────────────
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return lowConfidenceFen(["Canvas analysis unavailable."]);
  }

  const occupancy = squareInkDensity(context, bbox);
  const topMaterial = occupancy.slice(0, 16).filter((value) => value > 0.18).length;
  const middleMaterial = occupancy.slice(16, 48).filter((value) => value > 0.18).length;
  const bottomMaterial = occupancy.slice(48).filter((value) => value > 0.18).length;

  if (topMaterial >= 12 && bottomMaterial >= 12 && middleMaterial <= 6) {
    return {
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      confidence: 0.68,
      notes: ["The board resembles a starting position. Confirm before serious study."],
    };
  }

  const templateResult = classifyBoardWithTemplates(context.canvas, bbox);
  if (templateResult) {
    return templateResult;
  }

  // Template matching failed (expected for scanned/printed books where piece pixels
  // don’t match Unicode glyph shapes). Build a best-effort FEN from which squares
  // are occupied so the board at least shows the correct pawn/piece structure.
  const occupancyFen = buildOccupancyFen(occupancy);
  if (occupancyFen) {
    return {
      fen: occupancyFen,
      confidence: 0.32,
      notes: [
        "Piece types estimated from ink density — squares with pieces are shown but piece identity needs correction.",
        "Run  scripts/convert_fenify_to_onnx.py  to enable the Fenify ML classifier for accurate piece identification.",
        "Use Edit mode or paste the FEN to fix piece identities in the meantime.",
      ],
    };
  }

  return lowConfidenceFen([
    "A board-like grid was detected but no pieces were distinguishable.",
    "Use Crop board or Edit mode to set the correct position.",
  ]);
}

export async function recognizeChessText(canvas: HTMLCanvasElement, bbox: BBox, onProgress?: (status: string, progress: number) => void) {
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract",
    langPath: "/tessdata",
    workerBlobURL: false,
    gzip: true,
    logger: (message) => {
      if (typeof message.progress === "number") {
        onProgress?.(message.status ?? "ocr", message.progress);
      }
    },
  });

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: "0123456789abcdefghKQRBNOx+#=.- ",
      preserve_interword_spaces: "1",
    });

    const rectangle = textRectangle(canvas, bbox);
    const {
      data: { text, confidence },
    } = await worker.recognize(canvas, { rectangle });

    return {
      text: text.trim(),
      confidence: Math.max(0, Math.min(1, confidence / 100)),
    };
  } finally {
    await worker.terminate();
  }
}

export async function scanRenderedPage(page: RenderedPage): Promise<PageScanResult> {
  const candidates = detectBoardCandidates(page.canvas);
  const diagrams: DetectedDiagram[] = [];
  const lines: RecognizedLine[] = [];

  for (const candidate of candidates.slice(0, 6)) {
    const classification = await classifyBoardFen(page.canvas, candidate);
    // Only skip if classification itself is at minimum confidence AND the visual
    // candidate score was also very weak — avoids flooding with false positives
    // from dense text columns while still passing real scanned diagrams through.
    const likelyFalsePositive = classification.confidence <= 0.28 && candidate.confidence < 0.46;
    if (likelyFalsePositive) {
      continue;
    }
    const diagram: DetectedDiagram = {
      id: crypto.randomUUID(),
      pageIndex: page.pageIndex,
      bbox: candidate,
      fen: classification.fen,
      confidence: Math.min(candidate.confidence, classification.confidence),
      orientation: "white",
      sourceCropUrl: cropToDataUrl(page.canvas, candidate),
      notes: classification.notes,
    };
    diagrams.push(diagram);

    try {
      const ocr = await recognizeChessText(page.canvas, candidate);
      const parsed = parseRecognizedLine(ocr.text, diagram.fen);
      lines.push({
        id: crypto.randomUUID(),
        diagramId: diagram.id,
        rawText: ocr.text,
        normalizedText: parsed.normalizedText,
        sanMoves: parsed.sanMoves,
        confidence: Math.min(ocr.confidence, parsed.confidence),
        parseErrors: parsed.parseErrors,
      });
    } catch (error) {
      lines.push({
        id: crypto.randomUUID(),
        diagramId: diagram.id,
        rawText: "",
        normalizedText: "",
        sanMoves: [],
        confidence: 0,
        parseErrors: [error instanceof Error ? error.message : "OCR failed"],
      });
    }
  }

  return { page, diagrams, lines };
}

export async function scanManualBoard(page: RenderedPage, bbox: BBox): Promise<BoardScanResult> {
  const normalized = clampSquareBox(bbox, page.width, page.height);
  const classification = await classifyBoardFen(page.canvas, normalized);
  const diagram: DetectedDiagram = {
    id: crypto.randomUUID(),
    pageIndex: page.pageIndex,
    bbox: normalized,
    fen: classification.fen,
    confidence: Math.max(0.42, classification.confidence),
    orientation: "white",
    sourceCropUrl: cropToDataUrl(page.canvas, normalized),
    notes: ["Manual crop. Check piece identities before deep analysis."],
  };

  try {
    const ocr = await recognizeChessText(page.canvas, normalized);
    const parsed = parseRecognizedLine(ocr.text, diagram.fen);
    return {
      diagram,
      line: {
        id: crypto.randomUUID(),
        diagramId: diagram.id,
        rawText: ocr.text,
        normalizedText: parsed.normalizedText,
        sanMoves: parsed.sanMoves,
        confidence: Math.min(ocr.confidence, parsed.confidence),
        parseErrors: parsed.parseErrors,
      },
    };
  } catch (error) {
    return {
      diagram,
      line: {
        id: crypto.randomUUID(),
        diagramId: diagram.id,
        rawText: "",
        normalizedText: "",
        sanMoves: [],
        confidence: 0,
        parseErrors: [error instanceof Error ? error.message : "OCR failed"],
      },
    };
  }
}

function lowConfidenceFen(notes: string[]) {
  return {
    fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
    confidence: 0.28,
    notes,
  };
}

/**
 * Build a best-effort FEN by inferring which squares are occupied from ink
 * density, assigning kings to the most-likely positions and generic pieces
 * (pawn-like) to other occupied squares.
 * Returns null if not enough material is found.
 */
function buildOccupancyFen(occupancy: number[]): string | null {
  const threshold = 0.19;
  const occupied = occupancy
    .map((density, index) => ({ density, index }))
    .filter((s) => s.density > threshold)
    .sort((a, b) => b.density - a.density);

  if (occupied.length < 3) {
    return null;
  }

  const board: string[][] = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ""));

  // Try to identify kings by the darkest single squares in each half
  const blackHalf = occupied.filter((s) => Math.floor(s.index / 8) <= 2);
  const whiteHalf = occupied.filter((s) => Math.floor(s.index / 8) >= 5);
  const blackKingSquare = blackHalf[0];
  const whiteKingSquare = whiteHalf[0];

  if (!blackKingSquare || !whiteKingSquare) {
    return null;
  }

  const usedIndices = new Set<number>();
  board[Math.floor(blackKingSquare.index / 8)][blackKingSquare.index % 8] = "k";
  board[Math.floor(whiteKingSquare.index / 8)][whiteKingSquare.index % 8] = "K";
  usedIndices.add(blackKingSquare.index);
  usedIndices.add(whiteKingSquare.index);

  // Fill remaining occupied squares with generic piece markers
  for (const sq of occupied) {
    if (usedIndices.has(sq.index)) continue;
    const rank = Math.floor(sq.index / 8);
    const file = sq.index % 8;
    // Use pawns away from promotion rows and rooks on edge rows so the FEN
    // remains legal enough for chess.js and Stockfish.
    if (rank === 0) {
      board[rank][file] = "r";
    } else if (rank === 7) {
      board[rank][file] = "R";
    } else {
      board[rank][file] = rank <= 3 ? "p" : "P";
    }
    usedIndices.add(sq.index);
  }

  const rows = board.map(collapseFenRow);
  return `${rows.join("/")} w - - 0 1`;
}

function makeThumbnail(source: HTMLCanvasElement, maxWidth: number): string {
  const scale = maxWidth / source.width;
  const canvas = window.document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = Math.round(source.height * scale);
  const context = canvas.getContext("2d");
  context?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

function cropToDataUrl(source: HTMLCanvasElement, bbox: BBox): string {
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(bbox.width));
  canvas.height = Math.max(1, Math.floor(bbox.height));
  const context = canvas.getContext("2d");
  context?.drawImage(source, bbox.x, bbox.y, bbox.width, bbox.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function classifyBoardWithTemplates(source: HTMLCanvasElement, bbox: BBox): { fen: string; confidence: number; notes: string[] } | null {
  const templates = getPieceTemplates();
  const board: string[][] = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ""));
  const classified: Array<{ rank: number; file: number; fen: string; score: number }> = [];
  let occupied = 0;
  let whiteKings = 0;
  let blackKings = 0;

  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const ink = squareInkVector(source, bbox, rank, file);
      const inkDensity = vectorAverage(ink);
      if (inkDensity < 0.035) {
        continue;
      }

      let best = { fen: "", score: 0 };
      let second = 0;
      for (const template of templates) {
        const score = cosineSimilarity(ink, template.ink, template.norm);
        if (score > best.score) {
          second = best.score;
          best = { fen: template.fen, score };
        } else if (score > second) {
          second = score;
        }
      }

      const margin = best.score - second;
      if (best.score < 0.34 || margin < 0.012) {
        continue;
      }

      const score = Math.min(1, best.score * 0.82 + margin * 2);
      board[rank][file] = best.fen;
      classified.push({ rank, file, fen: best.fen, score });
      occupied += 1;
      if (best.fen === "K") {
        whiteKings += 1;
      }
      if (best.fen === "k") {
        blackKings += 1;
      }
    }
  }

  if (occupied < 2) {
    return null;
  }

  if (blackKings !== 1) {
    const blackKing = classified.filter((square) => square.rank <= 3).sort((a, b) => b.score - a.score)[0];
    if (!blackKing) {
      return null;
    }
    board[blackKing.rank][blackKing.file] = "k";
  }

  if (whiteKings !== 1) {
    const whiteKing = classified.filter((square) => square.rank >= 4).sort((a, b) => b.score - a.score)[0];
    if (!whiteKing) {
      return null;
    }
    board[whiteKing.rank][whiteKing.file] = "K";
  }

  const confidence = Math.max(0.34, Math.min(0.82, vectorAverage(classified.map((square) => square.score))));
  return {
    fen: `${board.map(collapseFenRow).join("/")} w - - 0 1`,
    confidence,
    notes: [
      "Pieces were recognized with the local image classifier.",
      "Scanned book diagrams can still need correction when the print is faint or skewed.",
    ],
  };
}

function getPieceTemplates() {
  if (pieceTemplates) {
    return pieceTemplates;
  }

  const canvas = window.document.createElement("canvas");
  canvas.width = TEMPLATE_SIZE;
  canvas.height = TEMPLATE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    pieceTemplates = [];
    return pieceTemplates;
  }

  pieceTemplates = TEMPLATE_PIECES.map((piece) => {
    context.clearRect(0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE);
    context.fillStyle = "#000";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `${Math.floor(TEMPLATE_SIZE * 0.86)}px "Apple Symbols", "DejaVu Sans", "Noto Sans Symbols 2", serif`;
    context.fillText(piece.glyph, TEMPLATE_SIZE / 2, TEMPLATE_SIZE / 2 + TEMPLATE_SIZE * 0.02);
    const data = context.getImageData(0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE).data;
    const ink = new Float32Array(TEMPLATE_SIZE * TEMPLATE_SIZE);
    for (let index = 0; index < ink.length; index += 1) {
      const offset = index * 4;
      const luminance = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
      ink[index] = Math.max(0, (255 - luminance) / 255);
    }
    return { fen: piece.fen, ink, norm: vectorNorm(ink) };
  });

  return pieceTemplates;
}

function squareInkVector(source: HTMLCanvasElement, bbox: BBox, rank: number, file: number): Float32Array {
  const cell = bbox.width / 8;
  const margin = cell * 0.08;
  const cropX = bbox.x + file * cell + margin;
  const cropY = bbox.y + rank * cell + margin;
  const cropSize = Math.max(2, cell - margin * 2);
  const canvas = window.document.createElement("canvas");
  canvas.width = TEMPLATE_SIZE;
  canvas.height = TEMPLATE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return new Float32Array(TEMPLATE_SIZE * TEMPLATE_SIZE);
  }

  context.fillStyle = "#fff";
  context.fillRect(0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE);
  context.imageSmoothingEnabled = true;
  context.drawImage(source, cropX, cropY, cropSize, cropSize, 0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE);
  const data = context.getImageData(0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE).data;
  const border: number[] = [];
  for (let y = 0; y < TEMPLATE_SIZE; y += 1) {
    for (let x = 0; x < TEMPLATE_SIZE; x += 1) {
      if (x < 3 || y < 3 || x >= TEMPLATE_SIZE - 3 || y >= TEMPLATE_SIZE - 3) {
        const offset = (y * TEMPLATE_SIZE + x) * 4;
        border.push((data[offset] + data[offset + 1] + data[offset + 2]) / 3);
      }
    }
  }
  const background = percentile(border, 0.72);
  const ink = new Float32Array(TEMPLATE_SIZE * TEMPLATE_SIZE);
  for (let index = 0; index < ink.length; index += 1) {
    const offset = index * 4;
    const luminance = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
    ink[index] = Math.max(0, Math.min(1, (background - luminance) / 150));
  }
  return ink;
}

function collapseFenRow(row: string[]): string {
  let result = "";
  let empty = 0;
  for (const piece of row) {
    if (!piece) {
      empty += 1;
      continue;
    }
    if (empty > 0) {
      result += String(empty);
      empty = 0;
    }
    result += piece;
  }
  if (empty > 0) {
    result += String(empty);
  }
  return result;
}

function textRectangle(canvas: HTMLCanvasElement, bbox: BBox) {
  // Extend capture area: book lines often appear to the right of or below the diagram.
  // Extra right margin (× 1.6) and a larger bottom margin (× 2.4) to capture multi-line
  // move sequences that may be printed beneath the board.
  const left = Math.max(0, Math.floor(bbox.x - bbox.width * 0.12));
  const top = Math.max(0, Math.floor(bbox.y - bbox.height * 0.08));
  const right = Math.min(canvas.width, Math.floor(bbox.x + bbox.width * 1.6));
  const bottom = Math.min(canvas.height, Math.floor(bbox.y + bbox.height * 2.4));
  return {
    left,
    top,
    width: Math.max(140, right - left),
    height: Math.max(80, bottom - top),
  };
}

function clampSquareBox(bbox: BBox, width: number, height: number): BBox {
  const size = Math.max(32, Math.min(bbox.width, bbox.height, width, height));
  const x = Math.max(0, Math.min(width - size, bbox.x));
  const y = Math.max(0, Math.min(height - size, bbox.y));
  return { x, y, width: size, height: size };
}

function scoreBoardCandidate(context: CanvasRenderingContext2D, x: number, y: number, size: number): number {
  const cell = size / 8;
  const centers: number[] = [];
  const gridSamples: number[] = [];

  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      centers.push(brightnessAt(context, x + file * cell + cell / 2, y + rank * cell + cell / 2));
    }
  }

  for (let i = 1; i < 8; i += 1) {
    const offset = i * cell;
    for (let t = 0; t <= 8; t += 1) {
      gridSamples.push(edgeDelta(context, x + offset, y + t * cell, true));
      gridSamples.push(edgeDelta(context, x + t * cell, y + offset, false));
    }
  }

  const alternation = checkerboardAlternation(centers);
  const grid = average(gridSamples);
  const contrast = standardDeviation(centers);
  return Math.max(0, Math.min(1, alternation * 0.48 + grid * 0.34 + contrast * 0.18));
}

function checkerboardAlternation(values: number[]): number {
  let scoreA = 0;
  let scoreB = 0;
  let pairs = 0;

  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const index = rank * 8 + file;
      const expectedA = (rank + file) % 2 === 0 ? 1 : -1;
      const centered = values[index] - 0.5;
      scoreA += centered * expectedA;
      scoreB += centered * -expectedA;
      pairs += 1;
    }
  }

  return Math.min(1, (Math.abs(Math.max(scoreA, scoreB)) / pairs) * 2);
}

function squareInkDensity(context: CanvasRenderingContext2D, bbox: BBox): number[] {
  const densities: number[] = [];
  const cell = bbox.width / 8;

  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const x = Math.floor(bbox.x + file * cell + cell * 0.18);
      const y = Math.floor(bbox.y + rank * cell + cell * 0.18);
      const size = Math.max(4, Math.floor(cell * 0.64));
      const data = context.getImageData(x, y, size, size).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        const value = (data[i] + data[i + 1] + data[i + 2]) / 765;
        if (value < 0.58) {
          dark += 1;
        }
      }
      densities.push(dark / (data.length / 4));
    }
  }

  return densities;
}

function edgeDelta(context: CanvasRenderingContext2D, x: number, y: number, vertical: boolean): number {
  const a = brightnessAt(context, x + (vertical ? -3 : 0), y + (vertical ? 0 : -3));
  const b = brightnessAt(context, x + (vertical ? 3 : 0), y + (vertical ? 0 : 3));
  return Math.abs(a - b);
}

function brightnessAt(context: CanvasRenderingContext2D, x: number, y: number): number {
  const data = context.getImageData(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), 1, 1).data;
  return (data[0] + data[1] + data[2]) / 765;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function vectorAverage(values: ArrayLike<number>): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
  }
  return sum / values.length;
}

function vectorNorm(values: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index] * values[index];
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>, bNorm: number): number {
  const aNorm = vectorNorm(a);
  if (aNorm === 0 || bNorm === 0) {
    return 0;
  }
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
  }
  return dot / (aNorm * bNorm);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 255;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * ratio)));
  return sorted[index];
}

function standardDeviation(values: number[]): number {
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.min(1, Math.sqrt(variance) * 3);
}

function nonOverlapping(candidates: Array<BBox & { confidence: number }>) {
  const kept: Array<BBox & { confidence: number }> = [];
  for (const candidate of candidates) {
    if (kept.every((existing) => intersectionOverUnion(existing, candidate) < 0.4)) {
      kept.push(candidate);
    }
  }
  return kept;
}

function intersectionOverUnion(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = a.width * a.height + b.width * b.height - intersection;
  return area === 0 ? 0 : intersection / area;
}
