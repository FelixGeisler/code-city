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
  readonly evolutionRemovals: {
    readonly renderMode: "instanced" | "merged";
    readonly totalCount: number;
    readonly visibleCount: number;
    readonly objectCount: number;
    readonly geometryCount: number;
    readonly materialCount: number;
    readonly drawCalls: number;
  } | null;
  readonly evolutionRemovalAnimated: boolean;
  readonly designSmells: {
    readonly requestedFindings: number;
    readonly candidateMarkers: number;
    readonly visibleMarkers: number;
    readonly omittedMarkers: number;
    readonly batchCount: number;
  };
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

test("25k hierarchy stays virtualized and synchronized with city state", async ({
  page,
}) => {
  // Rendering has its own strict budget above; leave enough headroom for
  // interaction-heavy locator work on slower single-worker CI hosts.
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${viewerUrl}/?fixture=large-city-25k`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.locator("#viewer-tab-explore").click();
  const tree = page.locator("#repository-tree");
  const initialActiveId = await tree.getAttribute(
    "aria-activedescendant",
  );
  expect(initialActiveId).not.toBeNull();
  await expect(page.locator(`#${initialActiveId!}`)).toHaveAttribute(
    "data-node-kind",
    "repository",
  );
  await page.locator("#building-search").fill("file-24999.ts");
  await page
    .locator("#search-results .search-result-button")
    .filter({ hasText: "file-24999.ts" })
    .click();

  await expect(page.locator("#selection-name")).toHaveText(
    "file-24999.ts",
  );
  await page.locator("#viewer-tab-explore").click();
  const selected = tree.locator(
    '[role="treeitem"][aria-selected="true"]',
  );
  await expect(selected).toHaveText(/file-24999\.ts/u);
  await expect(selected).toHaveAttribute("aria-level", "5");
  expect(await tree.locator('[role="treeitem"]').count()).toBeLessThan(
    80,
  );
  const selectedScrollTop = await tree.evaluate(
    (element) => element.scrollTop,
  );
  expect(selectedScrollTop).toBeGreaterThan(0);
  const activeDescendant = await tree.getAttribute(
    "aria-activedescendant",
  );
  expect(activeDescendant).toBe(await selected.getAttribute("id"));

  await tree.hover();
  await page.mouse.wheel(0, -1_024);
  await expect
    .poll(() => tree.evaluate((element) => element.scrollTop))
    .toBeLessThan(selectedScrollTop);
  expect(await tree.locator('[role="treeitem"]').count()).toBeLessThan(
    80,
  );
  const renderedIndexes = await tree
    .locator('[role="treeitem"]')
    .evaluateAll((rows) =>
      rows.map((row) => Number((row as HTMLElement).dataset.treeRowIndex)),
    );
  expect(renderedIndexes).toEqual(
    [...renderedIndexes].sort((left, right) => left - right),
  );

  await tree.press("ArrowUp");
  const alternativeId = await tree.getAttribute(
    "aria-activedescendant",
  );
  expect(alternativeId).not.toBeNull();
  const alternative = page.locator(`#${alternativeId!}`);
  await expect(alternative).toHaveAttribute(
    "data-node-kind",
    "building",
  );
  const alternativeName = (await alternative
    .locator(".repository-tree-label")
    .textContent())!;
  await tree.press("Enter");
  await expect(page.locator("#selection-name")).toHaveText(
    alternativeName,
  );
  await page.locator("#isolate-district").click();
  await expect(
    tree.locator('[role="treeitem"][aria-selected="true"]'),
  ).toHaveAttribute("data-isolated", "true");
  await page.locator("#show-whole-city").click();
  await expect(
    tree.locator('[role="treeitem"][aria-selected="true"]'),
  ).not.toHaveAttribute("data-isolated", "true");

  await tree.press("ArrowLeft");
  const parentId = await tree.getAttribute("aria-activedescendant");
  expect(parentId).not.toBeNull();
  await expect(page.locator(`#${parentId!}`)).toHaveAttribute(
    "data-node-kind",
    "district",
  );
  await tree.press("ArrowLeft");
  await expect(page.locator(`#${parentId!}`)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("design-smell overlay is accessible, paginated, suppressible, and isolated", async ({
  page,
}) => {
  await page.goto(
    `${viewerUrl}/?fixture=large-city-25k&` +
      `isolate-district=district%3A007&performance=1`,
    { waitUntil: "domcontentloaded", timeout: 45_000 },
  );
  await page.getByRole("tab", { name: "Metrics" }).click();
  const panel = page.locator("#design-smell-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false", {
    timeout: 45_000,
  });
  await expect(panel.locator(".design-smell-status")).toContainText(
    "unsuppressed findings",
    { timeout: 45_000 },
  );

  await expect(
    panel.getByLabel("High-complexity method design-smell overlay"),
  ).toBeDisabled();
  await expect(panel.locator(".design-smell-unavailable")).toContainText(
    "Executable-unit complexity facts are not recorded",
  );
  await expect(
    panel.getByLabel("Oversized class design-smell overlay"),
  ).toBeDisabled();
  await expect(panel.locator(".design-smell-unavailable")).toContainText(
    "Per-class size facts are not present",
  );
  await expect(
    panel.getByLabel("Excessive coupling design-smell overlay"),
  ).toBeEnabled();
  await expect(panel.locator(".design-smell-filters")).toContainText(
    "C# 10; TypeScript 10; JavaScript 10",
  );

  const resultRows = panel.locator(".design-smell-finding");
  await expect(resultRows).toHaveCount(100);
  await expect(panel.locator(".design-smell-pagination")).toBeVisible();
  await expect(
    panel.locator(".design-smell-pagination span"),
  ).toContainText("Showing 1–100 of");
  const firstFinding = resultRows.first().locator("button").first();
  await expect(firstFinding).toContainText("⚠ Oversized file");
  expect(await firstFinding.textContent()).not.toMatch(/â|Â|Ã/u);

  const before = await panel.locator(".design-smell-count").textContent();
  await resultRows.first().getByRole("button", {
    name: "Suppress rule for building",
  }).click();
  await expect(panel.locator(".design-smell-count")).not.toHaveText(
    before ?? "",
    { timeout: 45_000 },
  );
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        key.startsWith(
          "code-city-design-smell-suppressions-v1:",
        ),
      ),
    ),
  ).toBe(true);

  await panel.getByRole("button", { name: "Next" }).click();
  await expect(
    panel.locator(".design-smell-pagination span"),
  ).toContainText("Showing 101–200 of");
  await expect(resultRows).toHaveCount(100);

  await page.waitForFunction(
    () => {
      const diagnostics = (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__?.designSmells;
      return (
        diagnostics !== undefined &&
        diagnostics.requestedFindings > 2_000 &&
        diagnostics.visibleMarkers > 0
      );
    },
    undefined,
    { timeout: 45_000 },
  );
  const diagnostics = await page.evaluate(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__!.designSmells,
  );
  expect(diagnostics.batchCount).toBeLessThanOrEqual(4);
  expect(diagnostics.candidateMarkers).toBeGreaterThan(2_000);
  expect(diagnostics.visibleMarkers).toBeGreaterThan(0);
  expect(diagnostics.visibleMarkers).toBeLessThanOrEqual(250);
  expect(diagnostics.omittedMarkers).toBeGreaterThan(0);
});

test("25k removal cues stay bounded and respect isolation in reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(
    `${viewerUrl}/?fixture=large-city-25k&evolution-removals=1&performance=1`,
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

  const wholeCity = await page.evaluate(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__!,
  );
  expect(wholeCity.evolutionRemovals).toEqual({
    renderMode: "instanced",
    totalCount: 25_000,
    visibleCount: 25_000,
    objectCount: 1,
    geometryCount: 1,
    materialCount: 1,
    drawCalls: 1,
  });
  expect(wholeCity.evolutionRemovalAnimated).toBe(false);
  expect(wholeCity.objectCount).toBeLessThanOrEqual(385);
  expect(wholeCity.renderCalls).toBeLessThanOrEqual(257);

  await page.goto(
    `${viewerUrl}/?fixture=large-city-25k&evolution-removals=1&` +
      `isolate-district=district%3A007&performance=1`,
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
  const isolated = await page.evaluate(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__!,
  );

  expect(isolated.evolutionRemovals).toMatchObject({
    renderMode: "instanced",
    totalCount: 25_000,
    visibleCount: 250,
    objectCount: 1,
    geometryCount: 1,
    materialCount: 1,
    drawCalls: 1,
  });
  expect(isolated.evolutionRemovalAnimated).toBe(false);
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

test("metric mappings require an explicit preview and preserve named project configurations", async ({
  page,
}) => {
  await page.goto(viewerUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.getByRole("tab", { name: "Metrics" }).click();

  await expect(
    page.locator("#metric-mapping-unavailable-reasons"),
  ).toContainText("Dependencies");
  await expect(
    page.locator("#metric-mapping-unavailable-reasons"),
  ).toContainText("not yet present on every building");

  await page
    .locator("#metric-mapping-preset")
    .selectOption("maintenance");
  await expect(page.locator("#metric-mapping-apply")).toBeDisabled();
  await page.locator("#metric-mapping-preview").click();
  await expect(page.locator("#metric-mapping-status")).toContainText(
    "Preview active",
  );
  await expect(page.locator("#metric-preview-banner")).toBeVisible();
  await expect(page.locator("#print-export-open")).toBeDisabled();
  await expect(page.locator("#metric-mapping-apply")).toBeEnabled();

  await page.locator("#metric-mapping-cancel").click();
  await expect(page.locator("#metric-preview-banner")).toBeHidden();
  await expect(page.locator("#print-export-open")).toBeEnabled();
  await expect(page.locator("#metric-mapping-status")).toContainText(
    "Committed city restored",
  );

  await page
    .locator("#metric-mapping-preset")
    .selectOption("print");
  await page.locator("#metric-configuration-name").fill("Team print");
  await page.locator("#metric-configuration-save").click();
  await expect(page.locator("#metric-configuration-select")).toHaveValue(
    "Team print",
  );
  await page.locator("#metric-mapping-preview").click();
  await expect(page.locator("#metric-mapping-apply")).toBeEnabled();
  await page.locator("#metric-mapping-apply").click();
  await expect(page.locator("#metric-preview-banner")).toBeHidden();
  await expect(page.locator("#print-export-open")).toBeEnabled();
  await expect(page.locator("#metric-mapping-status")).toContainText(
    "now the committed city",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Metrics" }).click();
  await expect(
    page.locator("#metric-configuration-select option"),
  ).toContainText(["Choose configuration", "Team print"]);
});

test("runs explainable queries and synchronizes bounded multiple selections", async ({
  page,
}) => {
  await page.goto(viewerUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.getByRole("tab", { name: "Queries" }).click();
  await page.locator("#advanced-query-run").click();
  await expect(page.locator("#advanced-query-status")).toContainText(
    "5 matches",
  );

  const resultButtons = page.locator(".advanced-query-result");
  await expect(resultButtons).toHaveCount(5);
  await expect(resultButtons.first()).toContainText("main.ts");
  await resultButtons.first().click();
  await expect(
    page.locator("#advanced-query-panel"),
  ).toBeVisible();
  await expect(resultButtons.first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await resultButtons.nth(1).click({ modifiers: ["Control"] });
  await expect(
    page.locator('.advanced-query-result[aria-selected="true"]'),
  ).toHaveCount(2);
  await resultButtons.nth(2).click({ modifiers: ["Shift"] });
  await expect(
    page.locator('.advanced-query-result[aria-selected="true"]'),
  ).toHaveCount(2);

  await page.getByRole("tab", { name: "Explore" }).click();
  const treeBuildings = page.locator(
    '#repository-tree [role="treeitem"][data-node-kind="building"]',
  );
  await expect(treeBuildings).toHaveCount(3);
  await treeBuildings.first().click();
  await treeBuildings.nth(1).click({ modifiers: ["Control"] });
  await treeBuildings.nth(2).click({ modifiers: ["Shift"] });
  await expect(
    page.locator(
      '#repository-tree [role="treeitem"][aria-selected="true"]',
    ),
  ).toHaveCount(2);
  await expect(page.locator("#selection-status")).toContainText(
    "2 buildings selected",
  );
  await page.getByRole("tab", { name: "Queries" }).click();
  await expect(
    page.locator('.advanced-query-result[aria-selected="true"]'),
  ).toHaveCount(2);

  await expect(page.locator("#advanced-query-isolate")).toBeEnabled();
  await page.locator("#advanced-query-compare").click();
  await expect(
    page.locator("#advanced-query-comparison-summary"),
  ).toContainText("2 buildings");
  await page.locator("#advanced-query-overlay").click();
  await expect(page.locator("#advanced-query-overlay")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.locator("#advanced-query-overlay").click();

  await page.locator("#advanced-query-select-all").click();
  await expect(
    page.locator('.advanced-query-result[aria-selected="true"]'),
  ).toHaveCount(5);
  await page.locator("#advanced-query-save-name").fill("Review set");
  await page.locator("#advanced-query-save").click();
  await page.locator("#advanced-selection-save").click();
  await expect(page.locator("#advanced-query-saved")).toContainText(
    "Review set",
  );
  await expect(page.locator("#advanced-selection-saved")).toContainText(
    "Review set",
  );

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#advanced-query-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("code-city-selection.json");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  await expect
    .poll(async () =>
      fs.readFile(downloadPath!, "utf8"),
    )
    .toContain('"version": "codecity.query-export/1"');

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Queries" }).click();
  await expect(page.locator("#advanced-query-saved")).toContainText(
    "Review set",
  );
  await page
    .locator("#advanced-selection-saved")
    .selectOption("Review set");
  await expect(page.locator("#advanced-query-status")).toContainText(
    "5 saved buildings selected",
  );
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
