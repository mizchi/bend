import { test, expect } from "@playwright/test";

test("the browser example runs generated WGSL repeatedly and reports load failures", async ({
  page,
}) => {
  await page.goto("/index.html");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Run on GPU" }).click();
    await expect(page.getByRole("status")).toHaveText("Completed");
    await expect(page.locator("#stdout")).toHaveText("4294443008");
    await expect(page.locator("#details")).toContainText("511 tasks");
  }
  await page.route("**/program.json", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await page.getByRole("button", { name: "Run on GPU" }).click();
  await expect(page.getByRole("status")).toHaveText("Failed");
  await expect(page.locator("#details")).toContainText("404");
  await expect(page.locator("#stdout")).toBeEmpty();
});
