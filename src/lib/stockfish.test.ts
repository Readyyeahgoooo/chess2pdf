import { describe, expect, it } from "vitest";
import { parseEngineInfo } from "@/lib/stockfish";

describe("parseEngineInfo", () => {
  it("parses centipawn scores", () => {
    const parsed = parseEngineInfo("info depth 10 score cp 34 pv e2e4 e7e5", "fen");
    expect(parsed).toMatchObject({ depth: 10, scoreCp: 34, pv: ["e2e4", "e7e5"] });
  });

  it("parses mate scores", () => {
    const parsed = parseEngineInfo("info depth 8 score mate -2 pv h7h8q", "fen");
    expect(parsed).toMatchObject({ depth: 8, mateIn: -2, pv: ["h7h8q"] });
  });
});
