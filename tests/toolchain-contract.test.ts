import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageContract {
  readonly packageManager?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

describe("development toolchain contract", () => {
  it("pins Node, npm, and one root verification command", async () => {
    const packageContract = JSON.parse(
      await fs.readFile("package.json", "utf8"),
    ) as PackageContract;

    expect(packageContract.packageManager).toBe("npm@11.6.2");
    expect(packageContract.engines).toMatchObject({
      node: ">=24 <25",
      npm: ">=11 <12",
    });
    expect(packageContract.scripts?.["verify"]).toBe(
      "npm run typecheck && npm test && npm run build && npm run docs:build",
    );
    expect(packageContract.dependencies).toMatchObject({
      typescript: "7.0.2",
      "jsonc-parser": "3.3.1",
      three: "0.185.1",
    });
    expect(packageContract.dependencies).not.toHaveProperty(
      "typescript-analyzer",
    );
    expect(packageContract.devDependencies).toMatchObject({
      "@types/three": "0.185.4",
    });
  });

  it("keeps the documented viewer development command functional", async () => {
    const [rawPackage, readme] = await Promise.all([
      fs.readFile("package.json", "utf8"),
      fs.readFile("README.md", "utf8"),
    ]);
    const packageContract = JSON.parse(rawPackage) as PackageContract;

    expect(packageContract.scripts?.["previewer:dev"]).toBe(
      "npm run build --silent",
    );
    expect(packageContract.scripts?.["viewer:dev"]).toBe(
      "node build/app/apps/viewer/src/development-server.js",
    );
    expect(readme).toContain("starts both the real");
    expect(readme).toContain("same-origin /api calls");
  });

  it("keeps optional viewer exports out of the bounded startup graph", async () => {
    const [rawPackage, viteConfiguration, budget] = await Promise.all([
      fs.readFile("package.json", "utf8"),
      fs.readFile("apps/viewer/vite.config.ts", "utf8"),
      fs.readFile("tools/viewer-bundle-budget.mjs", "utf8"),
    ]);
    const packageContract = JSON.parse(rawPackage) as PackageContract;

    expect(packageContract.scripts?.["viewer:build"]).toContain(
      "node tools/viewer-bundle-budget.mjs",
    );
    expect(viteConfiguration).toContain("manifest: true");
    expect(viteConfiguration).not.toContain("chunkSizeWarningLimit");
    expect(budget).toContain('"src/advanced-query-panel.ts"');
    expect(budget).toContain('"src/image-export-dialog.ts"');
    expect(budget).toContain('"src/metric-mapping-panel.ts"');
    expect(budget).toContain('"src/print-export-dialog.ts"');
    expect(budget).toContain('"src/published-cities-api.ts"');
    expect(budget).toContain('"src/published-cities.ts"');
    expect(budget).toContain('"src/safe-extension-panel.ts"');
    expect(budget).toContain("includeEagerChunk(\"index.html\")");
    expect(budget).toContain("ENTRY_GZIP_MAX_BYTES");
  });

  it("uses the same bounded verification workflow on Linux and Windows", async () => {
    const workflow = await fs.readFile(
      ".github/workflows/ci.yml",
      "utf8",
    );

    expect(workflow).toContain(
      "os: [ubuntu-latest, windows-latest]",
    );
    expect(workflow).toContain("actions/setup-dotnet@v6");
    expect(workflow).toContain("dotnet-version: 10.0.302");
    expect(workflow).toContain("timeout-minutes: 20");
    expect(workflow).toMatch(
      /viewer-performance:[\s\S]*?timeout-minutes: 25/u,
    );
    expect(workflow).toMatch(
      /viewer-real-import:[\s\S]*?timeout-minutes: 15/u,
    );
    expect(workflow).toContain("- run: npm run test:viewer-real-import");
    expect(workflow).toContain("- run: npm ci");
    expect(workflow).toContain("- run: npm run verify");
    expect(workflow).not.toContain("- run: npm install");
  });

  it("keeps automated dependency updates isolated and bounded", async () => {
    const [dependabot, readme] = await Promise.all([
      fs.readFile(".github/dependabot.yml", "utf8"),
      fs.readFile("README.md", "utf8"),
    ]);

    expect(dependabot).toContain("version: 2");
    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot.match(/interval: weekly/gu)).toHaveLength(2);
    expect(dependabot).toContain("open-pull-requests-limit: 5");
    expect(dependabot).toContain("open-pull-requests-limit: 3");
    expect(dependabot).not.toMatch(/^\s*groups:/mu);
    expect(readme).toMatch(/one dependency\s+per PR/u);
    expect(readme).toContain("updates are never grouped");
  });

  it("pins the SDK that supplies the trusted Roslyn assemblies", async () => {
    const sdk = JSON.parse(
      await fs.readFile("global.json", "utf8"),
    ) as { readonly sdk?: Readonly<Record<string, unknown>> };
    expect(sdk.sdk).toEqual({
      version: "10.0.302",
      rollForward: "disable",
      allowPrerelease: false,
    });
  });

  it("keeps documentation installation reproducible and documented", async () => {
    const [workflow, readme] = await Promise.all([
      fs.readFile(".github/workflows/docs.yml", "utf8"),
      fs.readFile("README.md", "utf8"),
    ]);

    expect(workflow).toContain("- run: npm ci --ignore-scripts");
    expect(workflow).toContain("actions/configure-pages@v6");
    expect(workflow).toContain("actions/upload-pages-artifact@v5");
    expect(workflow).toContain("actions/deploy-pages@v5");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(readme).toContain("Node.js 24.x");
    expect(readme).toContain("npm 11.6.2");
    expect(readme).toContain("npm run verify");
  });
});
