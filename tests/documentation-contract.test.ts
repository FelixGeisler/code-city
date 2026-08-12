import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageContract {
  readonly version: string;
  readonly scripts: Readonly<Record<string, string>>;
}

const pagesRoot = "docs/modules/ROOT/pages";

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

  it("keeps release information organized by reader goals", async () => {
    const [releaseNotes, operations] = await Promise.all([
      fs.readFile("RELEASE_NOTES.md", "utf8"),
      fs.readFile(`${pagesRoot}/14-release-and-operations.adoc`, "utf8"),
    ]);

    for (const heading of [
      "## What you can do",
      "## Deployment",
      "## Security notes",
      "## Compatibility and limitations",
    ]) {
      expect(releaseNotes).toContain(heading);
    }
    expect(operations).toContain("|Goal |Go to");
    expect(operations).toContain("[#pre-release-checklist]");
    expect(operations).toContain("[#cold-backup]");
    expect(operations).toContain("[#release-smoke-test]");
  });

  it("keeps architecture pages rough and operations separate", async () => {
    const names = (await fs.readdir(pagesRoot))
      .filter((name) => name.endsWith(".adoc") && name !== "14-release-and-operations.adoc");
    const documents = await Promise.all(
      names.map(async (name) => ({
        name,
        text: await fs.readFile(`${pagesRoot}/${name}`, "utf8"),
      })),
    );
    const architectureLineCount = documents.reduce(
      (total, document) => total + lines(document.text).length,
      0,
    );

    expect(names).toHaveLength(9);
    expect(architectureLineCount).toBeLessThanOrEqual(600);
    for (const document of documents) {
      expect(lines(document.text).length, document.name).toBeLessThanOrEqual(100);
    }
    const overview = documents.find(({ name }) => name === "index.adoc")?.text;
    expect(overview).toContain("== Purpose");
    expect(overview).toContain("== Constraints");
    expect(overview).toContain("== Quality goals");
    expect(overview).toContain("protocol fields, numeric limits, and UI details");
    expect(await fs.readFile(`${pagesRoot}/14-release-and-operations.adoc`, "utf8"))
      .toContain("== Cold backup with Docker Compose");
  });

  it("keeps navigation, building blocks, and critical evidence synchronized", async () => {
    const [nav, buildingBlocks, quality, rawPackage] = await Promise.all([
      fs.readFile("docs/modules/ROOT/nav.adoc", "utf8"),
      fs.readFile(`${pagesRoot}/05-building-block-view.adoc`, "utf8"),
      fs.readFile(`${pagesRoot}/10-quality-requirements.adoc`, "utf8"),
      fs.readFile("package.json", "utf8"),
    ]);
    const packageContract = JSON.parse(rawPackage) as PackageContract;
    const references = [...nav.matchAll(/xref:([^[]+)\[/gu)].map(
      (match) => match[1]!,
    );

    expect(new Set(references).size).toBe(references.length);
    for (const reference of references) {
      await expect(fs.stat(`${pagesRoot}/${reference}`)).resolves.toMatchObject({
        size: expect.any(Number),
      });
    }
    for (const block of [
      "packages/core",
      "packages/analyzer",
      "packages/exporter",
      "apps/server",
      "apps/viewer",
      "apps/cli",
    ]) {
      await expect(fs.stat(block)).resolves.toMatchObject({
        size: expect.any(Number),
      });
      expect(buildingBlocks).toContain(`\`${block}\``);
    }
    for (const script of [
      "verify",
      "test:viewer-performance",
      "test:viewer-real-import",
      "release:check",
    ]) {
      expect(packageContract.scripts).toHaveProperty(script);
      expect(quality).toContain(`npm run ${script}`);
    }
    expect(quality).toContain("tools/container-runtime-smoke.mjs");
  });
});
