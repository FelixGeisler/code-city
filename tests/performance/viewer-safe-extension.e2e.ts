import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
const root = path.resolve("build/viewer"); let server: Server; let url: string;
test.beforeAll(async () => { server = createServer((request, response) => void serve(request.url ?? "/", response)); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); const address = server.address(); if (!address || typeof address === "string") throw new Error("Viewer server did not bind."); url = `http://127.0.0.1:${address.port}`; });
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
test("safe extension preview applies every declarative result and export is digest-bound", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Metrics" }).click();
  await page.getByLabel("Public preset").selectOption("complexity-focus");
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeDisabled();
  await page.getByRole("button", { name: "Preview safely" }).click();
  await expect(page.locator("#safe-extension-status")).toContainText("Preview applied");
  await expect(page.locator("#visualization-mode-status")).toContainText(
    "Declarative extension preview applied",
  );
  await expect(page.locator("#legend")).toContainText("Complexity pressure");
  await expect(page.locator("#legend")).toContainText("high-pressure-overlay");
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeEnabled();

  await page.locator("#safe-extension-json").evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    const configuration = JSON.parse(field.value) as Record<string, unknown>;
    configuration["name"] = "Changed without an input event";
    field.value = JSON.stringify(configuration);
  });
  await page.getByRole("button", { name: "Export JSON" }).click();
  await expect(page.locator("#safe-extension-status")).toContainText(
    "changed after preview",
  );
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeDisabled();
  await expect(page.locator("#visualization-mode-status")).not.toContainText(
    "Declarative extension preview applied",
  );
  await expect(page.locator("#legend")).not.toContainText(
    "high-pressure-overlay",
  );

  await page.getByRole("button", { name: "Preview safely" }).click();
  await expect(page.locator("#safe-extension-status")).toContainText("Preview applied");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("code-city-extension.json");
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeDisabled();

  await page.getByRole("button", { name: "Preview safely" }).click();
  await expect(page.locator("#safe-extension-status")).toContainText("Preview applied");
  await page.locator("#safe-extension-preset").dispatchEvent("change");
  await expect(page.locator("#visualization-mode-status")).not.toContainText(
    "Declarative extension preview applied",
  );
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeDisabled();

  await page.getByLabel("Extension configuration (JSON)").fill("{invalid");
  await page.getByRole("button", { name: "Preview safely" }).click();
  await expect(page.locator("#safe-extension-status")).toContainText("valid JSON");
  await expect(page.getByRole("button", { name: "Preview safely" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeDisabled();

  await page.locator("#safe-extension-preset").dispatchEvent("change");
  await page.evaluate(() => {
    const preview = document.querySelector<HTMLButtonElement>(
      "#safe-extension-preview",
    )!;
    const source = document.querySelector<HTMLTextAreaElement>(
      "#safe-extension-json",
    )!;
    preview.click();
    source.value += " ";
    source.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#safe-extension-status")).toContainText(
    "Configuration changed",
  );
  await expect(page.getByRole("button", { name: "Preview safely" })).toBeEnabled();
});
async function serve(requestUrl: string, response: import("node:http").ServerResponse): Promise<void> { try { const pathname = decodeURIComponent(new URL(requestUrl, "http://viewer").pathname); const file = path.resolve(root, pathname === "/" ? "index.html" : pathname.slice(1)); if (file !== root && !file.startsWith(`${root}${path.sep}`)) return void response.writeHead(403).end(); response.writeHead(200, { "Content-Type": path.extname(file) === ".html" ? "text/html; charset=utf-8" : path.extname(file) === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream" }); response.end(await fs.readFile(file)); } catch { if (!response.headersSent) response.writeHead(404).end(); } }
