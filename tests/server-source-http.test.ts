import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeRepositorySnapshots } from "../packages/analyzer/src/index.js";
import type { RepositorySnapshot } from "../packages/analyzer/src/snapshot.js";
import type { CityModel, SourceRepositoryProvenance } from "../packages/core/src/model.js";
import { evaluateDesignSmells } from "../packages/core/src/design-smells.js";
import {
  attachSourceProvenance,
  createSourceArtifact,
  uploadedSnapshotProvenance,
} from "../apps/server/src/source-artifact.js";
import {
  exactSourceText,
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../apps/server/src/server.js";
import type {
  AiGuidanceAdapterOptions,
  AiGuidanceConfiguration,
} from "../apps/server/src/ai-guidance.js";

const roots: string[] = [];
const servers: CodeCityServerHandle[] = [];

async function fixture(
  options: {
    readonly editorUrlTemplate?: string;
    readonly artifactResponseTimeouts?: {
      readonly idleMs: number;
      readonly totalMs: number;
    };
    readonly aiGuidance?: AiGuidanceConfiguration;
    readonly aiGuidanceAdapterOptions?: Omit<AiGuidanceAdapterOptions, "audit">;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-source-http-"));
  roots.push(root);
  const viewerRoot = path.join(root, "viewer");
  const dataDirectory = path.join(root, "data");
  await fs.mkdir(viewerRoot, { recursive: true });
  await fs.writeFile(
    path.join(viewerRoot, "index.html"),
    "<!doctype html><title>Code City</title>",
  );
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    viewerRoot,
    dataDirectory,
    sourceRetention: "retain",
    ...(options.editorUrlTemplate === undefined
      ? {}
      : { editorUrlTemplate: options.editorUrlTemplate }),
    ...(options.artifactResponseTimeouts === undefined
      ? {}
      : {
          artifactResponseTimeouts:
            options.artifactResponseTimeouts,
        }),
    ...(options.aiGuidance === undefined ? {} : { aiGuidance: options.aiGuidance }),
    ...(options.aiGuidanceAdapterOptions === undefined ? {} : { aiGuidanceAdapterOptions: options.aiGuidanceAdapterOptions }),
  });
  servers.push(server);
  return server;
}

function snapshot(name: string): RepositorySnapshot {
  const text = `export function ${name}() {\n  return "${name}";\n}\n`;
  return {
    name,
    files: [
      {
        path: `src/${name}.ts`,
        text,
        byteLength: Buffer.byteLength(text),
      },
    ],
    diagnostics: [],
  };
}

function contextualSnapshot(): RepositorySnapshot {
  const branches = Array.from({ length: 16 }, (_value, index) => `    if (value === ${index}) return ${index};`).join("\n");
  const text = `import { helper } from "./helper";\nexport class ContextDemo {\n  run(value: number) {\n${branches}\n    return helper(value);\n  }\n}\n`;
  const helper = "export function helper(value: number) { return value; }\n";
  return {
    name: "contextual",
    files: [
      { path: "src/context.ts", text, byteLength: Buffer.byteLength(text) },
      { path: "src/helper.ts", text: helper, byteLength: Buffer.byteLength(helper) },
    ],
    diagnostics: [],
  };
}

function withoutAvailableSourceStructure(
  mode: "absent" | "unavailable",
): (model: CityModel) => CityModel {
  return (model) => {
    const building = model.buildings[0]!;
    const { sourceStructure: omittedSourceStructure, ...legacyBuilding } = building;
    void omittedSourceStructure;
    return {
      ...model,
      buildings: [
        mode === "absent"
          ? legacyBuilding
          : {
              ...legacyBuilding,
              sourceStructure: {
                version: "codecity.source-structure/1",
                availability: "unavailable",
                types: [],
                callables: [],
                relations: [],
                unavailable: ["Declaration structure was not retained."],
              },
            },
        ...model.buildings.slice(1),
      ],
    };
  };
}

function withoutDeclaredCallableComplexity(
  retainExactEvidenceLink: boolean,
): (model: CityModel) => CityModel {
  return (model) => ({
    ...model,
    buildings: model.buildings.map((building) => {
      if (building.path !== "src/context.ts" || building.sourceStructure === undefined) {
        return building;
      }
      const callable = building.sourceStructure.callables.find(
        ({ name }) => name === "run",
      )!;
      const units = building.units?.map((unit) => {
        if (
          retainExactEvidenceLink ||
          unit.decisionEvidence?.callableId !== callable.id
        ) return unit;
        const { decisionEvidence: omittedEvidence, ...aggregateOnly } = unit;
        void omittedEvidence;
        return aggregateOnly;
      });
      return {
        ...building,
        sourceStructure: {
          ...building.sourceStructure,
          callables: building.sourceStructure.callables.map((candidate) => {
            if (candidate.id !== callable.id) return candidate;
            const { complexity: omittedComplexity, ...withoutComplexity } = candidate;
            void omittedComplexity;
            return withoutComplexity;
          }),
        },
        ...(units === undefined ? {} : { units }),
      };
    }),
  });
}

function guidanceContext(buildingId: string) {
  return { version: "codecity.ai-context/1", kind: "file", buildingId } as const;
}

function guidancePreviewOptions(buildingId: string, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Code-City-Request": "1",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(guidanceContext(buildingId)),
  };
}

function successfulProviderResponse(init: RequestInit): Response {
  const payload = JSON.parse(String(init.body)) as { providerId: string; contextDigest: string; findingDigest?: string };
  return new Response(JSON.stringify({ providerId: payload.providerId, contextDigest: payload.contextDigest, ...(payload.findingDigest === undefined ? {} : { findingDigest: payload.findingDigest }), suggestions: [] }), { headers: { "content-type": "application/json" } });
}

async function publish(
  server: CodeCityServerHandle,
  name: string,
  retained = snapshot(name),
  provenance?: (
    repositoryId: string,
  ) => SourceRepositoryProvenance,
  transformModel?: (model: CityModel) => CityModel,
) {
  const analyzed = await analyzeRepositorySnapshots([retained]);
  const repository = analyzed.repositories[0]!;
  const modelWithProvenance = attachSourceProvenance(analyzed, [
    provenance?.(repository.id) ??
      uploadedSnapshotProvenance(repository.id, retained),
  ]);
  const model = transformModel?.(modelWithProvenance) ?? modelWithProvenance;
  const queued = await server.jobs.enqueue(
    "project-import",
    async ({ id }) => {
      const source = await server.sources.publish(
        id,
        createSourceArtifact(model, [
          { repositoryId: repository.id, snapshot: retained },
        ]),
      );
      await server.artifacts.publishCityModel(id, model);
      return {
        kind: "city-model",
        artifactToken: id,
        artifactUrl: `/api/v1/artifacts/${id}/city-model.json`,
        source: {
          availability: "retained",
          artifactUrl: `/api/v1/artifacts/${id}/source`,
          size: source.size,
          sha256: source.sha256,
          indexSha256: source.indexSha256,
        },
      };
    },
    {
      rollback: async ({ id }) => {
        await Promise.all([
          server.sources.cleanup(id),
          server.artifacts.cleanupCityModelArtifact(id),
        ]);
      },
    },
  );
  const job = await server.jobs.waitForTerminal(queued.id);
  if (job?.state !== "completed") {
    throw new Error(
      `Source fixture job ${job?.state ?? "was not found"}.`,
    );
  }
  return { job, model, building: model.buildings[0]! };
}

function request(
  url: URL,
  options: {
    readonly method?: string;
    readonly headers?: http.OutgoingHttpHeaders;
  } = {},
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function stallResponse(
  url: URL,
): Promise<{
  readonly closed: Promise<void>;
  destroy(): void;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      url,
      { method: "GET", agent: false },
      (incoming) => {
        let announceClosed!: () => void;
        const closed = new Promise<void>((closeResolve) => {
          announceClosed = closeResolve;
        });
        incoming.once("aborted", announceClosed);
        incoming.once("close", announceClosed);
        incoming.pause();
        resolve({
          closed,
          destroy: () => {
            incoming.destroy();
            outgoing.destroy();
          },
        });
      },
    );
    outgoing.setTimeout(5_000, () =>
      outgoing.destroy(new Error("Stalled source request timed out.")),
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function waitForSourceGate(
  url: URL,
): Promise<{ readonly status: number; readonly body: string }> {
  const deadline = Date.now() + 5_000;
  let response;
  do {
    response = await request(url, { method: "HEAD" });
    if (response.status !== 503) return response;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  return response;
}

async function expectStalledSourceResponse(
  url: URL,
  expectedStatus: number,
): Promise<void> {
  const originalEnd = http.ServerResponse.prototype.end;
  let intercepted = false;
  const endSpy = vi
    .spyOn(http.ServerResponse.prototype, "end")
    .mockImplementation(function (
      this: http.ServerResponse,
      ...arguments_: unknown[]
    ) {
      if (
        !intercepted &&
        this.statusCode === expectedStatus &&
        this.getHeader("Content-Type") ===
          "application/json; charset=utf-8"
      ) {
        intercepted = true;
        this.flushHeaders();
        return this;
      }
      return Reflect.apply(
        originalEnd,
        this,
        arguments_,
      ) as http.ServerResponse;
    });
  let stalled:
    | Awaited<ReturnType<typeof stallResponse>>
    | undefined;
  try {
    stalled = await stallResponse(url);
    await Promise.race([
      stalled.closed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Source idle timeout did not fire.")),
          5_000,
        ),
      ),
    ]);
  } finally {
    endSpy.mockRestore();
    stalled?.destroy();
  }
  expect(intercepted).toBe(true);
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("source navigation HTTP API", () => {
  it("slices inclusive declaration columns on one and multiple lines", () => {
    expect(exactSourceText("abc\n", {
      startLine: 1,
      startColumn: 2,
      endLine: 1,
      endColumn: 2,
    })).toBe("b");
    expect(exactSourceText("abc\r\ndef\r\nghi\r\n", {
      startLine: 1,
      startColumn: 2,
      endLine: 3,
      endColumn: 2,
    })).toBe("bc\r\ndef\r\ngh");
  });

  it("serves only the selected job's exact building and removes source with the job", async () => {
    const server = await fixture();
    const first = await publish(server, "alpha");
    const second = await publish(server, "beta");
    const cityModelRead = vi.spyOn(
      server.artifacts,
      "readCityModel",
    );

    const selected = await request(
      new URL(
        `/api/v1/artifacts/${first.job.id}/sources/${first.building.id}`,
        server.url,
      ),
    );
    expect(selected.status).toBe(200);
    expect(JSON.parse(selected.body)).toMatchObject({
      source: {
        buildingId: first.building.id,
        path: first.building.path,
        text: expect.stringContaining("alpha"),
      },
    });
    expect(cityModelRead).not.toHaveBeenCalled();

    const crossed = await request(
      new URL(
        `/api/v1/artifacts/${second.job.id}/sources/${first.building.id}`,
        server.url,
      ),
    );
    expect(crossed.status).toBe(404);

    const removed = await request(
      new URL(`/api/v1/imports/${first.job.id}/result`, server.url),
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
    );
    expect(removed.status).toBe(200);
    expect(await server.sources.read(first.job.id)).toBeUndefined();
  });

  it("times out a stalled source response and releases the artifact gate", async () => {
    const server = await fixture({
      artifactResponseTimeouts: {
        idleMs: 100,
        totalMs: 3_000,
      },
    });
    const imported = await publish(server, "stalled");
    const sourceUrl = new URL(
      `/api/v1/artifacts/${imported.job.id}/sources/${imported.building.id}`,
      server.url,
    );
    await expectStalledSourceResponse(sourceUrl, 200);
    const released = await waitForSourceGate(sourceUrl);
    expect(released.status).toBe(200);
    expect(released.body).toBe("");

    for (const failure of ["missing", "failed"] as const) {
      const read = vi.spyOn(server.sources, "readFile");
      if (failure === "missing") {
        read.mockResolvedValueOnce(undefined);
      } else {
        read.mockRejectedValueOnce(
          new Error("Injected source read failure."),
        );
      }
      try {
        await expectStalledSourceResponse(
          sourceUrl,
          failure === "missing" ? 404 : 500,
        );
      } finally {
        read.mockRestore();
      }
      expect((await waitForSourceGate(sourceUrl)).status).toBe(200);
    }

    const removed = await request(
      new URL(`/api/v1/imports/${imported.job.id}/result`, server.url),
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
    );
    expect(removed.status).toBe(200);
  });

  it.each([
    "{path}://editor.example/open",
    "https{line}://editor.example/open/{path}",
    "https://{path}/open",
    "https://safe.example@{path}/open",
    "https://safe.example:{line}/open/{path}",
    "vscode://{path}/open",
  ])(
    "rejects an editor template whose placeholder can change its scheme or authority: %s",
    async (editorUrlTemplate) => {
      await expect(
        fixture({ editorUrlTemplate }),
      ).rejects.toThrow(/editor URL template/iu);
    },
  );

  it("rejects an oversized editor template at startup", async () => {
    await expect(
      fixture({
        editorUrlTemplate: `https://editor.example/${"a".repeat(4_096)}/{path}`,
      }),
    ).rejects.toThrow(/editor URL template/iu);
  });

  it("serves safe editor links but omits an expansion beyond the response limit", async () => {
    const editorUrlTemplate =
      "https://editor.example/open/{path}?line={line}#L{line}";
    const server = await fixture({ editorUrlTemplate });
    const normal = await publish(server, "editor");
    const normalResponse = await request(
      new URL(
        `/api/v1/artifacts/${normal.job.id}/sources/${normal.building.id}`,
        server.url,
      ),
    );
    expect(normalResponse.status).toBe(200);
    expect(JSON.parse(normalResponse.body).source.editorUrl).toBe(
      "https://editor.example/open/src/editor.ts?line=1#L1",
    );

    const longPath = `src/${"ü".repeat(700)}.ts`;
    const longText = "export const longPath = true;\n";
    const imported = await publish(
      server,
      "longEditor",
      {
        name: "longEditor",
        files: [
          {
            path: longPath,
            text: longText,
            byteLength: Buffer.byteLength(longText),
          },
        ],
        diagnostics: [],
      },
      (repositoryId) => ({
        repositoryId,
        provider: "github",
        revision: {
          kind: "commit",
          value: "a".repeat(40),
        },
        repositoryUrl: "https://github.com/example/long-source",
      }),
    );
    const longResponse = await request(
      new URL(
        `/api/v1/artifacts/${imported.job.id}/sources/${imported.building.id}`,
        server.url,
      ),
    );
    expect(longResponse.status).toBe(200);
    const longSource = JSON.parse(longResponse.body).source;
    expect(longSource).not.toHaveProperty("editorUrl");
    expect(longSource.externalUrl).toBe(
      `https://github.com/example/long-source/blob/${"a".repeat(40)}/${longPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}#L1`,
    );
    expect(longSource.externalUrl.length).toBeGreaterThan(4_096);
  });

  it("accepts a fixed vscode authority and preserves an Azure DevOps source link", async () => {
    const server = await fixture({
      editorUrlTemplate: "vscode://file/{path}:{line}",
    });
    const revision = "b".repeat(40);
    const repositoryUrl =
      "https://dev.azure.com/example/Project/_git/Repository";
    const imported = await publish(
      server,
      "azureEditor",
      snapshot("azureEditor"),
      (repositoryId) => ({
        repositoryId,
        provider: "azure-devops",
        revision: { kind: "commit", value: revision },
        repositoryUrl,
      }),
    );
    const response = await request(
      new URL(
        `/api/v1/artifacts/${imported.job.id}/sources/${imported.building.id}`,
        server.url,
      ),
    );
    expect(response.status).toBe(200);
    const source = JSON.parse(response.body).source;
    expect(source.editorUrl).toBe(
      "vscode://file/src/azureEditor.ts:1",
    );
    const expectedExternal = new URL(repositoryUrl);
    expectedExternal.searchParams.set("path", "/src/azureEditor.ts");
    expectedExternal.searchParams.set("version", `GC${revision}`);
    expectedExternal.searchParams.set("line", "1");
    expectedExternal.searchParams.set("_a", "contents");
    expect(source.externalUrl).toBe(expectedExternal.toString());
  });

  it("issues a server-bound one-time AI grant and derives findings without browser metrics", async () => {
    let providerBody = "";
    let providerCalls = 0;
    const server = await fixture({
      aiGuidance: { version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] },
      aiGuidanceAdapterOptions: {
        fetch: async (_url, init) => {
          providerCalls += 1;
          providerBody = String(init.body);
          return successfulProviderResponse(init);
        },
      },
    });
    const imported = await publish(server, "guided");
    const providers = await fetch(new URL("/api/v1/ai/providers", server.url));
    expect(await providers.json()).toEqual({ enabled: true, providers: [{ id: "local", label: "Local" }] });
    const previewUrl = new URL(`/api/v1/ai/preview/${imported.job.id}/${imported.building.id}/local`, server.url);
    expect((await fetch(previewUrl)).status).toBe(405);
    expect((await fetch(previewUrl, { method: "HEAD" })).status).toBe(405);
    expect((await fetch(previewUrl, { method: "POST" })).status).toBe(403);
    const previewResponse = await fetch(previewUrl, guidancePreviewOptions(imported.building.id));
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json() as { preview: { grant: string; transmission: { source: { text: string }; findings: unknown } } }).preview;
    expect(preview.transmission.findings).toEqual({ sloc: imported.building.metrics.sloc, maximumComplexity: imported.building.metrics.maximumComplexity, decisionLoad: imported.building.metrics.decisionLoad });
    const cookie = previewResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(previewResponse.headers.get("set-cookie")).toMatch(/HttpOnly.*SameSite=Strict/);
    const requestOptions = { method: "POST", headers: { "content-type": "application/json", "X-Code-City-Request": "1", cookie }, body: JSON.stringify({ approval: "once", grant: preview.grant }) };
    expect((await fetch(new URL("/api/v1/ai/requests", server.url), { ...requestOptions, headers: { "content-type": "application/json", cookie } })).status).toBe(403);
    expect((await fetch(new URL("/api/v1/ai/requests", server.url), { ...requestOptions, headers: { "content-type": "application/json", "X-Code-City-Request": "1" } })).status).toBe(409);
    expect((await fetch(new URL("/api/v1/ai/requests", server.url), requestOptions)).status).toBe(200);
    expect(JSON.parse(providerBody)).toEqual(preview.transmission);
    expect(providerBody).not.toContain("grant");
    expect((await fetch(new URL("/api/v1/ai/requests", server.url), requestOptions)).status).toBe(409);
    expect(providerCalls).toBe(1);

    const concurrentPreview = await fetch(previewUrl, guidancePreviewOptions(imported.building.id, cookie));
    const concurrentGrant = (await concurrentPreview.json() as { preview: { grant: string } }).preview.grant;
    const concurrentOptions = { ...requestOptions, body: JSON.stringify({ approval: "once", grant: concurrentGrant }) };
    const concurrent = await Promise.all([
      fetch(new URL("/api/v1/ai/requests", server.url), concurrentOptions),
      fetch(new URL("/api/v1/ai/requests", server.url), concurrentOptions),
    ]);
    const concurrentStatuses = concurrent.map(({ status }) => status);
    expect(concurrentStatuses.filter((status) => status === 200)).toHaveLength(1);
    expect(concurrentStatuses.every((status) => status === 200 || status === 409 || status === 503)).toBe(true);
    expect((await fetch(new URL("/api/v1/ai/requests", server.url), concurrentOptions)).status).toBe(409);
    expect(providerCalls).toBe(2);
  });

  it("returns a normal unavailable preview one UTF-8 byte over the configured source limit", async () => {
    const maximumSourceBytes = 64;
    const prefix = "export {};\n// ";
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    const exactText = `${prefix}${"x".repeat(maximumSourceBytes - prefixBytes)}`;
    const overText = `${prefix}${"x".repeat(maximumSourceBytes - prefixBytes - 1)}é`;
    expect(Buffer.byteLength(exactText, "utf8")).toBe(maximumSourceBytes);
    expect(Buffer.byteLength(overText, "utf8")).toBe(maximumSourceBytes + 1);

    const providerFetch = vi.fn(async (_url: string | URL, init: RequestInit) =>
      successfulProviderResponse(init));
    const server = await fixture({
      aiGuidance: {
        version: 1,
        enabled: true,
        maximumSourceBytes,
        providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }],
      },
      aiGuidanceAdapterOptions: { fetch: providerFetch },
    });
    const retained = (name: string, text: string): RepositorySnapshot => ({
      name,
      files: [{ path: `src/${name}.ts`, text, byteLength: Buffer.byteLength(text, "utf8") }],
      diagnostics: [],
    });
    const exact = await publish(server, "exactAiBoundary", retained("exactAiBoundary", exactText));
    const over = await publish(server, "overAiBoundary", retained("overAiBoundary", overText));

    const exactResponse = await fetch(
      new URL(`/api/v1/ai/preview/${exact.job.id}/${exact.building.id}/local`, server.url),
      guidancePreviewOptions(exact.building.id),
    );
    expect(exactResponse.status).toBe(200);
    const exactBody = await exactResponse.json() as {
      preview: {
        availability: string;
        grant: string;
        limits: { maximumSourceBytes: number };
        transmission: { source: { text: string } };
      };
    };
    expect(exactBody.preview).toMatchObject({
      availability: "available",
      limits: { maximumSourceBytes },
      transmission: { source: { text: exactText } },
      grant: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });

    const overResponse = await fetch(
      new URL(`/api/v1/ai/preview/${over.job.id}/${over.building.id}/local`, server.url),
      guidancePreviewOptions(over.building.id),
    );
    expect(overResponse.status).toBe(200);
    const overBody = await overResponse.json() as { preview: Record<string, unknown> };
    expect(overBody.preview).toMatchObject({
      enabled: true,
      availability: "unavailable",
      provider: { id: "local", label: "Local" },
      reason: expect.stringMatching(/65 UTF-8 bytes.*maximum of 64 bytes.*not truncated.*no source was sent/iu),
      limits: { timeoutMs: 20_000, maximumSourceBytes },
      privacy: "no-prompt-storage",
    });
    expect(overBody.preview["context"]).toEqual(guidanceContext(over.building.id));
    expect(Object.keys(overBody.preview["context"] as Record<string, unknown>).sort()).toEqual([
      "buildingId",
      "kind",
      "version",
    ]);
    expect(overBody.preview).not.toHaveProperty("grant");
    expect(overBody.preview).not.toHaveProperty("transmission");
    expect(JSON.stringify(overBody)).not.toContain(overText);
    expect(providerFetch).not.toHaveBeenCalled();

    const cookie = exactResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
    const guidanceResponse = await fetch(new URL("/api/v1/ai/requests", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Code-City-Request": "1", cookie },
      body: JSON.stringify({ approval: "once", grant: exactBody.preview.grant }),
    });
    expect(guidanceResponse.status).toBe(200);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(providerFetch.mock.calls[0]![1].body))).toMatchObject({
      source: { text: exactText },
    });
  });

  it("derives file, type, callable, dependency, and smell contexts from retained artifacts", async () => {
    const providerPayloads: Record<string, unknown>[] = [];
    const server = await fixture({
      aiGuidance: { version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] },
      aiGuidanceAdapterOptions: {
        fetch: async (_url, init) => {
          providerPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return successfulProviderResponse(init);
        },
      },
    });
    const imported = await publish(server, "contextual", contextualSnapshot());
    const building = imported.model.buildings.find(({ path }) => path === "src/context.ts")!;
    const type = building.sourceStructure?.types.find(({ name }) => name === "ContextDemo")!;
    const callable = building.sourceStructure?.callables.find(({ name }) => name === "run")!;
    const dependency = imported.model.dependencies.find(({ sourceId }) => sourceId === building.id)!;
    const smell = evaluateDesignSmells(imported.model).findings.find(({ buildingId, ruleId }) => buildingId === building.id && ruleId === "high-complexity-method")!;
    expect(type).toBeDefined();
    expect(callable).toBeDefined();
    expect(dependency).toBeDefined();
    expect(smell.evidence.line).toBeDefined();

    const previewUrl = new URL(`/api/v1/ai/preview/${imported.job.id}/${building.id}/local`, server.url);
    let cookie: string | undefined;
    const preview = async (context: Record<string, unknown>) => {
      const response = await fetch(previewUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Code-City-Request": "1", ...(cookie === undefined ? {} : { cookie }) },
        body: JSON.stringify(context),
      });
      cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
      return { response, body: await response.json() as { preview: Record<string, unknown> } };
    };
    const fileDescriptor = guidanceContext(building.id);
    const typeDescriptor = { version: "codecity.ai-context/1", kind: "type", buildingId: building.id, stableId: type.id } as const;
    const callableDescriptor = { version: "codecity.ai-context/1", kind: "callable", buildingId: building.id, stableId: callable.id } as const;
    const previews = await Promise.all([fileDescriptor, typeDescriptor, callableDescriptor].map(async (descriptor) => (await preview(descriptor)).body.preview));
    expect(previews.map(({ availability }) => availability)).toEqual(["available", "available", "available"]);
    const typeTransmission = previews[1]!["transmission"] as { context: { stableId: string; range: unknown }; source: { text: string; lines: unknown } };
    expect(typeTransmission.context).toMatchObject({ stableId: type.id, range: type.range });
    expect(typeTransmission.source.lines).toEqual(type.range);
    expect(typeTransmission.source.text).toContain("class ContextDemo");
    expect(typeTransmission.source.text).not.toContain("import { helper }");
    const callableTransmission = previews[2]!["transmission"] as { context: { stableId: string; range: unknown }; source: { text: string; lines: unknown }; findings: { maximumComplexity: number } };
    expect(callableTransmission.context).toMatchObject({ stableId: callable.id, range: callable.range });
    expect(callableTransmission.source.lines).toEqual(callable.range);
    expect(callableTransmission.source.text).toContain("run(value: number)");
    expect(callableTransmission.source.text).not.toContain("class ContextDemo");
    expect(callableTransmission.findings.maximumComplexity).toBe(callable.complexity);

    const unavailable = await preview({ version: "codecity.ai-context/1", kind: "dependency", buildingId: building.id, dependencyId: dependency.id });
    expect(unavailable.response.status).toBe(200);
    expect(unavailable.body.preview).toMatchObject({ enabled: true, availability: "unavailable", context: { dependencyId: dependency.id }, reason: expect.stringMatching(/exact source range/) });
    expect(unavailable.body.preview).not.toHaveProperty("grant");

    const smellPreview = await preview({ version: "codecity.ai-context/1", kind: "smell", buildingId: building.id, findingId: smell.id, ruleId: smell.ruleId });
    expect(smellPreview.response.status).toBe(200);
    const smellTransmission = smellPreview.body.preview["transmission"] as { context: { findingId: string; evidence: unknown; range: unknown }; contextDigest: string; findingDigest: string; source: { text: string } };
    expect(smellTransmission.context).toMatchObject({ findingId: smell.id, evidence: smell.evidence, range: { startLine: smell.evidence.line, endLine: smell.evidence.endLine } });
    expect(smellTransmission.source.text).toContain("run(value: number)");
    expect(smellTransmission.contextDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(smellTransmission.findingDigest).toMatch(/^[0-9a-f]{64}$/u);
    const grant = smellPreview.body.preview["grant"] as string;
    const guidance = await fetch(new URL("/api/v1/ai/requests", server.url), { method: "POST", headers: { "content-type": "application/json", "X-Code-City-Request": "1", cookie: cookie! }, body: JSON.stringify({ approval: "once", grant }) });
    expect(guidance.status).toBe(200);
    expect(await guidance.json()).toMatchObject({ result: { context: { findingId: smell.id }, contextDigest: smellTransmission.contextDigest, findingDigest: smellTransmission.findingDigest } });
    expect(providerPayloads).toHaveLength(1);

    const forged = await preview({ ...typeDescriptor, range: { startLine: 1, endLine: 999 }, metrics: { sloc: 999 } });
    expect(forged.response.status).toBe(400);
    expect(providerPayloads).toHaveLength(1);
  });

  it.each([
    ["uses the exact decision-evidence link", true],
    ["does not infer a match from the unit name or line range", false],
  ] as const)(
    "%s when a callable has no declared complexity",
    async (_expectation, retainExactEvidenceLink) => {
      const server = await fixture({
        aiGuidance: {
          version: 1,
          enabled: true,
          providers: [{
            id: "local",
            label: "Local",
            endpoint: "http://localhost:11434/guidance",
          }],
        },
      });
      const imported = await publish(
        server,
        `callable-fallback-${String(retainExactEvidenceLink)}`,
        contextualSnapshot(),
        undefined,
        withoutDeclaredCallableComplexity(retainExactEvidenceLink),
      );
      const building = imported.model.buildings.find(
        ({ path: buildingPath }) => buildingPath === "src/context.ts",
      )!;
      const callable = building.sourceStructure!.callables.find(
        ({ name }) => name === "run",
      )!;
      const matchingUnit = building.units!.find(
        ({ name, line, endLine }) =>
          name === callable.name &&
          line === callable.range.startLine &&
          (endLine ?? line) === callable.range.endLine,
      )!;
      expect(callable.complexity).toBeUndefined();
      expect(matchingUnit.complexity).toBeGreaterThan(1);
      expect(matchingUnit.decisionEvidence?.callableId).toBe(
        retainExactEvidenceLink ? callable.id : undefined,
      );

      const response = await fetch(
        new URL(
          `/api/v1/ai/preview/${imported.job.id}/${building.id}/local`,
          server.url,
        ),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Code-City-Request": "1",
          },
          body: JSON.stringify({
            version: "codecity.ai-context/1",
            kind: "callable",
            buildingId: building.id,
            stableId: callable.id,
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json() as {
        preview: {
          transmission: {
            findings: {
              maximumComplexity: number;
              decisionLoad: number;
            };
          };
        };
      };
      const expectedComplexity = retainExactEvidenceLink
        ? matchingUnit.complexity
        : 0;
      expect(body.preview.transmission.findings).toMatchObject({
        maximumComplexity: expectedComplexity,
        decisionLoad: Math.max(0, expectedComplexity - 1),
      });
    },
  );

  it.each(["absent", "unavailable"] as const)(
    "rejects forged declaration IDs when source structure is %s",
    async (mode) => {
      const providerFetch = vi.fn(async (_url: string | URL, init: RequestInit) =>
        successfulProviderResponse(init));
      const server = await fixture({
        aiGuidance: {
          version: 1,
          enabled: true,
          providers: [{
            id: "local",
            label: "Local",
            endpoint: "http://localhost:11434/guidance",
          }],
        },
        aiGuidanceAdapterOptions: { fetch: providerFetch },
      });
      const name = `legacy${mode}`;
      const imported = await publish(
        server,
        name,
        snapshot(name),
        undefined,
        withoutAvailableSourceStructure(mode),
      );
      expect(imported.building.units).not.toHaveLength(0);
      const preview = async (kind: "type" | "callable", stableId: string) => {
        const response = await fetch(
          new URL(`/api/v1/ai/preview/${imported.job.id}/${imported.building.id}/local`, server.url),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-Code-City-Request": "1",
            },
            body: JSON.stringify({
              version: "codecity.ai-context/1",
              kind,
              buildingId: imported.building.id,
              stableId,
            }),
          },
        );
        return { status: response.status, body: await response.json() as { preview?: Record<string, unknown> } };
      };

      const forgedType = await preview("type", `${imported.building.id}:type:forged`);
      const forgedCallable = await preview("callable", `${imported.building.id}:function:9999`);
      expect(forgedType.status).toBe(404);
      expect(forgedCallable.status).toBe(404);
      expect(forgedType.body.preview).toBeUndefined();
      expect(forgedCallable.body.preview).toBeUndefined();

      const validLegacyId = `${imported.building.id}:function:0000`;
      const validLegacy = await preview("callable", validLegacyId);
      if (mode === "absent") {
        expect(validLegacy.status).toBe(200);
        expect(validLegacy.body.preview).toMatchObject({
          enabled: true,
          availability: "unavailable",
          context: { kind: "callable", stableId: validLegacyId },
          reason: expect.stringMatching(/source structure is unavailable/iu),
        });
        expect(validLegacy.body.preview).not.toHaveProperty("grant");
      } else {
        expect(validLegacy.status).toBe(404);
        expect(validLegacy.body.preview).toBeUndefined();
      }
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it("binds grants to distinct trusted-network browser sessions and expires them", async () => {
    let providerCalls = 0;
    const server = await fixture({
      aiGuidance: { version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] },
      aiGuidanceAdapterOptions: {
        fetch: async (_url, init) => {
          providerCalls += 1;
          return successfulProviderResponse(init);
        },
      },
    });
    const imported = await publish(server, "sessionBound");
    const previewUrl = new URL(`/api/v1/ai/preview/${imported.job.id}/${imported.building.id}/local`, server.url);
    const preview = async (cookie?: string) => {
      const response = await fetch(previewUrl, guidancePreviewOptions(imported.building.id, cookie));
      const grant = (await response.json() as { preview: { grant: string } }).preview.grant;
      return { grant, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie! };
    };
    const first = await preview();
    const second = await preview();
    const send = (grant: string, cookie: string) => fetch(new URL("/api/v1/ai/requests", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Code-City-Request": "1", cookie },
      body: JSON.stringify({ approval: "once", grant }),
    });
    expect((await send(first.grant, second.cookie)).status).toBe(409);
    expect((await send(first.grant, first.cookie)).status).toBe(200);
    const changed = await preview(first.cookie);
    const originalReadFile = server.sources.readFile.bind(server.sources);
    const changedRead = vi.spyOn(server.sources, "readFile").mockImplementationOnce(async (...arguments_) => {
      const stored = await originalReadFile(...arguments_);
      return stored === undefined ? undefined : {
        ...stored,
        file: { ...stored.file, text: stored.file.text.replace("sessionBound", "changedSource") },
      };
    });
    expect((await send(changed.grant, first.cookie)).status).toBe(409);
    changedRead.mockRestore();
    const expiring = await preview(first.cookie);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60_000 + 1);
      expect((await send(expiring.grant, first.cookie)).status).toBe(409);
    } finally {
      vi.useRealTimers();
    }
    expect(providerCalls).toBe(1);
  });

  it("isolates stalled guidance per job and aborts it before deleting that job", async () => {
    let providerStarted!: () => void;
    let providerAborted!: () => void;
    let releaseAbortedProvider!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { providerAborted = resolve; });
    const abortReleased = new Promise<void>((resolve) => { releaseAbortedProvider = resolve; });
    const server = await fixture({
      aiGuidance: { version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] },
      aiGuidanceAdapterOptions: {
        fetch: async (_url, init) => {
          const payload = JSON.parse(String(init.body)) as { source: { path: string } };
          if (payload.source.path.endsWith("stalledA.ts")) {
            providerStarted();
            return await new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                providerAborted();
                void abortReleased.then(() => reject(new Error("aborted")));
              }, { once: true });
            });
          }
          return successfulProviderResponse(init);
        },
      },
    });
    const first = await publish(server, "stalledA");
    const second = await publish(server, "independentB");
    const preview = async (imported: typeof first) => {
      const response = await fetch(new URL(`/api/v1/ai/preview/${imported.job.id}/${imported.building.id}/local`, server.url), guidancePreviewOptions(imported.building.id));
      return {
        cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!,
        grant: (await response.json() as { preview: { grant: string } }).preview.grant,
      };
    };
    const firstApproval = await preview(first);
    const secondApproval = await preview(second);
    const guidanceRequest = (approval: { cookie: string; grant: string }) => fetch(new URL("/api/v1/ai/requests", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Code-City-Request": "1", cookie: approval.cookie },
      body: JSON.stringify({ approval: "once", grant: approval.grant }),
    });
    let firstGuidanceSettled = false;
    const guidance = guidanceRequest(firstApproval).then((response) => {
      firstGuidanceSettled = true;
      return response;
    });
    await started;
    for (const imported of [first, second]) {
      expect((await fetch(new URL(`/api/v1/artifacts/${imported.job.id}/sources/${imported.building.id}`, server.url))).status).toBe(200);
    }
    expect((await guidanceRequest(secondApproval)).status).toBe(200);
    expect(firstGuidanceSettled).toBe(false);
    expect((await fetch(new URL(`/api/v1/imports/${second.job.id}/result`, server.url), { method: "DELETE", headers: { "X-Code-City-Request": "1" } })).status).toBe(200);
    expect(firstGuidanceSettled).toBe(false);
    expect(await server.sources.read(second.job.id)).toBeUndefined();
    let deletionObservedAbort = false;
    void aborted.then(() => { deletionObservedAbort = true; });
    let deletionSettled = false;
    const deletion = fetch(new URL(`/api/v1/imports/${first.job.id}/result`, server.url), { method: "DELETE", headers: { "X-Code-City-Request": "1" } }).then((response) => {
      deletionSettled = true;
      return response;
    });
    await aborted;
    expect(deletionSettled).toBe(false);
    expect((await fetch(new URL(`/api/v1/ai/preview/${first.job.id}/${first.building.id}/local`, server.url), guidancePreviewOptions(first.building.id, firstApproval.cookie))).status).toBe(409);
    releaseAbortedProvider();
    expect((await guidance).status).toBe(502);
    expect((await deletion).status).toBe(200);
    expect(deletionObservedAbort).toBe(true);
    expect(await server.sources.read(first.job.id)).toBeUndefined();
  });

  it("cancels retained-source work when an AI preview disconnects", async () => {
    const server = await fixture({
      aiGuidance: { version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] },
    });
    const imported = await publish(server, "previewDisconnect");
    let readStarted!: () => void;
    let readAborted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { readAborted = resolve; });
    vi.spyOn(server.sources, "readFile").mockImplementation(async (_job, _building, _expected, signal) => {
      readStarted();
      return await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => {
        readAborted();
        reject(new Error("aborted"));
      }, { once: true }));
    });
    const controller = new AbortController();
    const pending = fetch(new URL(`/api/v1/ai/preview/${imported.job.id}/${imported.building.id}/local`, server.url), { ...guidancePreviewOptions(imported.building.id), signal: controller.signal }).catch(() => undefined);
    await started;
    controller.abort();
    await pending;
    await aborted;
  });

  it("releases the per-job lease after provider failure", async () => {
    const server = await fixture({
      aiGuidance: { version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] },
      aiGuidanceAdapterOptions: { fetch: async () => { throw new Error("provider failed"); } },
    });
    const imported = await publish(server, "providerFailure");
    const preview = await fetch(new URL(`/api/v1/ai/preview/${imported.job.id}/${imported.building.id}/local`, server.url), guidancePreviewOptions(imported.building.id));
    const cookie = preview.headers.get("set-cookie")!.split(";", 1)[0]!;
    const grant = (await preview.json() as { preview: { grant: string } }).preview.grant;
    expect((await fetch(new URL("/api/v1/ai/requests", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Code-City-Request": "1", cookie },
      body: JSON.stringify({ approval: "once", grant }),
    })).status).toBe(502);
    expect((await fetch(new URL(`/api/v1/imports/${imported.job.id}/result`, server.url), { method: "DELETE", headers: { "X-Code-City-Request": "1" } })).status).toBe(200);
  });

  it("aborts provider I/O and releases the job lease when the guidance client disconnects", async () => {
    let providerStarted!: () => void;
    let providerAborted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { providerAborted = resolve; });
    const server = await fixture({
      aiGuidance: { version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] },
      aiGuidanceAdapterOptions: {
        fetch: async (_url, init) => {
          providerStarted();
          return await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => {
            providerAborted();
            reject(new Error("aborted"));
          }, { once: true }));
        },
      },
    });
    const imported = await publish(server, "guidanceDisconnect");
    const preview = await fetch(new URL(`/api/v1/ai/preview/${imported.job.id}/${imported.building.id}/local`, server.url), guidancePreviewOptions(imported.building.id));
    const cookie = preview.headers.get("set-cookie")!.split(";", 1)[0]!;
    const grant = (await preview.json() as { preview: { grant: string } }).preview.grant;
    const controller = new AbortController();
    const pending = fetch(new URL("/api/v1/ai/requests", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Code-City-Request": "1", cookie },
      body: JSON.stringify({ approval: "once", grant }),
      signal: controller.signal,
    }).catch(() => undefined);
    await started;
    controller.abort();
    await pending;
    await aborted;
    expect((await fetch(new URL(`/api/v1/imports/${imported.job.id}/result`, server.url), { method: "DELETE", headers: { "X-Code-City-Request": "1" } })).status).toBe(200);
  });
});
