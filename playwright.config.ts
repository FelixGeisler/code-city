import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/performance",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    browserName: "chromium",
    deviceScaleFactor: 1,
    headless: true,
    viewport: {
      width: 1_440,
      height: 900,
    },
  },
});
