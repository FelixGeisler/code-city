import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
const root = path.resolve("build/viewer"); let server: Server; let url: string;
test.beforeAll(async () => { server = createServer((request, response) => void serve(request.url ?? "/", response)); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); const address = server.address(); if (!address || typeof address === "string") throw new Error("Viewer server did not bind."); url = `http://127.0.0.1:${address.port}`; });
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
test("safe extension preset is accessible and preview reports diagnostics", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Metrics" }).click();
  await page.getByLabel("Public preset").selectOption("complexity-focus");
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeDisabled();
  await page.getByRole("button", { name: "Preview safely" }).click();
  await expect(page.locator("#safe-extension-status")).toContainText("Preview complete");
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeEnabled();
  await page.getByLabel("Extension configuration (JSON)").fill("{invalid");
  await page.getByRole("button", { name: "Preview safely" }).click();
  await expect(page.locator("#safe-extension-status")).toContainText("valid JSON");
  await expect(page.getByRole("button", { name: "Preview safely" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeDisabled();
});
async function serve(requestUrl: string, response: import("node:http").ServerResponse): Promise<void> { try { const pathname = decodeURIComponent(new URL(requestUrl, "http://viewer").pathname); const file = path.resolve(root, pathname === "/" ? "index.html" : pathname.slice(1)); if (file !== root && !file.startsWith(`${root}${path.sep}`)) return void response.writeHead(403).end(); response.writeHead(200, { "Content-Type": path.extname(file) === ".html" ? "text/html; charset=utf-8" : path.extname(file) === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream" }); response.end(await fs.readFile(file)); } catch { if (!response.headersSent) response.writeHead(404).end(); } }
