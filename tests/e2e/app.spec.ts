import { expect, test } from "@playwright/test";

test("loads the browser-only chess workspace", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Chess2pdf" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next →" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your history" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Demo line" })).toHaveCount(0);
  await expect(page.getByText("Free browser-only chess PDF reader")).toHaveCount(0);
  await expect(page.getByText("Demo mode, no PDF loaded.")).toHaveCount(0);

  expect(requests.some((url) => url.includes("/api/upload"))).toBe(false);
});
