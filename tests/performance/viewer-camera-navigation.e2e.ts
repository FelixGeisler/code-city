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

const REMOVED_VIEW_CONTROLS = [
  "#camera-view-switch",
  "#camera-view-3d",
  "#camera-view-map",
  "#camera-view-advanced",
  "#camera-projection",
  "#camera-isometric",
  "#camera-top-down",
  "#camera-view-status",
] as const;

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

test("viewer exposes one perspective orbit camera with working city fitting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await openPerformanceViewer(page);
  const canvas = page.locator("#scene canvas");
  await expect(canvas).toBeVisible();

  for (const selector of REMOVED_VIEW_CONTROLS) {
    await expect(page.locator(selector)).toHaveCount(0);
  }
  await expect(
    page.getByRole("group", { name: "Camera controls" }),
  ).toBeVisible();
  await expect(page.locator("#camera-fit-city")).toBeEnabled();
  await expect(page.locator("#camera-focus-selection")).toBeHidden();
  await expect(page.locator("#camera-controls-hint")).toContainText(
    "Drag to orbit",
  );

  const initial = await readCamera(page);
  expectPerspectiveOrbit(initial);

  await dragCanvas(page, canvas, 95, 0);
  await expect
    .poll(async () =>
      vectorDistance(
        normalizedCameraDirection(await readCamera(page)),
        normalizedCameraDirection(initial),
      ),
    )
    .toBeGreaterThan(0.05);
  const orbited = await readCamera(page);
  expectPerspectiveOrbit(orbited);

  await dragCanvas(page, canvas, 70, 45, "right");
  await expect
    .poll(async () =>
      vectorDistance((await readCamera(page)).target, orbited.target),
    )
    .toBeGreaterThan(0.05);
  const panned = await readCamera(page);
  expectPerspectiveOrbit(panned);

  const distanceBeforeWheel = cameraDistance(panned);
  await page.mouse.wheel(0, -600);
  await expect
    .poll(async () =>
      Math.abs(cameraDistance(await readCamera(page)) - distanceBeforeWheel),
    )
    .toBeGreaterThan(0.1);

  await page.locator("#camera-fit-city").click();
  await waitForStableCamera(page);
  const firstFit = await readCamera(page);
  expectPerspectiveOrbit(firstFit);

  await page.locator("#camera-fit-city").click();
  await waitForStableCamera(page);
  expectPerspectiveOrbit(await readCamera(page));
});

test("city and selection framing stay in the fixed 3D viewer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await openPerformanceViewer(page);
  await page.locator("#viewer-tab-explore").click();
  await page.locator("#building-search").fill("main.ts");
  await page
    .locator("#search-results .search-result-button")
    .filter({ hasText: "main.ts" })
    .click();
  await expect(page.locator("#camera-focus-selection")).toBeVisible();
  await expect(page.locator("#camera-focus-selection")).toBeEnabled();

  const beforeFocus = await readCamera(page);
  await page.locator("#camera-focus-selection").click();
  await waitForStableCamera(page);
  const focused = await readCamera(page);
  expectPerspectiveOrbit(focused);
  expect(
    vectorDistance(
      normalizedCameraDirection(focused),
      normalizedCameraDirection(beforeFocus),
    ),
  ).toBeLessThan(1e-5);

  const focusedDistance = cameraDistance(focused);
  await page.locator("#camera-fit-city").click();
  await waitForStableCamera(page);
  const fittedCity = await readCamera(page);
  expectPerspectiveOrbit(fittedCity);
  expect(cameraDistance(fittedCity)).toBeGreaterThan(focusedDistance);
  expect(
    vectorDistance(
      normalizedCameraDirection(fittedCity),
      normalizedCameraDirection(focused),
    ),
  ).toBeLessThan(1e-5);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("group", { name: "Camera controls" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);
  for (const selector of REMOVED_VIEW_CONTROLS) {
    await expect(page.locator(selector)).toHaveCount(0);
  }
});

async function openPerformanceViewer(page: Page): Promise<void> {
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
}

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
  button: "left" | "right" = "left",
): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("Viewer canvas has no bounding box.");
  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.65;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button });
  await page.mouse.move(startX + deltaX, startY + deltaY, {
    steps: 4,
  });
  await page.mouse.up({ button });
}

async function waitForStableCamera(page: Page): Promise<void> {
  await page.waitForTimeout(600);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect
    .poll(
      async () => {
        const before = await readCamera(page);
        await page.waitForTimeout(80);
        const after = await readCamera(page);
        return cameraSnapshotDistance(before, after);
      },
      { timeout: 5_000 },
    )
    .toBeLessThan(1e-4);
}

function expectPerspectiveOrbit(camera: CameraSnapshot): void {
  expect(camera.projection).toBe("perspective");
  expect(camera.navigationMode).toBe("orbit");
  expect(cameraDistance(camera)).toBeGreaterThan(0);
  expect(camera.up[1]).toBeGreaterThan(0.99);
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

function normalizedCameraDirection(
  camera: CameraSnapshot,
): readonly [number, number, number] {
  const direction = cameraDirection(camera);
  const length = Math.hypot(...direction);
  if (length === 0) return [0, 0, 0];
  return direction.map((value) => value / length) as [
    number,
    number,
    number,
  ];
}

function cameraDistance(camera: CameraSnapshot): number {
  return Math.hypot(...cameraDirection(camera));
}

function cameraSnapshotDistance(
  left: CameraSnapshot,
  right: CameraSnapshot,
): number {
  return Math.max(
    vectorDistance(left.position, right.position),
    vectorDistance(left.target, right.target),
    vectorDistance(left.up, right.up),
    Math.abs(left.zoom - right.zoom),
    Math.abs(left.viewHeight - right.viewHeight),
  );
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
