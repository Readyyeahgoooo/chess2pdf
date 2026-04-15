import { Chess } from "chess.js";
import { STARTING_FEN } from "@/lib/constants";

const MOVE_NUMBER_PATTERN = /(?:^|\s)(?:\d+\s*\.\.\.|\d+\s*\.)(?=\s|[A-Za-zO0])/g;
const RESULT_PATTERN = /\b(?:1-0|0-1|1\/2-1\/2|\*)\b/g;
const NOISE_PATTERN = /[\[\]{}()|_=]/g;
const TOKEN_PATTERN =
  /(?:O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x?[a-h][1-8](?:=[QRBN])?[+#]?)/g;

export type ParsedLine = {
  rawText: string;
  normalizedText: string;
  sanMoves: string[];
  confidence: number;
  parseErrors: string[];
};

export function normalizeChessText(rawText: string): string {
  return rawText
    .replace(/\r/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\b0-0-0\b/g, "O-O-O")
    .replace(/\b0-0\b/g, "O-O")
    .replace(RESULT_PATTERN, " ")
    .replace(MOVE_NUMBER_PATTERN, " ")
    .replace(NOISE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractMoveTokens(rawText: string): string[] {
  const normalized = normalizeChessText(rawText);
  return normalized.match(TOKEN_PATTERN) ?? [];
}

export function parseRecognizedLine(rawText: string, fen = STARTING_FEN): ParsedLine {
  const normalizedText = normalizeChessText(rawText);
  const tokens = extractMoveTokens(rawText);
  const chess = new Chess(fen);
  const sanMoves: string[] = [];
  const parseErrors: string[] = [];

  for (const token of tokens) {
    try {
      const move = chess.move(token, { strict: false });
      if (!move) {
        parseErrors.push(token);
        continue;
      }
      sanMoves.push(move.san);
    } catch {
      parseErrors.push(token);
    }
  }

  const total = sanMoves.length + parseErrors.length;
  const confidence = total === 0 ? 0 : Math.max(0, Math.min(1, sanMoves.length / total));

  return {
    rawText,
    normalizedText,
    sanMoves,
    confidence,
    parseErrors,
  };
}

export function lineToPgn(fen: string, sanMoves: string[]): string {
  const game = new Chess(fen);
  for (const san of sanMoves) {
    game.move(san, { strict: false });
  }
  return game.pgn();
}
