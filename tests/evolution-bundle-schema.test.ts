import { readFile } from "node:fs/promises";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import { validateEvolutionBundle } from "../packages/core/src/index.js";

const citySchema = JSON.parse(
  await readFile(
    new URL(
      "../packages/core/schema/city-model.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as object;
const evolutionSchema = JSON.parse(
  await readFile(
    new URL(
      "../packages/core/schema/evolution-bundle.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as object;
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
ajv.addSchema(citySchema);
const validateSchema = ajv.compile(evolutionSchema);

function fixture(): Record<string, any> {
  const sha = "1".repeat(40);
  const fingerprint = `sha256:${"2".repeat(64)}`;
  return {
    schemaVersion: "1.0",
    generator: {
      name: "code-city",
      version: DEMO_MODEL.generator.version,
    },
    authorPolicy: "omit-v1",
    selection: {
      mode: "tag-range",
      traversal: "first-parent",
      order: "oldest-first",
      sampleEvery: 1,
      selectedCommitCount: 1,
      sampledCommitCount: 1,
      traversedCommitCount: 1,
      resolvedOldestSha: sha,
      resolvedNewestSha: sha,
      sampledCommitShas: [sha],
    },
    provenance: {
      repositoryId: DEMO_MODEL.repositories[0]!.id,
      repositoryFingerprint: fingerprint,
      analyzer: {
        name: "code-city",
        version: DEMO_MODEL.generator.version,
        fingerprint: `sha256:${"3".repeat(64)}`,
      },
      historyBackend: {
        name: "git",
        version: "2.47.1.windows.2",
        renamePolicyRevision: "diff-tree-renames-50-myers-v1",
      },
      metricConfigurationFingerprint: `sha256:${"4".repeat(64)}`,
      selectionFingerprint: `sha256:${"5".repeat(64)}`,
    },
    baseline: {
      commit: {
        index: 0,
        sha,
        committedAt: "2026-01-01T00:00:00.000Z",
        parentShas: [],
        analyzerVersion: DEMO_MODEL.generator.version,
        analysisFingerprint: `sha256:${"6".repeat(64)}`,
      },
      model: DEMO_MODEL,
    },
    deltas: [],
  };
}

function errors(): string {
  return JSON.stringify(validateSchema.errors, null, 2);
}

describe("EvolutionBundle JSON Schema", () => {
  it("accepts the versioned bundle around an unchanged CityModel 1.0", () => {
    const value = fixture();

    expect(validateSchema(value), errors()).toBe(true);
    expect(validateEvolutionBundle(value)).toBe(value);
  });

  it("accepts the bounded complete-mainline selection variant", () => {
    const value = fixture();
    value.selection = {
      ...value.selection,
      mode: "root-to-tip",
      samplingStrategy: "evenly-spaced-v1",
      maxFrames: 20,
    };
    delete value.selection.sampleEvery;

    expect(validateSchema(value), errors()).toBe(true);
    expect(validateEvolutionBundle(value).selection).toMatchObject({
      mode: "root-to-tip",
      maxFrames: 20,
    });
  });

  it("rejects author data, mutable tag labels, and excessive histories", () => {
    const author = fixture();
    author.baseline.commit.author = { name: "Private" };
    expect(validateSchema(author)).toBe(false);

    const tag = fixture();
    tag.selection.fromTag = "v1";
    expect(validateSchema(tag)).toBe(false);

    const backend = fixture();
    backend.provenance.historyBackend.name = "host-library";
    expect(validateSchema(backend)).toBe(false);

    const excessive = fixture();
    excessive.deltas = Array.from({ length: 100 }, () => ({}));
    expect(validateSchema(excessive)).toBe(false);
  });

  it("leaves replay and cross-reference invariants to the runtime validator", () => {
    const value = fixture();
    value.baseline.commit.sha = "7".repeat(40);

    expect(validateSchema(value), errors()).toBe(true);
    expect(() => validateEvolutionBundle(value)).toThrow(
      /must match selection/u,
    );
  });
});
