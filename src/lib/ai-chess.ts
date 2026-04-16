import type { EngineEval } from "@/lib/types";

export type ChessAiMode = "line-summary" | "deviation";

export type ChessAiRequest = {
  mode: ChessAiMode;
  startingFen: string;
  currentFen: string;
  recognizedMoves: string[];
  playedMoves: string[];
  rawText?: string;
  deviationPly?: number;
  engineEval?: EngineEval;
};

export type ChessAiResponse = {
  ok: boolean;
  title: string;
  explanation: string;
  configured: boolean;
};

const MAX_FEN_LENGTH = 120;
const MAX_MOVES = 80;
const MAX_MOVE_LENGTH = 18;
const MAX_RAW_TEXT_LENGTH = 1_200;
const MAX_PV_LENGTH = 12;

export const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

export function buildChessAiMessages(request: ChessAiRequest) {
  const safeRequest = sanitizeChessAiRequest(request);
  const task =
    safeRequest.mode === "line-summary"
      ? "Summarize the book line for a chess student."
      : "Explain why the student's deviation may be worse than the book line.";

  return [
    {
      role: "system",
      content:
        "You are a concise chess coach. Use only the supplied FEN, moves, and engine data. Do not invent book context. Keep the answer practical and under 180 words.",
    },
    {
      role: "user",
      content: [
        task,
        "",
        `Starting FEN: ${safeRequest.startingFen}`,
        `Current FEN: ${safeRequest.currentFen}`,
        `Recognized book line: ${safeRequest.recognizedMoves.join(" ") || "none"}`,
        `Student played moves: ${safeRequest.playedMoves.join(" ") || "none"}`,
        `Raw OCR/book text: ${safeRequest.rawText || "none"}`,
        `Deviation ply: ${safeRequest.deviationPly ?? "none"}`,
        safeRequest.engineEval ? `Engine evaluation: ${formatEngineForPrompt(safeRequest.engineEval)}` : "Engine evaluation: none",
        "",
        "Return plain text with short sections: Idea, Why it matters, What to try.",
      ].join("\n"),
    },
  ] as const;
}

export function aiModeTitle(mode: ChessAiMode): string {
  return mode === "line-summary" ? "Book line summary" : "Deviation explanation";
}

export function sanitizeChessAiRequest(request: ChessAiRequest): ChessAiRequest {
  return {
    mode: request.mode,
    startingFen: clip(request.startingFen, MAX_FEN_LENGTH),
    currentFen: clip(request.currentFen, MAX_FEN_LENGTH),
    recognizedMoves: sanitizeMoves(request.recognizedMoves),
    playedMoves: sanitizeMoves(request.playedMoves),
    rawText: clip(request.rawText ?? "", MAX_RAW_TEXT_LENGTH),
    deviationPly:
      typeof request.deviationPly === "number" && Number.isFinite(request.deviationPly)
        ? Math.max(0, Math.min(160, Math.floor(request.deviationPly)))
        : undefined,
    engineEval: request.engineEval
      ? {
          fen: clip(request.engineEval.fen, MAX_FEN_LENGTH),
          depth: Math.max(0, Math.min(40, Math.floor(request.engineEval.depth))),
          scoreCp: clampOptional(request.engineEval.scoreCp, -20_000, 20_000),
          mateIn: clampOptional(request.engineEval.mateIn, -100, 100),
          bestMove: request.engineEval.bestMove ? clip(request.engineEval.bestMove, MAX_MOVE_LENGTH) : undefined,
          pv: sanitizeMoves(request.engineEval.pv).slice(0, MAX_PV_LENGTH),
        }
      : undefined,
  };
}

function sanitizeMoves(moves: string[]): string[] {
  return moves
    .filter((move) => typeof move === "string")
    .map((move) => clip(move.replace(/[^\w+#=./-]/g, ""), MAX_MOVE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_MOVES);
}

function clip(value: string, maxLength: number) {
  return value.slice(0, maxLength);
}

function clampOptional(value: number | undefined, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function formatEngineForPrompt(engineEval: EngineEval): string {
  const score =
    engineEval.mateIn !== undefined
      ? `mate ${engineEval.mateIn}`
      : engineEval.scoreCp !== undefined
        ? `${engineEval.scoreCp} centipawns`
        : "unknown score";
  return `depth ${engineEval.depth}, score ${score}, best move ${engineEval.bestMove ?? "unknown"}, PV ${engineEval.pv.join(" ") || "none"}`;
}
