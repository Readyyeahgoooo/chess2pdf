"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { DEFAULT_DEPTH, MAX_CACHED_CANVASES, OCR_CONCURRENCY, SAMPLE_FENS, STARTING_FEN } from "@/lib/constants";
import { clearFen, isSquare, isValidFen, movePieceInFen, placePieceInFen, safeFen } from "@/lib/fen-editor";
import { validatePdfFile } from "@/lib/file-validation";
import { lineToPgn, parseRecognizedLine } from "@/lib/move-parser";
import {
  loadPdfDocument,
  renderPdfPage,
  scanRenderedPage,
  type PdfDocument,
  type RenderedPage,
} from "@/lib/pdf-processing";
import { clearLocalData, listSessions, saveSession } from "@/lib/storage";
import { StockfishClient } from "@/lib/stockfish";
import type { ChessAiMode, ChessAiResponse } from "@/lib/ai-chess";
import type { DetectedDiagram, EngineEval, PdfPagePreview, PdfSession, PieceCode, RecognizedLine, ScanStatus } from "@/lib/types";

const PIECES: PieceCode[] = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"];
const PIECE_LABEL: Record<PieceCode, string> = {
  wK: "White king",
  wQ: "White queen",
  wR: "White rook",
  wB: "White bishop",
  wN: "White knight",
  wP: "White pawn",
  bK: "Black king",
  bQ: "Black queen",
  bR: "Black rook",
  bB: "Black bishop",
  bN: "Black knight",
  bP: "Black pawn",
};

type BoardOrientation = "white" | "black";

export function Chess2PdfApp() {
  const [status, setStatus] = useState<ScanStatus>("ready");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("Open a PDF to begin.");
  const [hasPdfLoaded, setHasPdfLoaded] = useState(false);
  const [fileMeta, setFileMeta] = useState<{ name: string; size: number } | null>(null);
  const [pages, setPages] = useState<PdfPagePreview[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [scanRangeStart, setScanRangeStart] = useState(1);
  const [scanRangeEnd, setScanRangeEnd] = useState(1);
  const [diagrams, setDiagrams] = useState<DetectedDiagram[]>([]);
  const [lines, setLines] = useState<RecognizedLine[]>([]);
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<PdfSession[]>([]);
  const [fen, setFen] = useState(STARTING_FEN);
  const [fenDraft, setFenDraft] = useState(STARTING_FEN);
  const [playedMoves, setPlayedMoves] = useState<string[]>([]);
  const [deviationPly, setDeviationPly] = useState<number | undefined>();
  const [engineEval, setEngineEval] = useState<EngineEval | undefined>();
  const [engineStatus, setEngineStatus] = useState("idle");
  const [orientation, setOrientation] = useState<BoardOrientation>("white");
  const [editMode, setEditMode] = useState(false);
  const [selectedPiece, setSelectedPiece] = useState<PieceCode | null>("wQ");
  const [ocrTextDraft, setOcrTextDraft] = useState("");
  const [aiStatus, setAiStatus] = useState("AI coach idle");
  const [aiResult, setAiResult] = useState<ChessAiResponse | null>(null);

  const canvasesRef = useRef(new Map<number, HTMLCanvasElement>());
  const pagePreviewsRef = useRef(new Map<number, PdfPagePreview>());
  const scannedPagesRef = useRef(new Set<number>());
  const pdfRef = useRef<PdfDocument | null>(null);
  const stockfishRef = useRef<StockfishClient | null>(null);
  const scanRunRef = useRef(0);

  const selectedDiagram = diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? diagrams[0];
  const selectedLines = selectedDiagram ? lines.filter((line) => line.diagramId === selectedDiagram.id) : lines;
  const expectedLine = selectedLines.find((line) => line.sanMoves.length > 0) ?? selectedLines[0];
  const pagePreviewMap = useMemo(() => new Map(pages.map((page) => [page.pageIndex, page])), [pages]);
  const currentChess = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return null;
    }
  }, [fen]);

  const resetBoard = useCallback((nextFen = STARTING_FEN) => {
    const resolved = safeFen(nextFen);
    setFen(resolved);
    setFenDraft(resolved);
    setPlayedMoves([]);
    setDeviationPly(undefined);
    setEngineEval(undefined);
    setEngineStatus("idle");
  }, []);

  const refreshSessions = useCallback(async () => {
    setSessions(await listSessions());
  }, []);

  useEffect(() => {
    stockfishRef.current = new StockfishClient();
    queueMicrotask(() => {
      void refreshSessions();
    });

    return () => {
      stockfishRef.current?.dispose();
      pdfRef.current?.destroy();
    };
  }, [refreshSessions]);

  async function handleFile(file: File) {
    setError("");
    setStatus("loading");
    setProgress("Checking PDF safety...");

    const validation = await validatePdfFile(file);
    if (!validation.ok) {
      setStatus("error");
      setError(validation.reason);
      return;
    }

    try {
      pdfRef.current?.destroy();
      canvasesRef.current.clear();
      pagePreviewsRef.current.clear();
      scannedPagesRef.current.clear();
      const document = await loadPdfDocument(file);
      pdfRef.current = document;
      setHasPdfLoaded(true);
      setFileMeta({ name: file.name, size: file.size });
      setPages([]);
      setTotalPages(document.numPages);
      setScanRangeStart(1);
      setScanRangeEnd(Math.min(document.numPages, 20));
      setDiagrams([]);
      setLines([]);
      setSelectedDiagramId(null);
      setCurrentPage(0);
      setProgress(`Opened ${document.numPages} page${document.numPages === 1 ? "" : "s"}. Rendering page 1...`);
      await renderAndCachePage(document, 0);
      setStatus("ready");
      setProgress("Page 1 ready. Scan the current page or choose a range.");
      await scanPages([0]);
    } catch (scanError) {
      setStatus("error");
      setError(scanError instanceof Error ? scanError.message : "Could not open this PDF.");
    }
  }

  async function scanPages(indices: number[]) {
    const document = pdfRef.current;
    if (!document) {
      setProgress("No PDF loaded yet.");
      return;
    }
    const loadedDocument = document;

    const runId = scanRunRef.current + 1;
    scanRunRef.current = runId;
    setStatus("scanning");
    setError("");
    setProgress(`Scanning ${indices.length} page${indices.length === 1 ? "" : "s"} locally...`);

    const queue = [...indices];
    const newDiagrams: DetectedDiagram[] = [];
    const newLines: RecognizedLine[] = [];

    async function worker() {
      while (queue.length > 0 && scanRunRef.current === runId) {
        const pageIndex = queue.shift();
        if (pageIndex === undefined) {
          return;
        }
        const rendered = await getRenderedPage(loadedDocument, pageIndex);
        setProgress(`Scanning page ${pageIndex + 1} with local OCR and grid detection...`);
        const result = await scanRenderedPage(rendered);
        newDiagrams.push(...result.diagrams);
        newLines.push(...result.lines);
        setDiagrams((current) => mergeById(current, result.diagrams, (item) => item.id));
        setLines((current) => mergeById(current, result.lines, (item) => item.id));
      }
    }

    await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, indices.length) }, () => worker()));

    if (scanRunRef.current !== runId) {
      setProgress("Scan cancelled.");
      setStatus("ready");
      return;
    }

    // mark each scanned page so navigateToPage won't re-scan them
    for (const pageIndex of indices) {
      scannedPagesRef.current.add(pageIndex);
    }

    const first = newDiagrams[0];
    if (first) {
      setSelectedDiagramId(first.id);
      resetBoard(first.fen);
      const firstLine = newLines.find((line) => line.diagramId === first.id);
      setOcrTextDraft(firstLine?.rawText || "");
    }

    setProgress(newDiagrams.length > 0 ? "Scan complete. Confirm FEN and moves before serious study." : "No board-like diagram found on that page.");
    setStatus("ready");

    const session = buildSession(newDiagrams, newLines);
    if (session) {
      await saveSession(session);
      await refreshSessions();
    }
  }

  async function getRenderedPage(document: PdfDocument, pageIndex: number) {
    const canvas = canvasesRef.current.get(pageIndex);
    const preview = pagePreviewsRef.current.get(pageIndex);
    if (canvas && preview) {
      return { ...preview, canvas };
    }
    return renderAndCachePage(document, pageIndex);
  }

  async function navigateToPage(pageIndex: number) {
    const document = pdfRef.current;
    const boundedPageIndex = Math.max(0, Math.min(totalPages - 1, pageIndex));
    setCurrentPage(boundedPageIndex);
    if (!document) {
      return;
    }
    if (!pagePreviewsRef.current.has(boundedPageIndex) || !canvasesRef.current.has(boundedPageIndex)) {
      setProgress(`Rendering page ${boundedPageIndex + 1}...`);
      await renderAndCachePage(document, boundedPageIndex);
    }
    if (!scannedPagesRef.current.has(boundedPageIndex)) {
      setProgress(`Scanning page ${boundedPageIndex + 1} for diagrams...`);
      await scanPages([boundedPageIndex]);
    } else {
      // page already scanned — auto-select its first diagram if nothing is selected
      const pageFirstDiagram = diagrams.find((d) => d.pageIndex === boundedPageIndex);
      if (pageFirstDiagram) {
        setSelectedDiagramId(pageFirstDiagram.id);
        resetBoard(pageFirstDiagram.fen);
        const diagramLine = lines.find((l) => l.diagramId === pageFirstDiagram.id);
        setOcrTextDraft(diagramLine?.rawText ?? "");
      }
    }
  }

  async function renderAndCachePage(document: PdfDocument, pageIndex: number) {
    const rendered = await renderPdfPage(document, pageIndex);
    canvasesRef.current.set(pageIndex, rendered.canvas);
    pagePreviewsRef.current.set(pageIndex, stripCanvas(rendered));
    evictCachedPages(pageIndex);
    setPages(Array.from(pagePreviewsRef.current.values()).sort((a, b) => a.pageIndex - b.pageIndex));
    return rendered;
  }

  function evictCachedPages(anchorPageIndex: number) {
    if (canvasesRef.current.size <= MAX_CACHED_CANVASES) {
      return;
    }

    const keep = new Set(
      Array.from(canvasesRef.current.keys())
        .sort((a, b) => Math.abs(a - anchorPageIndex) - Math.abs(b - anchorPageIndex))
        .slice(0, MAX_CACHED_CANVASES),
    );

    for (const pageIndex of Array.from(canvasesRef.current.keys())) {
      if (!keep.has(pageIndex)) {
        canvasesRef.current.delete(pageIndex);
        pagePreviewsRef.current.delete(pageIndex);
      }
    }
  }

  function buildSession(sessionDiagrams: DetectedDiagram[], sessionLines: RecognizedLine[]): PdfSession | null {
    if (!fileMeta) {
      return null;
    }
    return {
      id: crypto.randomUUID(),
      fileName: fileMeta.name,
      fileSize: fileMeta.size,
      createdAt: new Date().toISOString(),
      pages,
      diagrams: sessionDiagrams,
      exercises: sessionLines,
    };
  }

  function cancelScan() {
    scanRunRef.current += 1;
    setProgress("Cancelling after the current OCR job...");
  }

  function selectDiagram(diagram: DetectedDiagram) {
    setSelectedDiagramId(diagram.id);
    void navigateToPage(diagram.pageIndex);
    resetBoard(diagram.fen);
    const line = lines.find((item) => item.diagramId === diagram.id);
    setOcrTextDraft(line?.rawText || "");
  }

  function applyFenDraft() {
    if (!isValidFen(fenDraft)) {
      setError("That FEN is invalid. Keep both kings on the board before analysis.");
      return;
    }
    setError("");
    resetBoard(fenDraft);
  }

  function reparseOcrDraft() {
    const targetDiagramId = selectedDiagram?.id ?? "manual";
    const parsed = parseRecognizedLine(ocrTextDraft, safeFen(fen));
    const updated: RecognizedLine = {
      id: expectedLine?.id ?? crypto.randomUUID(),
      diagramId: targetDiagramId,
      rawText: ocrTextDraft,
      normalizedText: parsed.normalizedText,
      sanMoves: parsed.sanMoves,
      confidence: parsed.confidence,
      parseErrors: parsed.parseErrors,
    };

    setLines((current) => {
      const without = current.filter((line) => line.id !== updated.id);
      return [...without, updated];
    });
    setProgress(`Parsed ${updated.sanMoves.length} legal move${updated.sanMoves.length === 1 ? "" : "s"}.`);
  }

  function handlePieceDrop({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) {
    if (!targetSquare) {
      return false;
    }

    if (!isSquare(sourceSquare) || !isSquare(targetSquare)) {
      return false;
    }

    if (editMode) {
      const nextFen = movePieceInFen(fen, sourceSquare, targetSquare);
      setFen(nextFen);
      setFenDraft(nextFen);
      setPlayedMoves([]);
      setDeviationPly(undefined);
      return true;
    }

    const game = currentChess;
    if (!game) {
      setError("Current position is not legal enough for move validation.");
      return false;
    }

    try {
      const move = game.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
      if (!move) {
        return false;
      }
      const nextMoves = [...playedMoves, move.san];
      const expected = expectedLine?.sanMoves[playedMoves.length];
      const deviated = expected !== undefined && move.san !== expected;
      setFen(game.fen());
      setFenDraft(game.fen());
      setPlayedMoves(nextMoves);
      if (deviated && deviationPly === undefined) {
        setDeviationPly(nextMoves.length);
        void analyzePosition(game.fen());
      }
      return true;
    } catch {
      return false;
    }
  }

  function handleSquareClick({ square }: { square: string }) {
    if (!editMode || !isSquare(square)) {
      return;
    }
    const nextFen = placePieceInFen(fen, square, selectedPiece);
    setFen(nextFen);
    setFenDraft(nextFen);
    setPlayedMoves([]);
    setDeviationPly(undefined);
  }

  function playExpectedMove() {
    if (!expectedLine || !currentChess) {
      return;
    }
    const san = expectedLine.sanMoves[playedMoves.length];
    if (!san) {
      setProgress("End of the recognized line.");
      return;
    }
    const move = currentChess.move(san, { strict: false });
    if (!move) {
      setError(`Could not play ${san} from the current position.`);
      return;
    }
    setFen(currentChess.fen());
    setFenDraft(currentChess.fen());
    setPlayedMoves([...playedMoves, move.san]);
  }

  function undoMove() {
    const source = safeFen(selectedDiagram?.fen ?? STARTING_FEN);
    const game = new Chess(source);
    const nextMoves = playedMoves.slice(0, -1);
    for (const san of nextMoves) {
      game.move(san, { strict: false });
    }
    setFen(game.fen());
    setFenDraft(game.fen());
    setPlayedMoves(nextMoves);
    if (deviationPly !== undefined && nextMoves.length < deviationPly) {
      setDeviationPly(undefined);
    }
  }

  async function analyzePosition(targetFen = fen) {
    if (!isValidFen(targetFen)) {
      setError("Stockfish needs a valid FEN with both kings.");
      return;
    }
    setEngineStatus(`Analyzing to depth ${DEFAULT_DEPTH} locally...`);
    try {
      const result = await stockfishRef.current?.evaluate(targetFen, DEFAULT_DEPTH);
      if (result) {
        setEngineEval(result);
        setEngineStatus("Analysis ready");
      }
    } catch (analysisError) {
      setEngineStatus(analysisError instanceof Error ? analysisError.message : "Engine failed");
    }
  }

  async function askAi(mode: ChessAiMode) {
    setAiStatus(mode === "line-summary" ? "Summarizing book line..." : "Explaining deviation...");
    setAiResult(null);

    try {
      const response = await fetch("/api/ai/chess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          startingFen: safeFen(selectedDiagram?.fen ?? STARTING_FEN),
          currentFen: fen,
          recognizedMoves: expectedLine?.sanMoves ?? [],
          playedMoves,
          rawText: expectedLine?.rawText ?? ocrTextDraft,
          deviationPly,
          engineEval,
        }),
      });
      const payload = (await response.json()) as ChessAiResponse;
      setAiResult(payload);
      setAiStatus(payload.ok ? "AI coach ready" : payload.title);
    } catch (aiError) {
      setAiResult({
        ok: false,
        configured: true,
        title: "AI request failed",
        explanation: aiError instanceof Error ? aiError.message : "Could not reach the AI route.",
      });
      setAiStatus("AI request failed");
    }
  }

  async function copyFen() {
    await navigator.clipboard.writeText(fen);
    setProgress("FEN copied.");
  }

  async function copyPgn() {
    const pgn = expectedLine ? lineToPgn(safeFen(selectedDiagram?.fen ?? STARTING_FEN), expectedLine.sanMoves) : "";
    await navigator.clipboard.writeText(pgn || currentChess?.pgn() || "");
    setProgress("PGN copied.");
  }

  async function wipeLocalData() {
    await clearLocalData();
    await refreshSessions();
    setProgress("History cleared.");
  }

  function scanSelectedRange() {
    if (!totalPages) {
      return;
    }
    const start = Math.max(1, Math.min(totalPages, scanRangeStart));
    const end = Math.max(start, Math.min(totalPages, scanRangeEnd));
    const indices = Array.from({ length: end - start + 1 }, (_, offset) => start - 1 + offset);
    void scanPages(indices);
  }

  const currentPreview = pages.find((page) => page.pageIndex === currentPage);
  const visiblePageDiagrams = diagrams.filter((diagram) => diagram.pageIndex === currentPage);
  const evalText = formatEval(engineEval);
  const lichessUrl = `https://lichess.org/analysis/standard/${fen.replace(/\s/g, "_")}`;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1700px] flex-col gap-4 px-4 py-4">
        <header className="grid gap-3 border-b border-line pb-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <h1 className="text-3xl font-semibold">Chess2pdf</h1>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <label className="cursor-pointer rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong">
              Open PDF
              <input
                className="sr-only"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleFile(file);
                  }
                }}
              />
            </label>
            <button className="rounded-md border border-line bg-panel px-4 py-2 font-semibold" onClick={wipeLocalData}>
              Clear history
            </button>
          </div>
        </header>

        {error ? <div className="rounded-md border border-bad bg-white px-4 py-3 text-sm text-bad">{error}</div> : null}

        <section className="grid flex-1 gap-4 xl:grid-cols-[360px_minmax(430px,1fr)_420px]">
          <aside className="min-h-[520px] rounded-md border border-line bg-panel">
            <div className="border-b border-line p-4">
              <h2 className="text-lg font-semibold">PDF pages</h2>
              {fileMeta ? (
                <p className="text-sm text-muted">{`${fileMeta.name} (${formatBytes(fileMeta.size)}), ${totalPages} page${totalPages === 1 ? "" : "s"}`}</p>
              ) : null}
            </div>
            <div
              className="m-4 rounded-md border border-dashed border-line p-4 text-sm text-muted"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) {
                  void handleFile(file);
                }
              }}
            >
              Drop a PDF here. The app checks the PDF signature and size before rendering it locally.
            </div>
            <div className="flex flex-wrap gap-2 px-4 pb-3">
              <button
                className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!hasPdfLoaded || status === "scanning"}
                onClick={() => void scanPages([currentPage])}
              >
                Scan page
              </button>
              <button
                className="rounded-md border border-line px-3 py-2 text-sm font-semibold"
                disabled={status !== "scanning"}
                onClick={cancelScan}
              >
                Cancel
              </button>
            </div>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-4 pb-3">
              <label className="text-xs font-semibold text-muted">
                From
                <input
                  className="mt-1 w-full rounded-md border border-line bg-white px-2 py-2 text-sm text-foreground"
                  min={1}
                  max={Math.max(1, totalPages)}
                  type="number"
                  value={scanRangeStart}
                  onChange={(event) => setScanRangeStart(Number(event.target.value))}
                />
              </label>
              <label className="text-xs font-semibold text-muted">
                To
                <input
                  className="mt-1 w-full rounded-md border border-line bg-white px-2 py-2 text-sm text-foreground"
                  min={1}
                  max={Math.max(1, totalPages)}
                  type="number"
                  value={scanRangeEnd}
                  onChange={(event) => setScanRangeEnd(Number(event.target.value))}
                />
              </label>
              <button
                className="self-end rounded-md border border-line px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!hasPdfLoaded || status === "scanning"}
                onClick={scanSelectedRange}
              >
                Scan range
              </button>
              <p className="col-span-3 text-xs text-muted">Estimate: about 8 seconds per page on typical scans.</p>
            </div>
            <div className="max-h-[58vh] overflow-auto px-4 pb-4">
              {totalPages === 0 ? (
                <div className="rounded-md bg-background p-4 text-sm text-muted">
                  Upload a PDF to see pages here.
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {Array.from({ length: totalPages }, (_, index) => {
                    const preview = pagePreviewMap.get(index);
                    return (
                      <button
                        key={index}
                        className={`min-h-14 rounded-md border p-1 text-center text-xs font-semibold ${
                          index === currentPage ? "border-accent bg-[#e8f5f1]" : preview ? "border-line bg-white" : "border-line bg-[#f3f6f4]"
                        }`}
                        onClick={() => void navigateToPage(index)}
                      >
                        {preview ? (
                          <img className="mx-auto mb-1 max-h-12 rounded object-contain" src={preview.thumbnailUrl} alt={`PDF page ${index + 1}`} />
                        ) : null}
                        {index + 1}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <section className="grid gap-4">
            <div className="rounded-md border border-line bg-panel p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Study board</h2>
                  <p className="text-sm text-muted">{progress}</p>
                </div>
                <div className="flex flex-wrap gap-2 text-sm">
                  <button className="rounded-md border border-line px-3 py-2 font-semibold" onClick={() => setOrientation(orientation === "white" ? "black" : "white")}>
                    Flip board
                  </button>
                  <button className="rounded-md border border-line px-3 py-2 font-semibold" onClick={() => setEditMode(!editMode)}>
                    {editMode ? "Play mode" : "Edit mode"}
                  </button>
                  <button className="rounded-md border border-line px-3 py-2 font-semibold" onClick={() => resetBoard(selectedDiagram?.fen ?? STARTING_FEN)}>
                    Reset
                  </button>
                </div>
              </div>

              <div className="mx-auto max-w-[620px]">
                <Chessboard
                  options={{
                    id: "chess2pdf-board",
                    position: fen,
                    boardOrientation: orientation,
                    showNotation: true,
                    animationDurationInMs: 120,
                    darkSquareStyle: { backgroundColor: "#6f8f7f" },
                    lightSquareStyle: { backgroundColor: "#edf3ee" },
                    boardStyle: { borderRadius: 6, boxShadow: "0 10px 30px rgba(24, 33, 29, 0.16)" },
                    onPieceDrop: handlePieceDrop,
                    onSquareClick: handleSquareClick,
                  }}
                />
              </div>

              {editMode ? (
                <div className="mt-4 rounded-md border border-line bg-background p-3">
                  <p className="mb-2 text-sm font-semibold">Edit position</p>
                  <div className="flex flex-wrap gap-2">
                    {PIECES.map((piece) => (
                      <button
                        key={piece}
                        className={`rounded-md border px-3 py-2 text-sm ${selectedPiece === piece ? "border-accent bg-[#e8f5f1]" : "border-line bg-white"}`}
                        onClick={() => setSelectedPiece(piece)}
                        title={PIECE_LABEL[piece]}
                      >
                        {piece}
                      </button>
                    ))}
                    <button className="rounded-md border border-line bg-white px-3 py-2 text-sm" onClick={() => setSelectedPiece(null)}>
                      Erase
                    </button>
                    <button
                      className="rounded-md border border-line bg-white px-3 py-2 text-sm"
                      onClick={() => {
                        const next = clearFen();
                        setFen(next);
                        setFenDraft(next);
                        setPlayedMoves([]);
                      }}
                    >
                      Clear board
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-semibold" htmlFor="fen-input">
                    Current FEN
                  </label>
                  <textarea
                    id="fen-input"
                    className="min-h-20 w-full rounded-md border border-line bg-white p-3 text-sm"
                    value={fenDraft}
                    onChange={(event) => setFenDraft(event.target.value)}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white" onClick={applyFenDraft}>
                      Apply FEN
                    </button>
                    <button className="rounded-md border border-line px-3 py-2 text-sm font-semibold" onClick={() => void copyFen()}>
                      Copy FEN
                    </button>
                    <a className="rounded-md border border-line px-3 py-2 text-sm font-semibold" href={lichessUrl} target="_blank" rel="noreferrer">
                      Open Lichess
                    </a>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold" htmlFor="sample-fen">
                    Quick positions
                  </label>
                  <select
                    id="sample-fen"
                    className="w-full rounded-md border border-line bg-white p-3 text-sm"
                    onChange={(event) => resetBoard(event.target.value)}
                    value=""
                  >
                    <option value="" disabled>
                      Choose a sample or recognized FEN
                    </option>
                    {SAMPLE_FENS.map((sample) => (
                      <option key={sample.label} value={sample.fen}>
                        {sample.label}
                      </option>
                    ))}
                    {diagrams.map((diagram, index) => (
                      <option key={diagram.id} value={diagram.fen}>
                        PDF diagram {index + 1}, {Math.round(diagram.confidence * 100)} percent confidence
                      </option>
                    ))}
                  </select>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      className="rounded-md border border-line px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!expectedLine?.sanMoves.length}
                      onClick={playExpectedMove}
                    >
                      Play next book move
                    </button>
                    <button className="rounded-md border border-line px-3 py-2 text-sm font-semibold" onClick={undoMove}>
                      Undo
                    </button>
                    <button className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white" onClick={() => void analyzePosition()}>
                      Analyze
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-md border border-line bg-panel p-4">
              <h2 className="mb-3 text-lg font-semibold">PDF page view</h2>
              {currentPreview ? (
                <div className="relative mx-auto max-h-[720px] overflow-auto rounded-md border border-line bg-white">
                  <div className="relative inline-block">
                    <img className="max-w-none" src={currentPreview.imageUrl} alt={`Rendered PDF page ${currentPage + 1}`} />
                    {visiblePageDiagrams.map((diagram) => (
                      <button
                        key={diagram.id}
                        className="absolute border-2 border-accent bg-[#147c6c33]"
                        style={{
                          left: diagram.bbox.x,
                          top: diagram.bbox.y,
                          width: diagram.bbox.width,
                          height: diagram.bbox.height,
                        }}
                        title={`Detected diagram, ${Math.round(diagram.confidence * 100)} percent confidence`}
                        onClick={() => selectDiagram(diagram)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-line p-8 text-center text-sm text-muted">
                  The rendered page will appear here after opening a PDF.
                </div>
              )}
            </div>
          </section>

          <aside className="grid gap-4">
            <div className="rounded-md border border-line bg-panel p-4">
              <h2 className="text-lg font-semibold">Recognition</h2>
              <p className="mb-3 text-sm text-muted">
                Automatic recognition is best effort. Low-confidence diagrams should be corrected before analysis.
              </p>
              <div className="space-y-3">
                {diagrams.map((diagram, index) => (
                  <button
                    key={diagram.id}
                    className={`block w-full rounded-md border p-3 text-left ${diagram.id === selectedDiagram?.id ? "border-accent bg-[#e8f5f1]" : "border-line bg-white"}`}
                    onClick={() => selectDiagram(diagram)}
                  >
                    <div className="flex gap-3">
                      {diagram.sourceCropUrl ? <img className="h-20 w-20 rounded object-cover" src={diagram.sourceCropUrl} alt={`Detected chess diagram ${index + 1}`} /> : null}
                      <div>
                        <p className="font-semibold">Diagram {index + 1}</p>
                        <p className="text-sm text-muted">Page {diagram.pageIndex + 1}, confidence {Math.round(diagram.confidence * 100)} percent</p>
                        {diagram.notes.map((note) => (
                          <p key={note} className="mt-1 text-xs text-warn">
                            {note}
                          </p>
                        ))}
                      </div>
                    </div>
                  </button>
                ))}
                {diagrams.length === 0 ? <p className="rounded-md bg-background p-3 text-sm text-muted">No detected diagrams yet.</p> : null}
              </div>
            </div>

            <div className="rounded-md border border-line bg-panel p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Book line</h2>
                <button className="rounded-md border border-line px-3 py-2 text-sm font-semibold" onClick={() => void copyPgn()}>
                  Copy PGN
                </button>
              </div>
              <textarea
                className="mb-2 min-h-28 w-full rounded-md border border-line bg-white p-3 text-sm"
                value={ocrTextDraft}
                onChange={(event) => setOcrTextDraft(event.target.value)}
                placeholder="Paste or correct OCR move text here."
              />
              <button className="mb-3 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white" onClick={reparseOcrDraft}>
                Parse moves
              </button>
              <div className="rounded-md bg-background p-3 text-sm">
                <p className="font-semibold">Recognized moves</p>
                <p className="mt-1 leading-6">{expectedLine?.sanMoves.join(" ") || "No legal move line parsed yet."}</p>
                {expectedLine?.parseErrors.length ? (
                  <p className="mt-2 text-warn">Unparsed tokens: {expectedLine.parseErrors.join(", ")}</p>
                ) : null}
              </div>
              <div className="mt-3 rounded-md bg-background p-3 text-sm" data-testid="played-moves">
                <p className="font-semibold">Played moves</p>
                <p className="mt-1 leading-6">{playedMoves.length ? playedMoves.join(" ") : "No moves played yet."}</p>
                {deviationPly ? <p className="mt-2 text-bad">Deviation on ply {deviationPly}. Engine analysis started.</p> : null}
              </div>
            </div>

            {engineEval || engineStatus !== "idle" ? (
              <div className="rounded-md border border-line bg-panel p-4">
                <h2 className="text-lg font-semibold">Analysis</h2>
                <p className="text-sm text-muted">{engineStatus}</p>
                <div className="mt-3 rounded-md bg-background p-3 text-sm">
                  <p className="font-semibold">{evalText}</p>
                  <p className="mt-1 text-muted">Best move: {engineEval?.bestMove ?? "none yet"}</p>
                  <p className="mt-1 break-words text-muted">PV: {engineEval?.pv.join(" ") || "none yet"}</p>
                </div>
              </div>
            ) : null}

            <div className="rounded-md border border-line bg-panel p-4">
              <h2 className="text-lg font-semibold">AI coach</h2>
              <p className="text-sm text-muted">{aiStatus}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!expectedLine?.sanMoves.length}
                  onClick={() => void askAi("line-summary")}
                >
                  Summarize book line
                </button>
                <button
                  className="rounded-md border border-line px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!deviationPly}
                  onClick={() => void askAi("deviation")}
                >
                  Explain deviation
                </button>
              </div>
              <div className="mt-3 rounded-md bg-background p-3 text-sm">
                {aiResult ? (
                  <>
                    <p className={`font-semibold ${aiResult.ok ? "text-foreground" : "text-warn"}`}>{aiResult.title}</p>
                    <p className="mt-2 whitespace-pre-wrap leading-6 text-muted">{aiResult.explanation}</p>
                  </>
                ) : (
                  <p className="text-muted">
                    Optional. Add <span className="font-semibold">OPENROUTER_API_KEY</span> on Vercel to enable short chess explanations.
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-md border border-line bg-panel p-4">
              <h2 className="text-lg font-semibold">Your history</h2>
              <div className="space-y-2">
                {sessions.slice(0, 10).map((session) => (
                  <div key={session.id} className="rounded-md border border-line bg-white p-3 text-sm">
                    <p className="font-semibold">{session.fileName}</p>
                    <p className="text-muted">
                      {session.diagrams.length} diagram{session.diagrams.length === 1 ? "" : "s"}, {new Date(session.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))}
                {sessions.length === 0 ? <p className="rounded-md bg-background p-3 text-sm text-muted">No saved studies yet.</p> : null}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

function stripCanvas(page: RenderedPage): PdfPagePreview {
  return {
    pageIndex: page.pageIndex,
    width: page.width,
    height: page.height,
    thumbnailUrl: page.thumbnailUrl,
    imageUrl: page.imageUrl,
  };
}

function mergeById<T>(current: T[], incoming: T[], idOf: (item: T) => string): T[] {
  const map = new Map(current.map((item) => [idOf(item), item]));
  for (const item of incoming) {
    map.set(idOf(item), item);
  }
  return Array.from(map.values());
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatEval(evalResult?: EngineEval): string {
  if (!evalResult) {
    return "Waiting for result";
  }
  if (evalResult.mateIn !== undefined) {
    return `Mate ${evalResult.mateIn > 0 ? "+" : ""}${evalResult.mateIn} at depth ${evalResult.depth}`;
  }
  const pawns = ((evalResult.scoreCp ?? 0) / 100).toFixed(2);
  return `${Number(pawns) > 0 ? "+" : ""}${pawns} at depth ${evalResult.depth}`;
}
