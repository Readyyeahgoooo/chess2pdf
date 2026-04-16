import { MAX_PDF_BYTES } from "@/lib/constants";

export type FileValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function validatePdfFile(file: File): Promise<FileValidationResult> {
  if (file.size <= 0) {
    return { ok: false, reason: "This file is empty." };
  }

  if (file.size > MAX_PDF_BYTES) {
    return { ok: false, reason: "PDFs are limited to 100 MB in the free browser workflow." };
  }

  const hasPdfName = file.name.toLowerCase().endsWith(".pdf");
  const hasPdfType = file.type === "application/pdf" || file.type === "";
  if (!hasPdfName || !hasPdfType) {
    return { ok: false, reason: "Please choose a PDF file." };
  }

  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const signature = Array.from(header)
    .map((byte) => String.fromCharCode(byte))
    .join("");

  if (signature !== "%PDF-") {
    return { ok: false, reason: "The file does not have a valid PDF signature." };
  }

  return { ok: true };
}
