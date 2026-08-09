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

test.beforeAll(async () => {
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-viewer-dev-browser-"),
  );
  handle = await startViewerDevelopmentServer({
    dataDirectory: path.join(testRoot, "data"),
    host: "127.0.0.1",
    port: 0,
    apiPort: 0,
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
