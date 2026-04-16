import { MAX_PDF_PAGES, STARTING_FEN } from "@/lib/constants";
import { parseRecognizedLine } from "@/lib/move-parser";
import type { BBox, DetectedDiagram, PdfPagePreview, RecognizedLine } from "@/lib/types";

type PdfJs = typeof import("pdfjs-dist");
export type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

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
        if (confidence > 0.36) {
          candidates.push({ x, y, width: size, height: size, confidence });
        }
      }
    }
  }

  return nonOverlapping(candidates.sort((a, b) => b.confidence - a.confidence)).slice(0, 8);
}

export function classifyBoardFen(canvas: HTMLCanvasElement, bbox: BBox): { fen: string; confidence: number; notes: string[] } {
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

  // inferOccupancyFen only produces pawn-only positions which are misleading;
  // fall through to lowConfidenceFen (STARTING_FEN) so the user has a
  // recognisable starting point to correct from.
  return lowConfidenceFen([
    "A board-like grid was found, but piece types cannot be determined from pixel data alone.",
    "Paste the correct FEN in \"Edit position / FEN\" below the board.",
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
    const classification = classifyBoardFen(page.canvas, candidate);
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
  const classification = classifyBoardFen(page.canvas, normalized);
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
  // Fall back to STARTING_FEN: at least opening book lines will be legal from here.
  return {
    fen: STARTING_FEN,
    confidence: 0.28,
    notes,
  };
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

  return Math.min(1, Math.abs(Math.max(scoreA, scoreB)) / pairs + 0.35);
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

function inferOccupancyFen(occupancy: number[]): string | null {
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ""));
  const occupied = occupancy
    .map((density, index) => ({ density, index }))
    .filter((sample) => sample.density > 0.21)
    .sort((a, b) => b.density - a.density);

  if (occupied.length < 6) {
    return null;
  }

  board[0][4] = "k";
  board[7][4] = "K";
  let whitePawns = 0;
  let blackPawns = 0;

  for (const square of occupied) {
    const rank = Math.floor(square.index / 8);
    const file = square.index % 8;
    if ((rank === 0 && file === 4) || (rank === 7 && file === 4)) {
      continue;
    }
    if (rank === 0 || rank === 7) {
      continue;
    }

    const isBlackHalf = rank <= 3;
    if (isBlackHalf) {
      if (blackPawns >= 8) {
        continue;
      }
      board[rank][file] = "p";
      blackPawns += 1;
      continue;
    }

    if (whitePawns >= 8) {
      continue;
    }
    board[rank][file] = "P";
    whitePawns += 1;
  }

  const rows = board.map((row) => {
    let result = "";
    let empty = 0;
    for (const cell of row) {
      if (!cell) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        result += String(empty);
        empty = 0;
      }
      result += cell;
    }
    if (empty > 0) {
      result += String(empty);
    }
    return result;
  });

  return `${rows.join("/")} w - - 0 1`;
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
