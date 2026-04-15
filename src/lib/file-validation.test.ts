import { describe, expect, it } from "vitest";
import { validatePdfFile } from "@/lib/file-validation";

function makeFile(bytes: string, name = "book.pdf", type = "application/pdf") {
  return new File([bytes], name, { type });
}

describe("validatePdfFile", () => {
  it("accepts a PDF signature", async () => {
    await expect(validatePdfFile(makeFile("%PDF-1.7"))).resolves.toEqual({ ok: true });
  });

  it("rejects non-PDF signatures", async () => {
    const result = await validatePdfFile(makeFile("<script>", "book.pdf", "application/pdf"));
    expect(result.ok).toBe(false);
  });

  it("rejects non-PDF extensions", async () => {
    const result = await validatePdfFile(makeFile("%PDF-1.7", "book.txt", "text/plain"));
    expect(result.ok).toBe(false);
  });
});
