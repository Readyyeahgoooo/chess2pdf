import { expect, test } from "@playwright/test";

test("loads the browser-only chess workspace", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Chess2pdf" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play next book move" })).toBeVisible();
  await expect(page.getByText("PDF bytes stay in this browser")).toBeVisible();

  await page.getByRole("button", { name: "Play next book move" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByTestId("played-moves")).toContainText("e4");

  expect(requests.some((url) => url.includes("/api/upload"))).toBe(false);
});
