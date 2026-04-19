# Chess2pdf

**Free, browser-only chess PDF reader.** Open a chessbook PDF, detect diagrams automatically, correct positions when needed, play out the suggested lines, and get immediate Stockfish evaluation when you deviate — all without uploading anything to a server.

## Features

- **Open any chess PDF** — drag-and-drop or file picker; PDF bytes never leave the browser
- **Local diagram detection** — grid-analysis detects board-like regions with confidence scoring
- **Local OCR** — Tesseract WASM extracts SAN move notation from the page
- **Interactive study board** — react-chessboard with flip, undo, reset, and edit mode
- **Play suggested lines** — step through recognised book moves; deviation is caught immediately
- **Local Stockfish analysis** — Stockfish 18 lite WASM runs in a Web Worker; no server call
- **Edit mode** — place/remove individual pieces to correct any recognised position
- **Position tools** — copy the current position notation or parsed PGN; open Lichess in one click
- **Your history** — store up to 10 recognised studies locally
- **No account, no upload route, no telemetry**
- **Optional AI coach** — with `OPENROUTER_API_KEY`, summarize book lines and explain deviations using derived chess data only

## Tech Stack

| Layer | Library |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript) |
| PDF rendering | pdfjs-dist 5 (self-hosted worker) |
| OCR | tesseract.js 7 (WASM, self-hosted assets) |
| Move validation | chess.js 1 |
| Board UI | react-chessboard 5 |
| Engine | Stockfish 18 lite single-threaded WASM |
| Persistence | idb / IndexedDB |
| Styling | Tailwind CSS 4 |
| Tests | Vitest + Playwright |

## Optional AI Coach

The core app does not need an API key. PDF rendering, OCR, move parsing, and Stockfish analysis all still run locally.

To enable AI explanations on Vercel, add:

```bash
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
NEXT_PUBLIC_SITE_URL=https://chess2pdf.vercel.app
```

The browser calls `/api/ai/chess`; the server route calls OpenRouter with position notation, recognized moves, played moves, and Stockfish output. It does not send original PDF bytes.

The AI route keeps the OpenRouter key server-only, rejects bodies over 16 KB, clips OCR/move context before prompting, uses an 18 second upstream timeout, and applies a small per-IP in-memory throttle. For stronger production abuse protection, also set an OpenRouter spend limit and use Vercel Firewall or a durable rate limiter such as Upstash.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Available Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) |

## Project Structure

```
src/
  app/             Next.js App Router entry
  components/      chess2pdf-app.tsx  — main UI component
  lib/
    pdf-processing.ts   PDF.js load, render, grid detection, OCR
    move-parser.ts      SAN extraction and validation via chess.js
    stockfish.ts        Stockfish WASM worker wrapper
    fen-editor.ts       FEN manipulation helpers
    file-validation.ts  PDF signature & size check
    storage.ts          local history persistence, capped at 10 studies
    constants.ts        App-wide constants
    types.ts            Shared TypeScript types
public/
  ort/             ONNX Runtime WASM assets copied during install/build
  fenify/          Optional local Fenify model path; production should use NEXT_PUBLIC_FENIFY_MODEL_URL
  pdfjs/           pdf.worker.min.mjs
  stockfish/       Stockfish 18 lite WASM + JS wrapper
  tesseract/       Tesseract WASM core assets (self-hosted)
  tessdata/        eng.traineddata.gz (English OCR model)
tests/
  e2e/             Playwright tests
```

## Security

- PDF bytes are validated against the `%PDF` magic bytes signature before being parsed.
- Maximum file size: 100 MB. Maximum pages: 700.
- OCR output is never injected as HTML.
- All workers and assets are self-hosted; no CDN dependency at runtime.
- Strict Content Security Policy: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`.
- No upload API route exists. There is no server-side PDF processing.

## Known Limitations

- **Board recognition is best-effort** — v1 uses grid detection plus the Fenify neural recognizer when `model.onnx` is available. Scanned photos, unusual fonts, labels inside the crop, and low-resolution pages may still need Crop board or Edit mode.
- **OCR of chess notation** — characters such as `O-O`, `0-0`, `N`, `K`, `x`, `+`, `#` are commonly confused. Always verify parsed moves before serious study.
- **Browser-only processing** — heavy PDFs (200+ pages, large scans) may be slow on older devices.
- **Copyright** — the app processes PDFs you own locally. It does not provide a public PDF library.

## Deploy to Vercel

Push this repo to GitHub, then import it in [Vercel](https://vercel.com/new). For accurate production board recognition, host `public/fenify/model.onnx` on a public model/CDN URL and set:

```bash
NEXT_PUBLIC_FENIFY_MODEL_URL=https://your-model-host/model.onnx
```

Add `OPENROUTER_API_KEY` only if you want the optional AI coach.

```bash
git remote add origin git@github.com:YOUR_USERNAME/chess2pdf.git
git push -u origin main
```

Then connect the repo in Vercel and deploy with default Next.js settings.

## Roadmap

- [ ] Stronger piece classification (ML model trained on chess diagram fonts)
- [ ] Multi-diagram exercise list per page
- [ ] PGN import for exercises without a PDF
- [ ] Mobile-optimised layout
- [ ] PWA / offline support
