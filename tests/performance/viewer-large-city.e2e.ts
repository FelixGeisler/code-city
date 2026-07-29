import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

interface PerformanceSnapshot {
  readonly ready: true;
  readonly firstInteractiveMilliseconds: number;
  readonly buildingRenderMode: "instanced" | "legacy" | null;
  readonly buildingBatchCount: number;
  readonly objectCount: number;
  readonly renderCalls: number;
  readonly pickBenchmark: {
    readonly count: number;
    readonly p95Milliseconds: number;
    readonly maximumAabbTests: number;
  };
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
    throw new Error("Viewer performance server did not bind a TCP port.");
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

test("25k production viewer stays within the rendering budget", async ({
  page,
}) => {
  await page.goto(
    `${viewerUrl}/?fixture=large-city-25k&performance=1`,
    { waitUntil: "domcontentloaded", timeout: 45_000 },
  );
  await page.waitForFunction(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__?.ready === true,
    undefined,
    { timeout: 45_000 },
  );

  const snapshot = await page.evaluate(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__!,
  );

  expect(snapshot.firstInteractiveMilliseconds).toBeLessThanOrEqual(8_000);
  expect(snapshot.buildingBatchCount).toBeLessThanOrEqual(5);
  expect(snapshot.objectCount).toBeLessThanOrEqual(384);
  expect(snapshot.renderCalls).toBeLessThanOrEqual(256);
  expect(snapshot.pickBenchmark.count).toBe(50);
  expect(snapshot.pickBenchmark.p95Milliseconds).toBeLessThanOrEqual(32);
  expect(snapshot.pickBenchmark.maximumAabbTests).toBeLessThanOrEqual(512);
});

test("WebGL 1 without ANGLE uses the bounded accessible fallback", async ({
  page,
}) => {
  await disableBrowserInstancing(page);
  await page.goto(`${viewerUrl}/?performance=1`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForFunction(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__?.ready === true,
    undefined,
    { timeout: 45_000 },
  );

  const snapshot = await page.evaluate(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__!,
  );
  expect(snapshot.buildingRenderMode).toBe("legacy");
  expect(snapshot.buildingBatchCount).toBe(0);
  await expect(page.getByRole("alert")).toBeHidden();

  await page.goto(
    `${viewerUrl}/?fixture=large-city-25k&performance=1`,
    { waitUntil: "domcontentloaded", timeout: 45_000 },
  );
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("GPU instancing is unavailable");
  await expect(alert).toContainText("at most 500 buildings");
  await page.waitForFunction(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__?.ready === true,
    undefined,
    { timeout: 45_000 },
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & {
            __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
          }
        ).__CODE_CITY_PERFORMANCE__?.buildingRenderMode,
    ),
  ).toBe("legacy");
});

async function disableBrowserInstancing(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value(
        this: HTMLCanvasElement,
        contextId: string,
        ...arguments_: unknown[]
      ): unknown {
        if (contextId === "webgl2") {
          return null;
        }
        return Reflect.apply(originalGetContext, this, [
          contextId,
          ...arguments_,
        ]);
      },
    });

    const originalGetExtension =
      WebGLRenderingContext.prototype.getExtension;
    Object.defineProperty(
      WebGLRenderingContext.prototype,
      "getExtension",
      {
        configurable: true,
        value(
          this: WebGLRenderingContext,
          name: string,
        ): unknown {
          if (name === "ANGLE_instanced_arrays") {
            return null;
          }
          return Reflect.apply(originalGetExtension, this, [name]);
        },
      },
    );
  });
}

async function serveViewerFile(
  requestUrl: string,
  response: import("node:http").ServerResponse,
): Promise<void> {
  try {
    const pathname = decodeURIComponent(new URL(requestUrl, "http://viewer").pathname);
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
