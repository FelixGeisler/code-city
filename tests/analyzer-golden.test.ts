import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  analyzeLocalFacts,
  analyzeRepositorySnapshotFacts,
  snapshotLocalDirectory,
  type LocalAnalysisFacts,
  type SourceFileFact,
} from "../packages/analyzer/src/index.js";

interface ExpectedSource {
  readonly metricMethod: SourceFileFact["metricMethod"];
  readonly metrics: SourceFileFact["metrics"];
  readonly units: SourceFileFact["units"];
}

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/analyzer-golden/", import.meta.url),
);
const consumerRoot = path.join(fixtureRoot, "consumer");
const providerRoot = path.join(fixtureRoot, "provider");
const malformedRoot = path.join(fixtureRoot, "malformed");
const expectedMetrics = JSON.parse(
  await readFile(path.join(fixtureRoot, "expected-metrics.json"), "utf8"),
) as Readonly<Record<string, ExpectedSource>>;

function sourceProjection(source: SourceFileFact): ExpectedSource {
  return {
    metricMethod: source.metricMethod,
    metrics: source.metrics,
    units: source.units,
  };
}

function dependency(
  facts: LocalAnalysisFacts,
  kind: "project-reference" | "package-reference" | "typescript-import",
  externalTarget?: string,
) {
  return facts.dependencies.find(
    (candidate) =>
      candidate.kind === kind &&
      (externalTarget === undefined ||
        candidate.externalTarget === externalTarget),
  );
}

describe("offline analyzer golden repositories", () => {
  it("emits the pinned C#, TypeScript, TSX, and JavaScript metric contract", async () => {
    const facts = await analyzeLocalFacts([consumerRoot, providerRoot]);
    const byPath = new Map(
      facts.sources.map((source) => [source.path, source]),
    );

    for (const [sourcePath, expected] of Object.entries(expectedMetrics)) {
      const actual = byPath.get(sourcePath);
      expect(actual, sourcePath).toBeDefined();
      expect(sourceProjection(actual!)).toEqual(expected);
    }
  });

  it("parses slnx membership once and collapses duplicate references", async () => {
    const facts = await analyzeLocalFacts([consumerRoot, providerRoot]);
    const solution = facts.solutions.find(
      ({ path: solutionPath }) => solutionPath === "Golden.slnx",
    );
    const consumer = facts.modules.find(
      ({ packageId }) => packageId === "Golden.Consumer",
    );
    const provider = facts.modules.find(
      ({ packageId }) => packageId === "Golden.Provider",
    );

    expect(solution).toMatchObject({
      name: "Golden",
      path: "Golden.slnx",
      moduleIds: [consumer?.id],
    });

    expect(
      facts.dependencies.find(
        ({ kind, sourceId, targetId }) =>
          kind === "project-reference" &&
          sourceId === consumer?.id &&
          targetId === provider?.id,
      ),
    ).toMatchObject({
      resolution: "internal",
      weight: 2,
    });
    expect(
      facts.dependencies.find(
        ({ kind, sourceId, targetId }) =>
          kind === "package-reference" &&
          sourceId === consumer?.id &&
          targetId === provider?.id,
      ),
    ).toMatchObject({
      resolution: "internal",
      version: "1.0.0",
      weight: 1,
    });
    expect(
      dependency(facts, "package-reference", "Example.External"),
    ).toMatchObject({
      resolution: "external",
      version: "1.2.3",
      weight: 2,
    });
  });

  it("resolves mixed-root TS aliases consumer-to-provider deterministically", async () => {
    const forward = await analyzeLocalFacts([consumerRoot, providerRoot]);
    const reversed = await analyzeLocalFacts([providerRoot, consumerRoot]);

    expect(reversed).toEqual(forward);
    const consumerSource = forward.sources.find(
      ({ path: sourcePath, repositoryId }) =>
        sourcePath === "web/main.ts" &&
        repositoryId ===
          forward.repositories.find(({ name }) => name === "consumer")?.id,
    );
    const providerSource = forward.sources.find(
      ({ path: sourcePath, repositoryId }) =>
        sourcePath === "src/shared.ts" &&
        repositoryId ===
          forward.repositories.find(({ name }) => name === "provider")?.id,
    );
    expect(
      forward.dependencies.find(
        ({ kind, sourceId, targetId }) =>
          kind === "typescript-import" &&
          sourceId === consumerSource?.id &&
          targetId === providerSource?.id,
      ),
    ).toMatchObject({
      resolution: "internal",
      weight: 2,
    });

    const serialized = JSON.stringify(forward);
    expect(serialized).not.toContain(path.resolve(fixtureRoot));
    expect(serialized).not.toContain("\\\\");
  });

  it("isolates malformed files and projects with relative, deterministic warnings", async () => {
    const snapshot = await snapshotLocalDirectory(malformedRoot);
    const malformedTypeScript = await readFile(
      path.join(malformedRoot, "Bad", "broken.ts.fixture"),
      "utf8",
    );
    const withMalformedTypeScript = {
      ...snapshot,
      files: [
        ...snapshot.files,
        {
          path: "Bad/broken.ts",
          text: malformedTypeScript,
          byteLength: Buffer.byteLength(malformedTypeScript),
        },
      ],
    };
    const first = await analyzeRepositorySnapshotFacts([
      withMalformedTypeScript,
    ]);
    const second = await analyzeRepositorySnapshotFacts([
      withMalformedTypeScript,
    ]);
    const warningText = first.warnings.join("\n");

    expect(second).toEqual(first);
    expect(first.sources.map(({ path: sourcePath }) => sourcePath)).toContain(
      "Good/Good.cs",
    );
    expect(first.sources.map(({ path: sourcePath }) => sourcePath)).not.toEqual(
      expect.arrayContaining(["Bad/Broken.cs", "Bad/broken.ts"]),
    );
    expect(
      first.modules.map(({ path: modulePath }) => modulePath),
    ).not.toContain("Bad/Broken.csproj");
    for (const relativePath of [
      "Bad/Broken.csproj",
      "Bad/Broken.cs",
      "Bad/broken.ts",
      "angular.json",
    ]) {
      expect(warningText, relativePath).toContain(relativePath);
    }
    expect(warningText).not.toContain(path.resolve(malformedRoot));
    expect(warningText).not.toContain("if (value)");
  });
});
