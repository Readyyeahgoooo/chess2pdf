import { describe, expect, it } from "vitest";
import { extractMoveTokens, parseRecognizedLine } from "@/lib/move-parser";

describe("move parser", () => {
  it("normalizes OCR castling zeros", () => {
    expect(extractMoveTokens("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. 0-0")).toContain("O-O");
  });

  it("validates SAN moves against the starting position", () => {
    const parsed = parseRecognizedLine("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6");
    expect(parsed.sanMoves).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
    expect(parsed.parseErrors).toEqual([]);
  });

  it("keeps parse errors visible", () => {
    const parsed = parseRecognizedLine("1. e4 e5 2. Kz9 Nc6");
    expect(parsed.sanMoves).toEqual(["e4", "e5"]);
    expect(parsed.confidence).toBeLessThan(1);
  });
});
