import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "node_modules", "onnxruntime-web", "dist");
const targetDir = join(root, "public", "ort");

if (!existsSync(sourceDir)) {
  console.warn("[copy-ort-assets] onnxruntime-web is not installed yet; skipping.");
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

for (const fileName of readdirSync(sourceDir)) {
  if (fileName.startsWith("ort-wasm-simd-threaded") && (fileName.endsWith(".wasm") || fileName.endsWith(".mjs"))) {
    copyFileSync(join(sourceDir, fileName), join(targetDir, fileName));
  }
}
