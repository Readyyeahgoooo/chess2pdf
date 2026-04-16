export const APP_NAME = "Chess2pdf";
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 700;
export const MAX_CACHED_CANVASES = 8;
export const OCR_CONCURRENCY = 2;
export const DEFAULT_DEPTH = 10;
export const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const DEMO_LINE =
  "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7";

export const SAMPLE_FENS = [
  {
    label: "Start position",
    fen: STARTING_FEN,
  },
  {
    label: "Ruy Lopez after 5...Be7",
    fen: "r1bqk2r/1pppbppp/p1n2n2/1B2p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 6 6",
  },
  {
    label: "Endgame correction sandbox",
    fen: "8/5pk1/6p1/2p5/2P1P3/5P2/6K1/8 w - - 0 42",
  },
];
