import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const viewerRoot = path.resolve("build/viewer");
let server: Server;
let viewerUrl: string;

function contentType(file: string): string {
  switch (path.extname(file)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

async function serve(requestUrl: string, response: ServerResponse): Promise<void> {
  try {
    const pathname = decodeURIComponent(
      new URL(requestUrl, "http://viewer").pathname,
    );
    const file = path.resolve(
      viewerRoot,
      pathname === "/" ? "index.html" : pathname.slice(1),
    );
    if (file !== viewerRoot && !file.startsWith(`${viewerRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(file) });
    response.end(await fs.readFile(file));
  } catch {
    if (!response.headersSent) response.writeHead(404).end();
  }
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    void serve(request.url ?? "/", response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  viewerUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

test("Auto compact fit requires confirmation before exact fidelity downloads", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#export-actions-menu > summary").click();
  await page.getByRole("button", { name: "Export print file" }).click();

  const dialog = page.getByRole("dialog", { name: "Export print file" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#print-fit")).toHaveValue("auto");
  await expect(dialog).not.toContainText(/Expert: allow scaling below/u);
  await dialog.locator("#print-scale").fill("0.2");
  await dialog.locator("#print-legend-download-enabled").uncheck();

  await dialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(dialog.locator("#print-export-preflight")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    dialog.locator("#print-export-compact-confirmation"),
  ).toBeVisible();
  await expect(
    dialog.locator("#print-export-compact-confirmation-summary"),
  ).toContainText("No print file has been created yet");
  await expect(dialog.locator("#print-export-channels-title")).toHaveText(
    "Tool allocation",
  );
  const firstAllocation = dialog.locator("#print-export-channels li").first();
  await expect(firstAllocation).toContainText(/^(?:Tool|Channel) 1:/u);
  await expect(firstAllocation).toContainText("Base");
  await expect(firstAllocation).toContainText("Identity");
  await expect(dialog.locator("#print-export-fidelity-wrap")).toBeVisible();
  await expect(
    dialog.locator("#print-export-fidelity-summary"),
  ).toContainText(/proposed applied scale 0\.2/iu);
  await expect(
    dialog.locator("#print-export-fidelity-summary"),
  ).toContainText("profile-safe scale 0.4");
  await expect(
    dialog.locator("#print-export-fidelity-violations li").first(),
  ).toContainText(/mm resulting.*mm profile minimum/u);

  const printDownload = dialog.locator("#print-export-download");
  const manifestDownload = dialog.locator(
    "#print-export-manifest-download",
  );
  await expect(printDownload).toBeHidden();
  await expect(manifestDownload).toBeHidden();

  await dialog.getByRole("button", {
    name: "Confirm compact fit and create file",
  }).click();
  await expect(printDownload).toBeVisible();
  await expect(manifestDownload).toBeVisible();
  await expect(manifestDownload).toHaveAttribute(
    "download",
    /\.print-manifest\.json$/u,
  );
  await expect(manifestDownload).toHaveAttribute("href", /^blob:/u);

  await dialog.locator("#print-scale").fill("0.3");
  await expect(dialog.locator("#print-export-preflight")).toBeHidden();
  await expect(manifestDownload).toBeHidden();
  await expect(manifestDownload).not.toHaveAttribute("href", /.+/u);
});
