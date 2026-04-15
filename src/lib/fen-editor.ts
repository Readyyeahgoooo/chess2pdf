import { Chess, SQUARES, type Square } from "chess.js";
import { STARTING_FEN } from "@/lib/constants";
import type { EditablePieceMap, PieceCode } from "@/lib/types";

const PIECE_TO_FEN: Record<PieceCode, string> = {
  wP: "P",
  wN: "N",
  wB: "B",
  wR: "R",
  wQ: "Q",
  wK: "K",
  bP: "p",
  bN: "n",
  bB: "b",
  bR: "r",
  bQ: "q",
  bK: "k",
};

const FEN_TO_PIECE: Record<string, PieceCode> = Object.fromEntries(
  Object.entries(PIECE_TO_FEN).map(([piece, fen]) => [fen, piece]),
) as Record<string, PieceCode>;

export function isValidFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

export function safeFen(fen: string): string {
  return isValidFen(fen) ? fen : STARTING_FEN;
}

export function fenToPieceMap(fen: string): EditablePieceMap {
  const board = fen.split(" ")[0].split("/");
  const map: EditablePieceMap = {};

  for (let rankIndex = 0; rankIndex < 8; rankIndex += 1) {
    let fileIndex = 0;
    for (const char of board[rankIndex] ?? "") {
      const empty = Number(char);
      if (Number.isFinite(empty) && empty > 0) {
        fileIndex += empty;
        continue;
      }
      const file = "abcdefgh"[fileIndex];
      const rank = String(8 - rankIndex);
      const square = `${file}${rank}` as Square;
      map[square] = FEN_TO_PIECE[char];
      fileIndex += 1;
    }
  }

  return map;
}

export function pieceMapToFen(map: EditablePieceMap, turn: "w" | "b" = "w"): string {
  const rows: string[] = [];

  for (let rank = 8; rank >= 1; rank -= 1) {
    let row = "";
    let empty = 0;

    for (const file of "abcdefgh") {
      const square = `${file}${rank}` as Square;
      const piece = map[square];

      if (!piece) {
        empty += 1;
        continue;
      }

      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += PIECE_TO_FEN[piece];
    }

    if (empty > 0) {
      row += String(empty);
    }
    rows.push(row);
  }

  return `${rows.join("/")} ${turn} - - 0 1`;
}

export function movePieceInFen(fen: string, from: Square, to: Square): string {
  const map = fenToPieceMap(fen);
  const piece = map[from];
  if (!piece) {
    return fen;
  }
  delete map[from];
  map[to] = piece;
  return pieceMapToFen(map, fen.includes(" b ") ? "b" : "w");
}

export function placePieceInFen(fen: string, square: Square, piece: PieceCode | null): string {
  const map = fenToPieceMap(fen);
  if (piece) {
    map[square] = piece;
  } else {
    delete map[square];
  }
  return pieceMapToFen(map, fen.includes(" b ") ? "b" : "w");
}

export function clearFen(): string {
  return "8/8/8/8/8/8/8/8 w - - 0 1";
}

export function isSquare(value: string): value is Square {
  return SQUARES.includes(value as Square);
}
