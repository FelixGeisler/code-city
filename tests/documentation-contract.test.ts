import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageContract {
  readonly version: string;
}

const docsRoot = "docs/modules";

const chapterNames = {
  ROOT: ["index.adoc"],
  requirements: [
    "index.adoc",
    "01-product-scope.adoc",
    "02-stakeholders-and-use-cases.adoc",
    "03-feature-inventory.adoc",
    "04-functional-requirements.adoc",
    "05-acceptance-criteria.adoc",
  ],
  architecture: [
    "index.adoc",
    "01-introduction-and-goals.adoc",
    "02-architecture-constraints.adoc",
    "03-context-and-scope.adoc",
    "04-solution-strategy.adoc",
    "05-building-block-view.adoc",
    "06-runtime-view.adoc",
    "07-deployment-view.adoc",
    "08-crosscutting-concepts.adoc",
    "09-architecture-decisions.adoc",
    "10-quality-requirements.adoc",
    "11-risks-and-technical-debt.adoc",
    "12-glossary.adoc",
  ],
  comparison: [
    "index.adoc",
    "01-comparison-method.adoc",
    "02-version-1-baseline.adoc",
    "03-version-2-measurements.adoc",
    "04-results-and-conclusions.adoc",
  ],
} as const;

function lines(text: string): readonly string[] {
  return text.replaceAll("\r\n", "\n").split("\n");
}

function words(text: string): readonly string[] {
  return text.trim().split(/\s+/u);
}

describe("public documentation contract", () => {
  it("keeps the README short, visual, and exact about startup and support", async () => {
    const [readme, rawPackage] = await Promise.all([
      fs.readFile("README.md", "utf8"),
      fs.readFile("package.json", "utf8"),
    ]);
    const packageContract = JSON.parse(rawPackage) as PackageContract;

    expect(lines(readme).length).toBeLessThanOrEqual(90);
    expect(words(readme).length).toBeLessThanOrEqual(450);
    expect(readme.match(/<img /gu)).toHaveLength(3);
    expect(readme.match(/\.webp/gu)).toHaveLength(2);
    expect(readme).toContain("## What it can do");
    expect(readme).toContain("## Start Code City");
    expect(readme).toContain("Chromium-based browser with WebGL 2");
    expect(readme).toContain("not part of the automated 1.0 baseline");
    expect(readme).toContain(
      `ghcr.io/felixgeisler/code-city:${packageContract.version}`,
    );
    expect(readme).toContain("--volume code-city-data:/data");
    expect(readme).toContain("Authorization is disabled by default");
  });

  it("separates requirements, arc42 architecture, and comparison material", async () => {
    const moduleNames = (await fs.readdir(docsRoot)).sort();

    expect(moduleNames).toEqual([
      "ROOT",
      "architecture",
      "comparison",
      "requirements",
    ]);
    expect(chapterNames.architecture.slice(1)).toHaveLength(12);
    await expect(
      fs.stat(`${docsRoot}/architecture/pages/adr`),
    ).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("keeps the initial v2 chapter skeleton empty", async () => {
    for (const [moduleName, expectedNames] of Object.entries(chapterNames)) {
      const pagesRoot = `${docsRoot}/${moduleName}/pages`;
      const actualNames = (await fs.readdir(pagesRoot))
        .filter((name) => name.endsWith(".adoc"))
        .sort();

      expect(actualNames).toEqual([...expectedNames].sort());
      for (const name of actualNames) {
        const page = (await fs.readFile(`${pagesRoot}/${name}`, "utf8"))
          .replaceAll("\r\n", "\n");
        expect(page, `${moduleName}/${name}`).toMatch(/^= [^\n]+\n$/u);
      }
    }
  });

  it("keeps Antora component navigation synchronized with the modules", async () => {
    const component = await fs.readFile("docs/antora.yml", "utf8");

    expect(component).toContain("version: '2.0'");
    expect(component).toContain("display_version: '2.x'");
    expect(component).toContain("start_page: ROOT:index.adoc");

    for (const moduleName of Object.keys(chapterNames)) {
      const navPath = `modules/${moduleName}/nav.adoc`;
      expect(component).toContain(`- ${navPath}`);

      const nav = await fs.readFile(`docs/${navPath}`, "utf8");
      const references = [...nav.matchAll(/xref:([^[]+)\[/gu)].map(
        (match) => match[1]!,
      );
      expect(new Set(references).size).toBe(references.length);
      for (const reference of references) {
        await expect(
          fs.stat(`${docsRoot}/${moduleName}/pages/${reference}`),
        ).resolves.toMatchObject({ size: expect.any(Number) });
      }
    }
  });
});
