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

  it("uses the same bounded verification workflow on Linux and Windows", async () => {
    const workflow = await fs.readFile(
      ".github/workflows/ci.yml",
      "utf8",
    );

    expect(workflow).toContain(
      "os: [ubuntu-latest, windows-latest]",
    );
    expect(workflow).toContain("actions/setup-dotnet@v5");
    expect(workflow).toContain("dotnet-version: 10.0.302");
    expect(workflow).toContain("timeout-minutes: 20");
    expect(workflow).toContain("- run: npm ci");
    expect(workflow).toContain("- run: npm run verify");
    expect(workflow).not.toContain("- run: npm install");
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
    expect(workflow).toContain("timeout-minutes: 15");
    expect(readme).toContain("Node.js 24.x");
    expect(readme).toContain("npm 11.6.2");
    expect(readme).toContain("npm run verify");
  });
});
