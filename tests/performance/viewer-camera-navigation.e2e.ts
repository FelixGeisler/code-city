import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

interface CameraSnapshot {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly projection: "orthographic" | "perspective";
  readonly navigationMode: "orbit" | "top-down";
  readonly zoom: number;
  readonly viewHeight: number;
}

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
    throw new Error("Viewer camera-navigation server did not bind a TCP port.");
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

test("top-down behaves like a resettable map and restores orbit navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto(`${viewerUrl}/?performance=1`, {
    waitUntil: "domcontentloaded",
  });
  const canvas = page.locator("#scene canvas");
  await expect(canvas).toBeVisible();
  await page.waitForFunction(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: { readonly ready?: boolean };
        }
      ).__CODE_CITY_PERFORMANCE__?.ready === true,
  );
  const initial = await readCamera(page);

  await expect(page.locator("#camera-view-3d")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#camera-selected")).toHaveCount(0);
  await expect(page.locator("#camera-whole-city")).toHaveCount(0);
  await page.locator("#camera-view-3d").focus();
  await page.keyboard.press("ArrowRight");
  // Begin the pan while the 520 ms preset transition is still active. The
  // control handoff must finish the canonical frame before applying the drag.
  await dragCanvas(page, canvas, 110, 75);

  await expect
    .poll(async () => (await readCamera(page)).navigationMode)
    .toBe("top-down");
  const panned = await readCamera(page);
  expectTopDownFrame(panned);
  expect(panned.projection).toBe("orthographic");
  expect(panned.target[1]).toBeCloseTo(initial.target[1], 8);
  expect(cameraDistance(panned)).toBeGreaterThan(0);
  expect(
    Math.abs(panned.target[0] - initial.target[0]) +
      Math.abs(panned.target[2] - initial.target[2]),
  ).toBeGreaterThan(0.1);
  await expect(page.locator("#camera-view-map")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#camera-controls-hint")).toContainText(
    "Drag to pan",
  );

  const zoomBeforeWheel = panned.zoom;
  await page.mouse.wheel(0, -600);
  await expect
    .poll(async () => (await readCamera(page)).zoom)
    .toBeGreaterThan(zoomBeforeWheel);
  const zoomed = await readCamera(page);
  expectTopDownFrame(zoomed);
  expect(zoomed.target[1]).toBeCloseTo(initial.target[1], 8);

  await page.locator("#camera-view-map").click();
  await waitForTopDownReset(page, initial.target);
  const firstReset = await readCamera(page);
  expectTopDownFrame(firstReset);
  expect(firstReset.zoom).toBeCloseTo(1, 10);

  await dragCanvas(page, canvas, -85, 55);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(async () => {
      const camera = await readCamera(page);
      return (
        Math.abs(camera.target[0] - firstReset.target[0]) +
        Math.abs(camera.target[2] - firstReset.target[2])
      );
    })
    .toBeGreaterThan(0.1);
  await page.locator("#camera-view-map").click();
  await waitForTopDownReset(page, initial.target);
  const secondReset = await readCamera(page);
  expectFramesClose(secondReset, firstReset);

  await page.locator("#camera-view-3d").click();
  await expect
    .poll(async () => {
      const camera = await readCamera(page);
      const direction = cameraDirection(camera);
      return (
        camera.navigationMode === "orbit" &&
        Math.abs(direction[0]) > 0.1 &&
        Math.abs(direction[2]) > 0.1 &&
        camera.up[1] > 0.99
      );
    })
    .toBe(true);
  const isometric = await readCamera(page);
  expect(isometric.projection).toBe("perspective");
  await expect(page.locator("#camera-view-3d")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#camera-controls-hint")).toContainText(
    "Drag to orbit",
  );

  await dragCanvas(page, canvas, 95, 0);
  await expect
    .poll(async () =>
      vectorDistance(
        cameraDirection(await readCamera(page)),
        cameraDirection(isometric),
      ),
    )
    .toBeGreaterThan(0.05);
});

test("rapid scope framing stays canonical and projection diagnostics stay fresh", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto(`${viewerUrl}/?performance=1`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: { readonly ready?: boolean };
        }
      ).__CODE_CITY_PERFORMANCE__?.ready === true,
  );
  await page.locator("#viewer-tab-explore").click();
  await page.locator("#building-search").fill("main.ts");
  await page
    .locator("#search-results .search-result-button")
    .filter({ hasText: "main.ts" })
    .click();
  await page.locator("#viewer-tab-explore").click();
  await expect(page.locator("#isolate-district")).toBeEnabled();
  await page.locator("#isolate-district").click();
  await expect(page.locator("#show-whole-city")).toBeEnabled();
  await page.locator("#camera-view-map").click();
  await expect(page.locator("#camera-fit-scope")).toBeEnabled();
  await page.locator("#camera-fit-scope").click();
  await expect(page.locator("#show-whole-city")).toBeEnabled();
  await page.evaluate(() => {
    const map = document.querySelector<HTMLButtonElement>(
      "#camera-view-map",
    );
    const wholeCity = document.querySelector<HTMLButtonElement>(
      "#show-whole-city",
    );
    if (map === null || wholeCity === null) {
      throw new Error("Camera or scope control is unavailable.");
    }
    map.click();
    wholeCity.click();
  });

  await expect
    .poll(async () => {
      const camera = await readCamera(page);
      return (
        camera.navigationMode === "top-down" &&
        camera.projection === "orthographic" &&
        Math.abs(cameraDirection(camera)[0]) < 1e-8 &&
        Math.abs(cameraDirection(camera)[2]) < 1e-8
      );
    })
    .toBe(true);
  const rapidFrame = await readCamera(page);
  expectTopDownFrame(rapidFrame);

  await page.locator("#camera-view-map").click();
  await waitForTopDownReset(page, rapidFrame.target);
  const canonicalFrame = await readCamera(page);
  expect(rapidFrame.viewHeight).toBeCloseTo(canonicalFrame.viewHeight, 8);

  await page.locator("#camera-view-advanced > summary").click();
  await page.locator("#camera-projection").selectOption("perspective");
  await expect
    .poll(async () => (await readCamera(page)).projection)
    .toBe("perspective");
  expectTopDownFrame(await readCamera(page));
  await expect(page.locator("#camera-view-3d")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("#camera-view-map")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("#camera-view-status")).toHaveText(
    "Custom view",
  );
});

async function readCamera(page: Page): Promise<CameraSnapshot> {
  return await page.evaluate(() => {
    const diagnostics = (
      window as Window & {
        __CODE_CITY_PERFORMANCE__?: {
          readonly camera?: CameraSnapshot;
        };
      }
    ).__CODE_CITY_PERFORMANCE__;
    if (diagnostics?.camera === undefined) {
      throw new Error("Camera diagnostics are unavailable.");
    }
    return diagnostics.camera;
  });
}

async function dragCanvas(
  page: Page,
  canvas: ReturnType<Page["locator"]>,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("Viewer canvas has no bounding box.");
  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.65;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, {
    steps: 4,
  });
  await page.mouse.up();
}

async function waitForTopDownReset(
  page: Page,
  target: readonly [number, number, number],
): Promise<void> {
  await expect
    .poll(async () => {
      const camera = await readCamera(page);
      const direction = cameraDirection(camera);
      return (
        camera.navigationMode === "top-down" &&
        Math.abs(camera.target[0] - target[0]) < 1e-6 &&
        Math.abs(camera.target[1] - target[1]) < 1e-6 &&
        Math.abs(camera.target[2] - target[2]) < 1e-6 &&
        Math.abs(direction[0]) < 1e-6 &&
        direction[1] > 0 &&
        Math.abs(direction[2]) < 1e-6 &&
        Math.abs(camera.zoom - 1) < 1e-6
      );
    })
    .toBe(true);
}

function expectTopDownFrame(camera: CameraSnapshot): void {
  const direction = cameraDirection(camera);
  expect(direction[0]).toBeCloseTo(0, 8);
  expect(direction[1]).toBeGreaterThan(0);
  expect(direction[2]).toBeCloseTo(0, 8);
  expect(camera.up[0]).toBeCloseTo(0, 8);
  expect(camera.up[1]).toBeCloseTo(0, 8);
  expect(camera.up[2]).toBeCloseTo(-1, 8);
}

function expectFramesClose(
  actual: CameraSnapshot,
  expected: CameraSnapshot,
): void {
  for (const key of ["position", "target", "up"] as const) {
    actual[key].forEach((value, index) => {
      expect(value).toBeCloseTo(expected[key][index] ?? Number.NaN, 8);
    });
  }
  expect(actual.zoom).toBeCloseTo(expected.zoom, 8);
  expect(actual.viewHeight).toBeCloseTo(expected.viewHeight, 8);
  expect(actual.projection).toBe(expected.projection);
  expect(actual.navigationMode).toBe(expected.navigationMode);
}

function cameraDirection(
  camera: CameraSnapshot,
): readonly [number, number, number] {
  return [
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  ];
}

function cameraDistance(camera: CameraSnapshot): number {
  const direction = cameraDirection(camera);
  return Math.hypot(...direction);
}

function vectorDistance(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return Math.hypot(
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  );
}

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
