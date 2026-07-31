import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  createServer,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  serializeEvolutionBundle,
  validateCityModel,
  type CityDependency,
  type EvolutionBundle,
  type EvolutionChanges,
} from "../../packages/core/src/index.js";

let server: Server | undefined;
let origin: string;
let workerBytes: Uint8Array;
let artifactBase64: string;
let artifactSha256: string;
let artifactSize: number;

function sha(index: number): string {
  return index.toString(16).padStart(40, "0");
}

function fingerprint(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function emptyChanges(): EvolutionChanges {
  const empty = () => ({ added: [], removed: [], changed: [] });
  return {
    model: {},
    repositories: empty(),
    solutions: empty(),
    modules: empty(),
    semanticGroups: empty(),
    districts: empty(),
    buildings: empty(),
    dependencies: empty(),
  };
}

async function cancellationBundle(): Promise<EvolutionBundle> {
  const demo = JSON.parse(
    await fs.readFile(
      path.resolve("examples/demo-city.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const repositoryId = (
    demo["repositories"] as readonly { readonly id: string }[]
  )[0]!.id;
  const sourceId = (
    demo["modules"] as readonly { readonly id: string }[]
  )[0]!.id;
  const dependencies: CityDependency[] = Array.from(
    { length: 3_000 },
    (_, index) => {
      const suffix = index.toString().padStart(5, "0");
      return {
        id: `dependency:browser-cancel:${suffix}`,
        repositoryId,
        sourceId,
        externalTarget: `browser-cancel-package-${suffix}`,
        resolution: "external",
        kind: "package-reference",
        version: "1",
        weight: 1,
      };
    },
  );
  const model = validateCityModel({
    ...demo,
    dependencies,
  });
  const nextIdentity = {
    ...model.identity!,
    title: "Cancellation checkpoint frame",
  };
  const changes = emptyChanges();
  const bundle: EvolutionBundle = {
    schemaVersion: "1.0",
    generator: model.generator,
    authorPolicy: "omit-v1",
    selection: {
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      requestedCommitCount: 2,
      sampleEvery: 1,
      selectedCommitCount: 2,
      sampledCommitCount: 2,
      traversedCommitCount: 2,
      resolvedOldestSha: sha(1),
      resolvedNewestSha: sha(2),
      sampledCommitShas: [sha(1), sha(2)],
    },
    provenance: {
      repositoryId,
      repositoryFingerprint: fingerprint(1),
      analyzer: {
        name: "code-city",
        version: model.generator.version,
        fingerprint: fingerprint(2),
      },
      historyBackend: {
        name: "git",
        version: "2.47.1",
        renamePolicyRevision: "diff-tree-renames-50-myers-v1",
      },
      metricConfigurationFingerprint: fingerprint(3),
      selectionFingerprint: fingerprint(4),
    },
    baseline: {
      commit: {
        index: 0,
        sha: sha(1),
        committedAt: "2026-01-01T00:00:00.000Z",
        parentShas: [],
        analyzerVersion: model.generator.version,
        analysisFingerprint: fingerprint(5),
      },
      model,
    },
    deltas: [
      {
        commit: {
          index: 1,
          sha: sha(2),
          committedAt: "2026-01-02T00:00:00.000Z",
          parentShas: [sha(1)],
          analyzerVersion: model.generator.version,
          analysisFingerprint: fingerprint(6),
        },
        changes: {
          ...changes,
          model: { identity: nextIdentity },
        },
      },
    ],
  };
  return bundle;
}

test.beforeAll(async () => {
  const assets = path.resolve("build/viewer/assets");
  const workerAsset = (
    await fs.readdir(assets)
  ).find((name) =>
    /^evolution-timeline-worker-.+\.js$/u.test(name),
  );
  if (workerAsset === undefined) {
    throw new Error("The built evolution worker asset is unavailable.");
  }
  workerBytes = await fs.readFile(path.join(assets, workerAsset));

  const serialized = serializeEvolutionBundle(
    await cancellationBundle(),
  );
  artifactBase64 = Buffer.from(serialized).toString("base64");
  artifactSha256 = createHash("sha256")
    .update(serialized)
    .digest("hex");
  artifactSize = serialized.byteLength;

  const createdServer = createServer((request, response) => {
    if (request.url === "/worker.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": workerBytes.byteLength,
        "cache-control": "no-store",
      });
      response.end(workerBytes);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><title>Evolution worker test</title>");
  });
  server = createdServer;
  await new Promise<void>((resolve, reject) => {
    createdServer.once("error", reject);
    createdServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = createdServer.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  const activeServer = server;
  if (activeServer === undefined) return;
  await new Promise<void>((resolve, reject) => {
    activeServer.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
});

test("services a queued cancel before obsolete worker replay can finish", async ({
  page,
}) => {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(
    async ({ bytesBase64, expectedSha256, expectedSize }) => {
      const worker = new Worker("/worker.js", {
        type: "module",
        name: "evolution-cancellation-regression",
      });
      const responses: {
        readonly type?: string;
        readonly requestId?: number;
        readonly frame?: { readonly index?: number };
      }[] = [];
      worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data === "object" && event.data !== null) {
          responses.push(event.data as (typeof responses)[number]);
        }
      });
      const waitFor = async (
        requestId: number,
      ): Promise<(typeof responses)[number]> => {
        const startedAt = performance.now();
        while (performance.now() - startedAt < 20_000) {
          const response = responses.find(
            (candidate) => candidate.requestId === requestId,
          );
          if (response !== undefined) return response;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Worker request ${requestId} timed out.`);
      };
      try {
        const binary = atob(bytesBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        worker.postMessage(
          {
            type: "load",
            requestId: 1,
            bytes: bytes.buffer,
            expectedSize,
            expectedSha256,
          },
          [bytes.buffer],
        );
        const loaded = await waitFor(1);
        responses.length = 0;

        worker.postMessage({
          type: "seek",
          requestId: 2,
          fromIndex: 0,
          toIndex: 1,
        });
        worker.postMessage({ type: "cancel", requestId: 3 });
        await new Promise((resolve) => setTimeout(resolve, 400));

        worker.postMessage({
          type: "seek",
          requestId: 4,
          fromIndex: 0,
          toIndex: 1,
        });
        const recovered = await waitFor(4);
        const obsoleteCompleted = responses.some(
          ({ requestId }) => requestId === 2,
        );
        return {
          loadedType: loaded.type,
          obsoleteCompleted,
          recoveredType: recovered.type,
          recoveredFrame: recovered.frame?.index,
        };
      } finally {
        worker.terminate();
      }
    },
    {
      bytesBase64: artifactBase64,
      expectedSha256: artifactSha256,
      expectedSize: artifactSize,
    },
  );

  expect(result).toEqual({
    loadedType: "loaded",
    obsoleteCompleted: false,
    recoveredType: "frame",
    recoveredFrame: 1,
  });
});
