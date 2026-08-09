import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  startViewerDevelopmentServer,
  type ViewerDevelopmentServerHandle,
} from "../../apps/viewer/src/development-server.js";
import { ViewerImportApiClient } from "../../apps/viewer/src/import-api.js";

let handle: ViewerDevelopmentServerHandle;
let testRoot: string;

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

  await page.locator("#project-import-open").click();
  await expect(page.locator("#project-import-dialog")).toBeVisible();
  await expect(page.locator("#project-import-steps")).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});

test("imports real public GitHub history through the development server", async () => {
  test.setTimeout(600_000);
  const client = new ViewerImportApiClient(handle.url);
  const queued = await client.createRemoteImport({
    source: {
      kind: "github",
      repositoryUrl: "https://github.com/FelixGeisler/code-city",
    },
    history: {
      mode: "commit-count",
      commitCount: 100,
      sampleEvery: 1,
    },
    identity: { title: "Code City 100-frame public history smoke test" },
  });

  let current = queued;
  await expect.poll(
    async () => {
      current = await client.getJob(queued.id);
      if (current.state === "failed") {
        throw new Error(
          `Public history import failed: ${current.error?.code ?? "unknown"}: ${current.error?.message ?? "No diagnostic"}`,
        );
      }
      return current.state;
    },
    { timeout: 580_000, intervals: [250, 500, 1_000] },
  ).toBe("completed");
  expect(current.result?.evolution?.artifactUrl).toContain(
    `/api/v1/artifacts/${queued.id}/evolution.json`,
  );

  const modelResponse = await fetch(
    new URL(`api/v1/artifacts/${queued.id}/city-model.json`, handle.url),
  );
  expect(modelResponse.status).toBe(200);
  const model = await modelResponse.json() as {
    readonly repositories?: readonly unknown[];
    readonly buildings?: readonly unknown[];
  };
  expect(model.repositories?.length).toBeGreaterThan(0);
  expect(model.buildings?.length).toBeGreaterThan(0);

  const evolutionResponse = await fetch(
    new URL(`api/v1/artifacts/${queued.id}/evolution.json`, handle.url),
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
});
