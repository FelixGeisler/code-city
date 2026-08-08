import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

interface PerformanceSnapshot {
  readonly ready: true;
  readonly firstInteractiveMilliseconds: number;
  readonly buildingRenderMode: "instanced" | "ordinary" | null;
  readonly buildingBatchCount: number;
  readonly visibleBuildingCount: number;
  readonly buildingVisibilityMaskActive: boolean;
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
  readonly dependencyRoutes: {
    readonly routeCount: number;
  };
  readonly designSmells: {
    readonly active: boolean;
    readonly requestedFindings: number;
    readonly validFindings: number;
    readonly buildingCount: number;
    readonly affectedBuildings: number;
    readonly coloredBuildings: number;
    readonly severityBuildings: {
      readonly moderate: number;
      readonly high: number;
      readonly critical: number;
    };
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

async function openAnalyze(
  page: Page,
  view: "findings" | "routes" | "queries",
): Promise<void> {
  const analyzeTab = page.locator("#viewer-tab-analyze");
  const analyzePanel = page.locator("#viewer-view-analyze");
  if (
    (await analyzeTab.getAttribute("aria-selected")) !== "true" ||
    !(await analyzePanel.isVisible())
  ) {
    await analyzeTab.click();
  }
  const nestedTab = page.locator(`#analyze-tab-${view}`);
  if ((await nestedTab.getAttribute("aria-selected")) !== "true") {
    await nestedTab.click();
  }
}

async function openAdvancedProjectSettings(page: Page): Promise<void> {
  await page.locator("#project-actions-menu > summary").click();
  await page.locator("#advanced-project-settings-open").click();
  await expect(page.locator("#advanced-project-settings-dialog")).toBeVisible();
}

async function openExportMenu(page: Page): Promise<void> {
  await page.locator("#export-actions-menu > summary").click();
}

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

test("desktop workspace prioritizes exploration, findings, and contextual details", async ({
  page,
}) => {
  await page.goto(viewerUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await expect(page.locator("#scene canvas")).toBeVisible();
  await expect(page.locator("#image-export-open")).toBeEnabled();

  const workspace = page.locator("#viewer-workspace");
  await expect(workspace.locator("[data-workspace-view]")).toHaveCount(2);
  await expect(page.locator("#viewer-view-explore")).toBeVisible();
  await expect(page.locator("#viewer-view-details")).toBeHidden();
  await expect(page.locator("#visualization-mode option")).toHaveText([
    "Semantic groups",
    "Complexity risk",
  ]);

  await page.locator("#building-search").fill("main.ts");
  await page
    .locator('#search-results [data-building-id="building:main"]')
    .click();
  await expect(workspace).toHaveAttribute("data-details-open", "true");
  await expect(page.locator("#viewer-view-details")).toBeVisible();
  await expect(page.locator("#building-hotspots-section")).toBeVisible();
  await expect(page.locator("#building-metric-technical-details")).not.toHaveAttribute(
    "open",
    "",
  );

  await page.locator("#viewer-details-back").click();
  await expect(page.locator("#viewer-view-explore")).toBeVisible();
  await openAnalyze(page, "findings");
  await expect(page.locator("#design-smell-panel")).toBeVisible();
  await expect(page.locator("#advanced-query-panel")).toBeHidden();

  await openAdvancedProjectSettings(page);
  await expect(page.locator("#metric-mapping-panel")).toBeVisible();
  await expect(page.locator("#safe-extension-panel")).toBeHidden();
  await page.locator("#advanced-project-settings-close").click();
  await expect(page.locator("#project-actions-menu > summary")).toBeFocused();

  await openAdvancedProjectSettings(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#advanced-project-settings-dialog")).toBeHidden();
  await expect(page.locator("#project-actions-menu > summary")).toBeFocused();

  await openExportMenu(page);
  await expect(page.locator("#image-export-open")).toBeVisible();
  await expect(page.locator("#print-export-open")).toBeVisible();
});

test("narrow workspace preserves Analyze state across contextual inspection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(viewerUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });

  const workspace = page.locator("#viewer-workspace");
  await expect(workspace).toHaveAttribute("data-compact", "true");
  await expect(workspace).toHaveAttribute("data-sheet-state", "peek");
  await openAnalyze(page, "queries");
  await expect(workspace).toHaveAttribute("data-sheet-state", "expanded");
  await page.locator("#advanced-query-run").click();
  await page.locator(".advanced-query-result").first().click();
  await page.locator("#advanced-query-inspect").click();
  await expect(page.locator("#viewer-view-details")).toBeVisible();
  await expect(page.locator("#viewer-tab-analyze")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#analyze-tab-queries")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.locator("#viewer-details-back").click();
  await expect(page.locator("#analyze-view-queries")).toBeVisible();
  await expect(page.locator("#analyze-tab-queries")).toBeFocused();
  await expect(workspace).toHaveAttribute(
    "data-active-analyze-view",
    "queries",
  );
});

test("disclosure actions and contextual dismissal restore visible keyboard focus", async ({
  page,
}) => {
  await page.goto(viewerUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await expect(page.locator("#scene canvas")).toBeVisible();
  await expect(page.locator("#image-export-open")).toBeEnabled();

  const projectSummary = page.locator("#project-actions-menu > summary");
  await projectSummary.focus();
  await projectSummary.press("Enter");
  const demo = page.locator("#demo-button");
  await demo.focus();
  await demo.press("Enter");
  await expect(projectSummary).toBeFocused();

  await projectSummary.press("Enter");
  const openModel = page.locator("#model-file-open");
  await openModel.focus();
  const fileChooser = page.waitForEvent("filechooser");
  await openModel.press("Enter");
  await (await fileChooser).setFiles([]);
  await expect(projectSummary).toBeFocused();

  await openAdvancedProjectSettings(page);
  await page.keyboard.press("Escape");
  await expect(projectSummary).toBeFocused();

  const exportSummary = page.locator("#export-actions-menu > summary");
  await exportSummary.focus();
  await exportSummary.press("Enter");
  const imageExport = page.locator("#image-export-open");
  await imageExport.focus();
  await imageExport.press("Enter");
  await expect(page.locator("#image-export-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(exportSummary).toBeFocused();

  await exportSummary.press("Enter");
  const printExport = page.locator("#print-export-open");
  await printExport.focus();
  await printExport.press("Enter");
  await expect(page.locator("#print-export-dialog")).toBeVisible();
  await expect(
    page.locator('#visualization-mode option[value="print"]'),
  ).toHaveText("Print assignment preview");
  const printClose = page.locator("#print-export-close");
  await printClose.focus();
  await printClose.press("Enter");
  await expect(exportSummary).toBeFocused();

  await page.locator("#building-search").fill("main.ts");
  const mainResult = page.locator(
    '#search-results [data-building-id="building:main"]',
  );
  await mainResult.click();
  const clearSelection = page.locator("#clear-selection");
  await clearSelection.focus();
  await clearSelection.press("Enter");
  await expect(page.locator("#viewer-tab-explore")).toBeFocused();

  await page.locator("#building-search").fill("main.ts");
  await mainResult.click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#viewer-tab-explore")).toBeFocused();
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
  await expect(
    page.locator(
      `#${initialActiveId!} .repository-tree-kind svg[data-icon="git-repository"]`,
    ),
  ).toHaveCount(1);
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
  await expect(
    selected.locator(
      '.repository-tree-kind svg[data-icon="source-file"]',
    ),
  ).toHaveCount(1);
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
  await page.locator("#viewer-details-back").click();

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

test("design-smell building colors are accessible, scoped, paginated, and suppressible", async ({
  page,
}) => {
  // Rendering has a separate strict budget; this scenario also waits for two
  // worker evaluations and exercises cross-panel query synchronization.
  test.setTimeout(180_000);
  await page.goto(`${viewerUrl}/?fixture=large-city-25k&performance=1`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  const panel = page.locator("#design-smell-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false", {
    timeout: 45_000,
  });
  await expect(panel.locator(".design-smell-status")).toContainText(
    "unsuppressed findings",
    { timeout: 45_000 },
  );
  await page.waitForFunction(
    () => {
      const diagnostics = (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__?.designSmells;
      return (
        diagnostics !== undefined &&
        !diagnostics.active &&
        diagnostics.requestedFindings > 2_000
      );
    },
    undefined,
    { timeout: 45_000 },
  );
  const exploreSnapshot = await page.evaluate(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__!,
  );
  expect(exploreSnapshot.designSmells.coloredBuildings).toBe(0);

  await openAnalyze(page, "findings");
  await page.waitForFunction(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__?.designSmells.active === true,
    undefined,
    { timeout: 45_000 },
  );
  await expect(page.locator("#scene canvas")).toHaveAttribute(
    "aria-label",
    /Visualization mode: Design smells · highest visible severity/u,
  );
  await expect(page.locator("#legend")).toHaveAttribute(
    "aria-label",
    /Design smells · highest visible severity legend/u,
  );
  await expect(panel.getByLabel("Building color legend")).toContainText(
    /Critical.*High.*Moderate.*No visible finding/su,
  );

  await expect(
    panel.getByLabel("Show High-complexity method findings"),
  ).toBeDisabled();
  await expect(panel.locator(".design-smell-unavailable")).toContainText(
    "Executable-unit complexity facts are not recorded",
  );
  await expect(
    panel.getByLabel("Show Oversized class findings"),
  ).toBeDisabled();
  await expect(panel.locator(".design-smell-unavailable")).toContainText(
    "Per-class size facts are not present",
  );
  await expect(
    panel.getByLabel("Show Excessive coupling findings"),
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

  await firstFinding.click();
  const selectionStatus = page.locator("#selection-status");
  await expect(selectionStatus).toContainText(
    /visible design-smell findings?; highest severity/u,
  );
  await openAnalyze(page, "queries");
  await expect(selectionStatus).not.toContainText("visible design-smell");
  await openAnalyze(page, "findings");
  await expect(selectionStatus).toContainText(
    /visible design-smell findings?; highest severity/u,
  );

  await openAnalyze(page, "queries");
  await page.waitForFunction(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__?.designSmells.active === false,
    undefined,
    { timeout: 45_000 },
  );
  const querySnapshot = await page.evaluate(
    () =>
      (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
        }
      ).__CODE_CITY_PERFORMANCE__!,
  );
  expect(querySnapshot.designSmells.coloredBuildings).toBe(0);
  expect(querySnapshot.objectCount).toBe(exploreSnapshot.objectCount);
  expect(querySnapshot.buildingBatchCount).toBe(
    exploreSnapshot.buildingBatchCount,
  );
  await page
    .locator("#advanced-query-preset")
    .selectOption("custom");
  await page
    .locator("#advanced-query-smell")
    .fill("oversized-file");
  await page.locator("#advanced-query-run").click();
  const queryStatus = page.locator("#advanced-query-status");
  await expect(queryStatus).toContainText("matches", {
    timeout: 45_000,
  });
  const queryStatusBeforeSuppression =
    await queryStatus.textContent();
  await openAnalyze(page, "findings");

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

  await openAnalyze(page, "queries");
  await expect(queryStatus).not.toHaveText(
    queryStatusBeforeSuppression ?? "",
    { timeout: 45_000 },
  );
  await expect(queryStatus).toContainText("matches");
  await openAnalyze(page, "findings");

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
        diagnostics.active &&
        diagnostics.affectedBuildings > 0
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
  expect(diagnostics.validFindings).toBeGreaterThan(2_000);
  expect(diagnostics.coloredBuildings).toBe(25_000);
  expect(diagnostics.affectedBuildings).toBeGreaterThan(0);
  expect(diagnostics.affectedBuildings).toBeLessThanOrEqual(25_000);
  expect(
    diagnostics.severityBuildings.moderate +
      diagnostics.severityBuildings.high +
      diagnostics.severityBuildings.critical,
  ).toBe(diagnostics.affectedBuildings);
});

test("25k startup does not materialize fine detail for every file", async ({
  page,
}) => {
  await page.goto(`${viewerUrl}/?fixture=large-city-25k&performance=1`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForFunction(
    () => (window as Window & { __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot }).__CODE_CITY_PERFORMANCE__?.ready === true,
    undefined,
    { timeout: 45_000 },
  );
  const snapshot = await page.evaluate(
    () => (window as Window & { __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot }).__CODE_CITY_PERFORMANCE__!,
  );
  // Fine detail is a selected-file inspector projection, never a city-startup
  // mesh/DOM layer. The normal 25k scene budgets must therefore remain intact.
  expect(await page.locator("#building-source-structure li").count()).toBe(0);
  expect(snapshot.objectCount).toBeLessThanOrEqual(384);
  expect(snapshot.renderCalls).toBeLessThanOrEqual(256);
});

test("25k removal cues stay bounded in reduced motion", async ({
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
});

test("WebGL 2 without core instancing uses the bounded ordinary fallback", async ({
  page,
}) => {
  await disableWebGL2Instancing(page);
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
  expect(snapshot.buildingRenderMode).toBe("ordinary");
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
});

test("a WebGL 1-only environment gets the accessible WebGL 2 requirement", async ({
  page,
}) => {
  await disableWebGL2(page);
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
  expect(snapshot.buildingRenderMode).toBeNull();
  expect(snapshot.buildingBatchCount).toBe(0);
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("3D viewer unavailable");
  await expect(alert).toContainText("WebGL 2");
  await expect(alert).toContainText("Project data and non-visual exports remain available");
});

test("metric mappings require an explicit preview and preserve named project configurations", async ({
  page,
}) => {
  await page.goto(viewerUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await openAdvancedProjectSettings(page);

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
  await openAdvancedProjectSettings(page);
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
  await openAnalyze(page, "queries");
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
  await page.locator("#viewer-details-back").click();
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
  await openAnalyze(page, "queries");
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
  await openAnalyze(page, "queries");
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

test("isolates and focuses exact cross-district selections and uses visible search order", async ({
  page,
}) => {
  await page.goto(`${viewerUrl}/?performance=1`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await openAnalyze(page, "queries");
  await page.locator("#advanced-query-run").click();
  await expect(page.locator("#advanced-query-status")).toContainText(
    "5 matches",
  );

  const main = page.locator(
    '.advanced-query-result[data-building-id="building:main"]',
  );
  const validation = page.locator(
    '.advanced-query-result[data-building-id="building:validation"]',
  );
  const model = page.locator(
    '.advanced-query-result[data-building-id="building:model"]',
  );
  await main.click();
  await validation.click({ modifiers: ["Control"] });
  await model.click({ modifiers: ["Control"] });
  await expect(
    page.locator('.advanced-query-result[aria-selected="true"]'),
  ).toHaveCount(3);
  await expect(page.locator("#selection-status")).toContainText(
    "3 buildings selected",
  );

  await page.locator("#advanced-query-inspect").click();
  await page.locator("#dependency-section summary").click();
  await expect(page.locator("#dependency-outgoing-count")).toHaveText(
    "2",
  );
  await page.locator("#dependency-outgoing-toggle").click();
  await openAnalyze(page, "queries");
  await page.locator("#advanced-query-compare").click();
  await expect(
    page.locator("#advanced-query-comparison-summary"),
  ).toContainText("Table shows all 3 selected buildings");
  await expect(
    page.locator("#advanced-query-comparison-body tr"),
  ).toHaveCount(3);
  await expect(
    page.locator(
      '#advanced-query-comparison-table th[scope="col"]',
    ),
  ).toHaveCount(7);
  await expect(
    page.locator(
      '#advanced-query-comparison-body th[scope="row"]',
    ),
  ).toHaveCount(3);

  await page.locator("#advanced-query-focus").click();
  await page.locator("#advanced-query-isolate").click();
  await page.getByRole("tab", { name: "Explore" }).click();
  await expect(
    page.locator(
      '#repository-tree [role="treeitem"][aria-selected="true"]',
    ),
  ).toHaveCount(3);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
            }
          ).__CODE_CITY_PERFORMANCE__,
      ),
    )
    .toMatchObject({
      buildingVisibilityMaskActive: true,
      visibleBuildingCount: 3,
      dependencyRoutes: { routeCount: 2 },
    });
  await openAnalyze(page, "queries");
  await expect(page.locator("#advanced-query-isolate")).toBeEnabled();
  await page.locator("#advanced-query-isolate").click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
            }
          ).__CODE_CITY_PERFORMANCE__,
      ),
    )
    .toMatchObject({
      buildingVisibilityMaskActive: false,
      visibleBuildingCount: 5,
    });
  await page.locator("#advanced-query-isolate").click();

  await page.locator("#advanced-query-clear").click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
            }
          ).__CODE_CITY_PERFORMANCE__,
      ),
    )
    .toMatchObject({
      buildingVisibilityMaskActive: false,
      visibleBuildingCount: 5,
    });

  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill("src");
  const searchBuildings = page.locator(
    '#search-results .search-result-button[data-building-id]',
  );
  await expect(searchBuildings).toHaveCount(4);
  await searchBuildings.nth(0).click({ modifiers: ["Control"] });
  await searchBuildings.nth(1).click({ modifiers: ["Control"] });
  await expect(
    page.locator(
      '#search-results .search-result-button[aria-pressed="true"]',
    ),
  ).toHaveCount(2);
  await searchBuildings.nth(3).click({ modifiers: ["Shift"] });
  await expect(
    page.locator(
      '#search-results .search-result-button[aria-pressed="true"]',
    ),
  ).toHaveCount(3);
  await expect(searchBuildings.nth(0)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("#selection-status")).toContainText(
    "3 buildings selected",
  );
  await searchBuildings.nth(1).click({ modifiers: ["Control"] });
  await expect(
    page.locator(
      '#search-results .search-result-button[aria-pressed="true"]',
    ),
  ).toHaveCount(2);
  await expect(searchBuildings.nth(1)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    page.locator(
      '#repository-tree [role="treeitem"][aria-selected="true"]',
    ),
  ).toHaveCount(2);
  await expect(page.locator("#selection-status")).toContainText(
    "2 buildings selected",
  );
});

test("canvas plain, additive, and range activation use the central city order", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(viewerUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await openAnalyze(page, "queries");
  await page.locator("#advanced-query-preset").selectOption("custom");
  await page.locator("#advanced-query-text").fill("main.ts");
  await page.locator("#advanced-query-run").click();
  await expect(page.locator("#advanced-query-status")).toContainText(
    "1 match",
  );

  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill("main.ts");
  await page
    .locator(
      '#search-results [data-building-id="building:main"]',
    )
    .click();
  await page.waitForTimeout(750);
  await page.keyboard.press("Escape");
  await expect(page.locator("#selection-status")).toHaveText(
    "Selection cleared.",
  );

  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill("model.ts");
  await page
    .locator(
      '#search-results [data-building-id="building:model"]',
    )
    .click({ modifiers: ["Control"] });
  await page.locator("#building-search").fill("main.ts");
  await page
    .locator(
      '#search-results [data-building-id="building:main"]',
    )
    .click({ modifiers: ["Control"] });
  await expect(page.locator("#selection-status")).toContainText(
    "2 buildings selected",
  );

  const mainPoint = await sceneCanvasCenter(page);
  await page.mouse.click(mainPoint.x, mainPoint.y);
  await expect(page.locator("#selection-status")).toContainText(
    "1 building selected",
  );
  await expect(page.locator("#selection-name")).toHaveText("main.ts");

  await clickSceneCanvas(page, mainPoint, "Control");
  await expect(page.locator("#selection-status")).toHaveText(
    "Selection cleared.",
  );
  await clickSceneCanvas(page, mainPoint, "Control");
  await expect(page.locator("#selection-status")).toContainText(
    "1 building selected",
  );

  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill("model.ts");
  await page
    .locator(
      '#search-results [data-building-id="building:model"]',
    )
    .click();
  await page.waitForTimeout(750);
  const modelPoint = await sceneCanvasCenter(page);
  await openAnalyze(page, "queries");
  await page
    .locator(
      '.advanced-query-result[data-building-id="building:main"]',
    )
    .click();
  await clickSceneCanvas(page, modelPoint, "Shift");
  await expect(page.locator("#selection-status")).toContainText(
    "5 buildings selected",
  );
  await expect(
    page.locator('.advanced-query-result[aria-selected="true"]'),
  ).toHaveCount(1);
});

test("whole-city PNG temporarily removes and then restores a building mask", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(`${viewerUrl}/?performance=1`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await openAnalyze(page, "queries");
  await page.locator("#advanced-query-run").click();
  await expect(page.locator("#advanced-query-status")).toContainText(
    "5 matches",
  );
  await page
    .locator(
      '.advanced-query-result[data-building-id="building:main"]',
    )
    .click();

  const wholeCityHash = await prepareWholeCityPngHash(page);
  await openAnalyze(page, "queries");
  await page.locator("#advanced-query-isolate").click();
  await expect
    .poll(() => selectionPerformanceSnapshot(page))
    .toMatchObject({
      buildingRenderMode: "instanced",
      buildingVisibilityMaskActive: true,
      visibleBuildingCount: 1,
    });

  const isolatedWholeCityHash = await prepareWholeCityPngHash(page);
  expect(isolatedWholeCityHash).toBe(wholeCityHash);
  await expect
    .poll(() => selectionPerformanceSnapshot(page))
    .toMatchObject({
      buildingRenderMode: "instanced",
      buildingVisibilityMaskActive: true,
      visibleBuildingCount: 1,
    });
});

test("25k exact selection mask stays instanced and constrains canvas BVH picking", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(
    `${viewerUrl}/?fixture=large-city-25k&performance=1`,
    { waitUntil: "domcontentloaded", timeout: 45_000 },
  );
  await page.getByRole("tab", { name: "Explore" }).click();
  const selectFromSearch = async (
    name: string,
    buildingId: string,
  ): Promise<void> => {
    await page.locator("#building-search").fill(name);
    await page
      .locator(
        `#search-results [data-building-id="${buildingId}"]`,
      )
      .click({ modifiers: ["Control"] });
  };
  await selectFromSearch("file-00000.ts", "building:00000");
  await selectFromSearch("file-12499.ts", "building:12499");
  await selectFromSearch("file-24999.ts", "building:24999");
  await expect(page.locator("#selection-status")).toContainText(
    "3 buildings selected",
  );

  await openAnalyze(page, "queries");
  await page.locator("#advanced-query-isolate").click();
  await expect
    .poll(() => selectionPerformanceSnapshot(page))
    .toMatchObject({
      buildingRenderMode: "instanced",
      buildingVisibilityMaskActive: true,
      visibleBuildingCount: 3,
    });

  await page.locator("#camera-focus-selection").click();
  await page.waitForTimeout(750);
  const selectedPoint = await sceneCanvasCenter(page);
  await page.mouse.click(selectedPoint.x, selectedPoint.y);
  await expect(page.locator("#selection-name")).toHaveText(
    "file-24999.ts",
  );
  await expect(page.locator("#selection-status")).toContainText(
    "1 building selected",
  );
  await expect
    .poll(() => selectionPerformanceSnapshot(page))
    .toMatchObject({
      buildingRenderMode: "instanced",
      buildingVisibilityMaskActive: true,
      visibleBuildingCount: 1,
    });
});

interface SceneCanvasPoint {
  readonly x: number;
  readonly y: number;
}

async function sceneCanvasCenter(
  page: import("@playwright/test").Page,
): Promise<SceneCanvasPoint> {
  const bounds = await page.locator("#scene canvas").boundingBox();
  if (bounds === null) {
    throw new Error("The scene canvas is unavailable.");
  }
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

async function clickSceneCanvas(
  page: import("@playwright/test").Page,
  point: SceneCanvasPoint,
  modifier: "Control" | "Shift",
): Promise<void> {
  await page.keyboard.down(modifier);
  try {
    await page.mouse.click(point.x, point.y);
  } finally {
    await page.keyboard.up(modifier);
  }
}

async function prepareWholeCityPngHash(
  page: import("@playwright/test").Page,
): Promise<string> {
  await openExportMenu(page);
  await page.locator("#image-export-open").click();
  await expect(page.locator("#image-export-dialog")).toBeVisible();
  await page.locator("#image-export-width").fill("640");
  await page.locator("#image-export-height").fill("400");
  await page.locator("#image-export-view").selectOption("custom");
  const advancedLens = page.locator(".image-export-advanced-lens");
  if ((await advancedLens.getAttribute("open")) === null) {
    await advancedLens.locator("summary").click();
  }
  await page
    .locator("#image-export-projection")
    .selectOption("orthographic");
  await page.locator("#image-export-fit").selectOption("whole-city");
  await page
    .locator("#image-export-background")
    .selectOption("transparent");
  await page.locator("#image-export-labels").uncheck();
  await page.locator("#image-export-legend").uncheck();
  await page.locator("#image-export-submit").click();
  const download = page.locator("#image-export-download");
  await expect(download).toBeVisible({ timeout: 30_000 });
  const [preparedDownload] = await Promise.all([
    page.waitForEvent("download"),
    download.click(),
  ]);
  const stream = await preparedDownload.createReadStream();
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  const digest = hash.digest("hex");
  await page.locator("#image-export-close").click();
  await expect(page.locator("#image-export-dialog")).toBeHidden();
  return digest;
}

async function selectionPerformanceSnapshot(
  page: import("@playwright/test").Page,
): Promise<
  | Pick<
      PerformanceSnapshot,
      | "buildingRenderMode"
      | "buildingVisibilityMaskActive"
      | "visibleBuildingCount"
    >
  | undefined
> {
  return page.evaluate(() => {
    const snapshot = (
      window as Window & {
        __CODE_CITY_PERFORMANCE__?: PerformanceSnapshot;
      }
    ).__CODE_CITY_PERFORMANCE__;
    if (snapshot === undefined) return undefined;
    return {
      buildingRenderMode: snapshot.buildingRenderMode,
      buildingVisibilityMaskActive:
        snapshot.buildingVisibilityMaskActive,
      visibleBuildingCount: snapshot.visibleBuildingCount,
    };
  });
}

async function disableWebGL2Instancing(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(() => {
    for (const operation of [
      "drawArraysInstanced",
      "drawElementsInstanced",
      "vertexAttribDivisor",
    ]) {
      Object.defineProperty(WebGL2RenderingContext.prototype, operation, {
        configurable: true,
        value: undefined,
      });
    }
  });
}

async function disableWebGL2(
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
