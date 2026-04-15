import { describe, expect, it } from "vitest";
import { clearFen, isValidFen, movePieceInFen, placePieceInFen } from "@/lib/fen-editor";
import { STARTING_FEN } from "@/lib/constants";

describe("fen editor", () => {
  it("moves pieces in edit mode", () => {
    const moved = movePieceInFen(STARTING_FEN, "e2", "e4");
    expect(moved.startsWith("rnbqkbnr/pppppppp/8/8/4P3")).toBe(true);
  });

  it("places and erases pieces", () => {
    const withQueen = placePieceInFen(clearFen(), "d4", "wQ");
    expect(withQueen.startsWith("8/8/8/8/3Q4")).toBe(true);
    const erased = placePieceInFen(withQueen, "d4", null);
    expect(erased.startsWith("8/8/8/8/8/8/8/8")).toBe(true);
  });

  it("validates legal analysis FENs", () => {
    expect(isValidFen(STARTING_FEN)).toBe(true);
    expect(isValidFen(clearFen())).toBe(false);
  });
});
