import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  startViewerDevelopmentServer,
  type ViewerDevelopmentServerHandle,
} from "../../apps/viewer/src/development-server.js";

let handle: ViewerDevelopmentServerHandle;
let testRoot: string;

async function waitForViewer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(new URL("?performance=1", handle.url).href, {
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

test.beforeAll(async () => {
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-viewer-dev-browser-"),
  );
  handle = await startViewerDevelopmentServer({
    dataDirectory: path.join(testRoot, "data"),
    host: "127.0.0.1",
    port: 0,
    apiPort: 0,
    trustWindowsGitWorkspace: true,
  });
});

test.afterAll(async () => {
  await handle.close();
  await fs.rm(testRoot, { recursive: true, force: true });
});

test("integrated development viewer executes its complete startup graph", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${String(response.status())} ${response.url()}`);
    }
  });

  await waitForViewer(page);
  await page.locator("#project-import-open").click();
  await expect(page.locator("#project-import-dialog")).toBeVisible();
  await expect(page.locator("#project-import-steps")).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});

test("@real-import imports, opens, and prepares a real 100-frame GitHub city through the UI", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${String(response.status())} ${response.url()}`);
    }
  });

  await waitForViewer(page);
  await page.getByRole("button", { name: "Import project" }).click();
  await page
    .locator('input[name="project-import-source"][value="github-public"]')
    .check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .locator("#project-import-repository-url")
    .fill("https://github.com/FelixGeisler/code-city");
  await page.locator("#project-import-history-enabled").check();
  await page
    .locator("#project-import-history-mode")
    .selectOption("commit-count");
  await page.locator("#project-import-history-commit-count").fill("100");
  await page.locator("#project-import-history-sample-every").fill("1");
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .locator("#project-import-identity-title")
    .fill("Code City 100-frame UI contract");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Start import" }).click();

  await expect(page.locator("#project-import-dialog")).toBeHidden({
    timeout: 580_000,
  });
  await expect(page.locator("#model-name")).toHaveText(
    "Code City 100-frame UI contract",
  );
  await expect(page.locator("#evolution-timeline")).toBeVisible();
  await expect(page.locator("#evolution-commit")).toContainText("100/100", {
    timeout: 120_000,
  });

  const jobId = await page.evaluate(() =>
    localStorage.getItem("code-city.last-import-job.v1"),
  );
  expect(jobId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  const modelResponse = await fetch(
    new URL(`api/v1/artifacts/${jobId}/city-model.json`, handle.url),
  );
  expect(modelResponse.status).toBe(200);
  const model = await modelResponse.json() as {
    readonly repositories?: readonly unknown[];
    readonly buildings?: readonly unknown[];
  };
  expect(model.repositories?.length).toBeGreaterThan(0);
  expect(model.buildings?.length).toBeGreaterThan(0);

  const evolutionResponse = await fetch(
    new URL(`api/v1/artifacts/${jobId}/evolution.json`, handle.url),
  );
  expect(evolutionResponse.status).toBe(200);
  const evolution = await evolutionResponse.json() as {
    readonly deltas?: readonly unknown[];
    readonly selection?: {
      readonly sampledCommitCount?: number;
      readonly sampleEvery?: number;
    };
  };
  expect(evolution.selection).toMatchObject({
    sampledCommitCount: 100,
    sampleEvery: 1,
  });
  expect(evolution.deltas).toHaveLength(99);

  await page.locator("#export-actions-menu > summary").click();
  await page.getByRole("button", { name: "Export print file" }).click();
  const printDialog = page.getByRole("dialog", { name: "Export print file" });
  await printDialog.locator("#print-profile-kind").selectOption("prusa-xl");
  await printDialog.locator("#print-legend-download-enabled").uncheck();
  await printDialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(printDialog.locator("#print-export-preflight")).toBeVisible({
    timeout: 120_000,
  });
  await expect(printDialog.locator("#print-export-channels-title")).toHaveText(
    "Tool allocation",
  );
  await expect(
    printDialog.locator('[data-channel-id="tool-1"]'),
  ).toContainText(/Base.*Identity/iu);
  for (const [channelId, label] of [
    ["tool-2", "Very high complexity"],
    ["tool-3", "High complexity"],
    ["tool-4", "Moderate complexity"],
    ["tool-5", "Low complexity"],
  ] as const) {
    await expect(
      printDialog.locator(`[data-channel-id="${channelId}"]`),
    ).toContainText(label);
  }
  await expect(printDialog.locator("#print-export-download")).toBeVisible();
  await expect(printDialog.locator("#print-export-download")).toHaveAttribute(
    "href",
    /^blob:/u,
  );

  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});
