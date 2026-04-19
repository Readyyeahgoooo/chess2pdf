import type { Square } from "chess.js";

export type BBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScanStatus = "idle" | "loading" | "scanning" | "ready" | "error";

export type PdfPagePreview = {
  pageIndex: number;
  width: number;
  height: number;
  thumbnailUrl: string;
  imageUrl: string;
};

export type DetectedDiagram = {
  id: string;
  pageIndex: number;
  bbox: BBox;
  fen: string;
  confidence: number;
  recognitionSource?: "fenify" | "template" | "occupancy" | "fallback";
  orientation: "white" | "black";
  sourceCropUrl?: string;
  notes: string[];
};

export type RecognizedLine = {
  id: string;
  diagramId: string;
  rawText: string;
  normalizedText: string;
  sanMoves: string[];
  confidence: number;
  parseErrors: string[];
};

export type EngineEval = {
  fen: string;
  depth: number;
  scoreCp?: number;
  mateIn?: number;
  bestMove?: string;
  pv: string[];
};

export type ExerciseState = {
  fen: string;
  expectedLines: RecognizedLine[];
  playedMoves: string[];
  currentPly: number;
  deviationPly?: number;
  engineEval?: EngineEval;
};

export type PdfSession = {
  id: string;
  fileName: string;
  fileSize: number;
  createdAt: string;
  pages: PdfPagePreview[];
  diagrams: DetectedDiagram[];
  exercises: RecognizedLine[];
};

export type PieceCode =
  | "wP"
  | "wN"
  | "wB"
  | "wR"
  | "wQ"
  | "wK"
  | "bP"
  | "bN"
  | "bB"
  | "bR"
  | "bQ"
  | "bK";

export type EditablePieceMap = Partial<Record<Square, PieceCode>>;
