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

export function buildChessAiMessages(request: ChessAiRequest) {
  const task =
    request.mode === "line-summary"
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
        `Starting FEN: ${request.startingFen}`,
        `Current FEN: ${request.currentFen}`,
        `Recognized book line: ${request.recognizedMoves.join(" ") || "none"}`,
        `Student played moves: ${request.playedMoves.join(" ") || "none"}`,
        `Raw OCR/book text: ${request.rawText || "none"}`,
        `Deviation ply: ${request.deviationPly ?? "none"}`,
        request.engineEval ? `Engine evaluation: ${formatEngineForPrompt(request.engineEval)}` : "Engine evaluation: none",
        "",
        "Return plain text with short sections: Idea, Why it matters, What to try.",
      ].join("\n"),
    },
  ] as const;
}

export function aiModeTitle(mode: ChessAiMode): string {
  return mode === "line-summary" ? "Book line summary" : "Deviation explanation";
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
