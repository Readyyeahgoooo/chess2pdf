import type { EngineEval } from "@/lib/types";

export function parseEngineInfo(line: string, fen: string): EngineEval | null {
  if (!line.startsWith("info ")) {
    return null;
  }

  const depthMatch = line.match(/\bdepth\s+(\d+)/);
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
  const pvMatch = line.match(/\bpv\s+(.+)$/);

  if (!depthMatch || (!cpMatch && !mateMatch)) {
    return null;
  }

  return {
    fen,
    depth: Number(depthMatch[1]),
    scoreCp: cpMatch ? Number(cpMatch[1]) : undefined,
    mateIn: mateMatch ? Number(mateMatch[1]) : undefined,
    pv: pvMatch ? pvMatch[1].split(/\s+/).filter(Boolean) : [],
  };
}

export class StockfishClient {
  private worker?: Worker;
  private latest?: EngineEval;

  evaluate(fen: string, depth = 10): Promise<EngineEval> {
    if (typeof window === "undefined") {
      return Promise.reject(new Error("Stockfish runs in the browser."));
    }

    this.ensureWorker();
    this.latest = undefined;

    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error("Stockfish worker is unavailable."));
        return;
      }

      const timeout = window.setTimeout(() => {
        reject(new Error("Stockfish timed out. Try a lower depth."));
      }, 20_000);

      const onMessage = (event: MessageEvent<string>) => {
        const message = String(event.data);
        const parsed = parseEngineInfo(message, fen);
        if (parsed) {
          this.latest = parsed;
        }

        if (message.startsWith("bestmove")) {
          window.clearTimeout(timeout);
          worker.removeEventListener("message", onMessage);
          const bestMove = message.split(/\s+/)[1];
          resolve({
            ...(this.latest ?? { fen, depth: 0, pv: [] }),
            bestMove: bestMove === "(none)" ? undefined : bestMove,
          });
        }
      };

      worker.addEventListener("message", onMessage);
      worker.postMessage("uci");
      worker.postMessage("isready");
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${depth}`);
    });
  }

  stop() {
    this.worker?.postMessage("stop");
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
  }

  private ensureWorker() {
    if (!this.worker) {
      this.worker = new Worker("/stockfish/stockfish-18-lite-single.js");
    }
  }
}
