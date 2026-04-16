import { describe, expect, it } from "vitest";
import { DEFAULT_OPENROUTER_MODEL, buildChessAiMessages, sanitizeChessAiRequest } from "@/lib/ai-chess";
import { STARTING_FEN } from "@/lib/constants";

describe("buildChessAiMessages", () => {
  it("defaults to the requested free OpenRouter model", () => {
    expect(DEFAULT_OPENROUTER_MODEL).toBe("nvidia/nemotron-3-super-120b-a12b:free");
  });

  it("builds a summary prompt from derived chess data", () => {
    const messages = buildChessAiMessages({
      mode: "line-summary",
      startingFen: STARTING_FEN,
      currentFen: STARTING_FEN,
      recognizedMoves: ["e4", "e5", "Nf3"],
      playedMoves: [],
      rawText: "1. e4 e5 2. Nf3",
    });

    expect(messages[1].content).toContain("Summarize the book line");
    expect(messages[1].content).toContain("e4 e5 Nf3");
  });

  it("builds a deviation prompt with engine context", () => {
    const messages = buildChessAiMessages({
      mode: "deviation",
      startingFen: STARTING_FEN,
      currentFen: STARTING_FEN,
      recognizedMoves: ["e4", "e5"],
      playedMoves: ["e4", "c5"],
      deviationPly: 2,
      engineEval: {
        fen: STARTING_FEN,
        depth: 10,
        scoreCp: -55,
        bestMove: "g1f3",
        pv: ["g1f3", "b8c6"],
      },
    });

    expect(messages[1].content).toContain("Explain why");
    expect(messages[1].content).toContain("-55 centipawns");
  });

  it("clips oversized OCR and move payloads before prompting", () => {
    const request = sanitizeChessAiRequest({
      mode: "line-summary",
      startingFen: `${STARTING_FEN}${"x".repeat(300)}`,
      currentFen: STARTING_FEN,
      recognizedMoves: Array.from({ length: 200 }, (_, index) => `e${index}`),
      playedMoves: [],
      rawText: "a".repeat(10_000),
    });

    expect(request.startingFen.length).toBeLessThanOrEqual(120);
    expect(request.recognizedMoves).toHaveLength(80);
    expect(request.rawText).toHaveLength(1200);
  });
});
