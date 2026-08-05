import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

const viewerRoot = path.resolve("build/viewer");
let server: Server;
let viewerUrl: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    void serveViewerFile(request.url ?? "/", response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Viewer image-export server did not bind a TCP port.");
  }
  viewerUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
});

test("exports an independent transparent PNG without DOM chrome", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#scene canvas")).toBeVisible();

  await page.locator("#camera-view-map").click();
  await page.evaluate(() => {
    const sentinel = document.createElement("div");
    sentinel.id = "image-export-dom-sentinel";
    sentinel.style.cssText =
      "position:fixed;inset:0 auto auto 0;width:120px;height:120px;" +
      "z-index:99999;background:#ff00ff";
    document.body.append(sentinel);
  });

  await page.locator("#image-export-open").click();
  await expect(page.locator("#image-export-dialog")).toBeVisible();
  await expect(page.locator("#image-export-view")).toHaveValue(
    "current-view",
  );
  await expect(page.locator("#image-export-current-view")).toContainText(
    "Map view is inherited exactly",
  );
  await expect(page.locator("#image-export-custom-camera")).toBeHidden();
  await page.locator("#image-export-view").selectOption("custom");
  await expect(page.locator("#image-export-custom-camera")).toBeVisible();
  await page.locator("#image-export-angle").selectOption("top-down");
  await page.locator("#image-export-fit").selectOption("current-scope");
  await page.locator(".image-export-advanced-lens > summary").click();
  await page
    .locator("#image-export-projection")
    .selectOption("orthographic");
  await page.locator("#image-export-width").fill("1200");
  await page.locator("#image-export-height").fill("700");
  await page
    .locator("#image-export-background")
    .selectOption("transparent");
  await page.locator("#image-export-labels").uncheck();
  await page.locator("#image-export-legend").uncheck();
  await page.locator("#image-export-submit").click();

  const download = page.locator("#image-export-download");
  await expect(download).toBeVisible({ timeout: 30_000 });
  await expect(download).toHaveAttribute(
    "download",
    /-orthographic-top-down-current-scope-1200x700\.png$/u,
  );
  const decoded = await page.evaluate(async () => {
    const anchor = document.querySelector<HTMLAnchorElement>(
      "#image-export-download",
    );
    if (!anchor?.href) throw new Error("Prepared PNG URL is missing.");
    const image = new Image();
    image.src = anchor.href;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas2D unavailable.");
    context.drawImage(image, 0, 0);
    const corner = [...context.getImageData(0, 0, 1, 1).data];
    const sample = context.getImageData(
      0,
      0,
      image.naturalWidth,
      image.naturalHeight,
    ).data;
    let maximumAlpha = 0;
    for (let offset = 3; offset < sample.length; offset += 400) {
      maximumAlpha = Math.max(maximumAlpha, sample[offset] ?? 0);
    }
    return {
      width: canvas.width,
      height: canvas.height,
      corner,
      maximumAlpha,
    };
  });
  const downloadEvent = page.waitForEvent("download");
  await download.click();
  const preparedDownload = await downloadEvent;
  const stream = await preparedDownload.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const png = Buffer.concat(chunks);

  expect(decoded).toMatchObject({
    width: 1_200,
    height: 700,
  });
  expect([...png.subarray(0, 8)]).toEqual([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  expect(decoded.corner[3]).toBe(0);
  expect(decoded.corner.slice(0, 3)).not.toEqual([255, 0, 255]);
  expect(decoded.maximumAlpha).toBeGreaterThan(0);
});

test("context loss disables export with an accessible explanation", async ({
  page,
}) => {
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#scene canvas")).toBeVisible();
  const lost = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#scene canvas");
    const context =
      canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    const extension = context?.getExtension("WEBGL_lose_context");
    if (extension === null || extension === undefined) return false;
    extension.loseContext();
    return true;
  });
  test.skip(!lost, "WEBGL_lose_context is unavailable in this browser.");

  await expect(page.locator("#scene")).toHaveAttribute(
    "data-webgl-available",
    "false",
  );
  await expect(page.locator("#image-export-open")).toBeDisabled();
  await expect(page.locator("#camera-view-3d")).toBeDisabled();
  await expect(page.locator("#camera-view-map")).toBeDisabled();
  await expect(page.locator("#scene canvas")).toHaveAttribute(
    "aria-label",
    /WebGL context was lost/u,
  );
  await expect(page.getByRole("alert")).toContainText(
    "The WebGL context was lost",
  );
});

test("closing image export with Escape preserves the selected entity", async ({
  page,
}) => {
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#camera-focus-selection")).toBeHidden();
  await page.getByRole("tab", { name: "Explore" }).click();
  await page
    .locator("#building-search")
    .fill("apps/viewer/src/main.ts");
  await page
    .locator(
      '.search-result-button[title="apps/viewer/src/main.ts"]',
    )
    .click();
  await expect(page.locator("#camera-focus-selection")).toBeVisible();
  await expect(page.locator("#camera-focus-selection")).toBeEnabled();

  await page.locator("#image-export-open").click();
  await expect(page.locator("#image-export-dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.locator("#image-export-dialog")).not.toBeVisible();
  await expect(page.locator("#camera-focus-selection")).toBeVisible();
  await expect(page.locator("#camera-focus-selection")).toBeEnabled();
});

test("initial WebGL failure leaves the rest of the viewer accessible", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value(
        this: HTMLCanvasElement,
        contextId: string,
        ...arguments_: unknown[]
      ): unknown {
        if (
          contextId === "webgl" ||
          contextId === "webgl2" ||
          contextId === "experimental-webgl"
        ) {
          return null;
        }
        return Reflect.apply(original, this, [contextId, ...arguments_]);
      },
    });
  });
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });

  const fallback = page.locator(".webgl-unavailable");
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText("3D viewer unavailable");
  await expect(page.locator("#image-export-open")).toBeDisabled();
  await expect(page.locator("#model-name")).not.toBeEmpty();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeEnabled();

  // The drill-down return path must remain safe when no scene canvas exists.
  // Expose the normally contextual action to emulate a capability loss while
  // source detail was open, then verify the accessible fallback survives.
  await page.locator("#building-source-structure-return").evaluate((button) => {
    const returnButton = button as HTMLButtonElement;
    returnButton.hidden = false;
    returnButton.click();
  });
  await expect(fallback).toBeVisible();
  await expect(page.locator("#status")).toHaveText(
    "Returned to the selected building in the city.",
  );
  expect(pageErrors).toEqual([]);
});

async function serveViewerFile(
  requestUrl: string,
  response: import("node:http").ServerResponse,
): Promise<void> {
  try {
    const pathname = decodeURIComponent(
      new URL(requestUrl, "http://viewer").pathname,
    );
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.resolve(viewerRoot, relativePath);
    if (
      filePath !== viewerRoot &&
      !filePath.startsWith(`${viewerRoot}${path.sep}`)
    ) {
      response.writeHead(403).end();
      return;
    }
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
