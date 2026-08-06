import { describe, expect, it } from "vitest";

import { EVOLUTION_BUNDLE_LIMITS } from "../packages/core/src/evolution.js";
import {
  ImportApiError,
  parseCapabilitiesResponse,
  parseImportJob,
  parseUploadReservationResponse,
  readExactEvolutionArtifact,
  ViewerImportApiClient,
  type ImportApiFetch,
  type ImportJob,
  type RemoteImportSubmission,
  type UploadImportSubmission,
} from "../apps/viewer/src/import-api.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-07-30T10:00:00.000Z";
const AUTHORIZATION_TOKEN =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

function queuedJob(id = JOB_ID): ImportJob {
  return {
    id,
    kind: "project-import",
    state: "queued",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function completedJob(id = JOB_ID): ImportJob {
  return {
    ...queuedJob(id),
    state: "completed",
    progress: { phase: "ready", current: 3, total: 3 },
    result: {
      kind: "city-model",
      artifactToken: id,
      artifactUrl: `/api/v1/artifacts/${id}/city-model.json`,
    },
  };
}

function completedHistoryJob(id = JOB_ID): ImportJob {
  return {
    ...completedJob(id),
    result: {
      ...completedJob(id).result!,
      evolution: {
        artifactUrl: `/api/v1/artifacts/${id}/evolution.json`,
        size: 12_345,
        sha256: "a".repeat(64),
      },
    },
  };
}

function jsonResponse(
  value: unknown,
  options: {
    readonly status?: number;
    readonly location?: string;
    readonly url?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Response {
  const text = `${JSON.stringify(value)}\n`;
  const response = new Response(text, {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(new TextEncoder().encode(text).byteLength),
      ...(options.location === undefined
        ? {}
        : { location: options.location }),
      ...options.headers,
    },
  });
  if (options.url !== undefined) {
    Object.defineProperty(response, "url", { value: options.url });
  }
  return response;
}

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

describe("viewer import API protocol", () => {
  it("loads an exact same-origin evolution artifact with a strict size bound", async () => {
    const bytes = new TextEncoder().encode('{"schemaVersion":"1.0"}');
    const calls: string[] = [];
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/viewer"),
      {
        fetch: async (input) => {
          calls.push(input.toString());
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(bytes.byteLength),
            },
          });
        },
      },
    );
    const result = await client.evolutionArtifact(JOB_ID, {
      artifactUrl: `/api/v1/artifacts/${JOB_ID}/evolution.json`,
      size: bytes.byteLength,
      sha256: "a".repeat(64),
    });

    expect(new Uint8Array(result)).toEqual(bytes);
    expect(calls).toEqual([
      `https://city.example.test/api/v1/artifacts/${JOB_ID}/evolution.json`,
    ]);
  });

  it("copies many response chunks into one exact owned allocation", async () => {
    const chunkCount = 4_096;
    const chunks = Array.from(
      { length: chunkCount },
      (_, index) =>
        Uint8Array.of(
          index & 0xff,
          (index >>> 8) & 0xff,
          0xa5,
        ),
    );
    const size = chunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    );
    const expected = new Uint8Array(size);
    let expectedOffset = 0;
    for (const chunk of chunks) {
      expected.set(chunk, expectedOffset);
      expectedOffset += chunk.byteLength;
    }

    let readIndex = 0;
    let cancelCalls = 0;
    let releaseCalls = 0;
    const response = {
      headers: new Headers({ "content-length": String(size) }),
      body: {
        getReader: () => ({
          read: async (): Promise<
            ReadableStreamReadResult<Uint8Array>
          > =>
            readIndex < chunks.length
              ? { done: false, value: chunks[readIndex++]! }
              : { done: true, value: undefined },
          cancel: async () => {
            cancelCalls += 1;
          },
          releaseLock: () => {
            releaseCalls += 1;
          },
        }),
      },
    } as unknown as Response;
    const allocations: number[] = [];
    let allocated: ArrayBuffer | undefined;
    const result = await readExactEvolutionArtifact(
      response,
      new AbortController().signal,
      size,
      (byteLength) => {
        allocations.push(byteLength);
        allocated = new ArrayBuffer(byteLength);
        return allocated;
      },
    );

    expect(allocations).toEqual([size]);
    expect(result).toBe(allocated);
    expect(new Uint8Array(result)).toEqual(expected);
    expect(cancelCalls).toBe(0);
    expect(releaseCalls).toBe(1);

    for (const chunk of chunks) chunk.fill(0);
    expect(new Uint8Array(result)).toEqual(expected);
  });

  it("cancels a stalled exact-length evolution stream", async () => {
    let reads = 0;
    let cancelCalls = 0;
    let secondReadStarted!: () => void;
    const waitingForSecondRead = new Promise<void>((resolve) => {
      secondReadStarted = resolve;
    });
    const stalled = new Promise<
      ReadableStreamReadResult<Uint8Array>
    >(() => undefined);
    const response = {
      headers: new Headers({ "content-length": "2" }),
      body: {
        getReader: () => ({
          read: (): Promise<
            ReadableStreamReadResult<Uint8Array>
          > => {
            reads += 1;
            if (reads === 1) {
              return Promise.resolve({
                done: false,
                value: Uint8Array.of(1),
              });
            }
            secondReadStarted();
            return stalled;
          },
          cancel: async () => {
            cancelCalls += 1;
          },
          releaseLock: () => undefined,
        }),
      },
    } as unknown as Response;
    const controller = new AbortController();
    const reading = readExactEvolutionArtifact(
      response,
      controller.signal,
      2,
    );

    await waitingForSecondRead;
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelCalls).toBe(1);
  });

  it("cancels an unlocked evolution body on early rejection", async () => {
    let mismatchCancellations = 0;
    const mismatched = {
      headers: new Headers({ "content-length": "1" }),
      body: {
        cancel: async () => {
          mismatchCancellations += 1;
        },
      },
    } as unknown as Response;
    await expect(
      readExactEvolutionArtifact(
        mismatched,
        new AbortController().signal,
        2,
      ),
    ).rejects.toThrow(/size does not match/iu);
    expect(mismatchCancellations).toBe(1);

    let abortCancellations = 0;
    const aborted = {
      headers: new Headers({ "content-length": "2" }),
      body: {
        cancel: async () => {
          abortCancellations += 1;
        },
      },
    } as unknown as Response;
    const controller = new AbortController();
    controller.abort();
    await expect(
      readExactEvolutionArtifact(aborted, controller.signal, 2),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortCancellations).toBe(1);
  });

  it("rejects truncated or misdeclared evolution artifacts", async () => {
    const bytes = new TextEncoder().encode("{}");
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/"),
      {
        fetch: async () =>
          new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(bytes.byteLength),
            },
          }),
      },
    );
    await expect(
      client.evolutionArtifact(JOB_ID, {
        artifactUrl: `/api/v1/artifacts/${JOB_ID}/evolution.json`,
        size: bytes.byteLength + 1,
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/size does not match/iu);
  });

  it("rejects an oversized evolution artifact before downloading it", async () => {
    let fetched = false;
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/"),
      {
        fetch: async () => {
          fetched = true;
          throw new Error("The oversized artifact must not be fetched.");
        },
      },
    );

    await expect(
      client.evolutionArtifact(JOB_ID, {
        artifactUrl: `/api/v1/artifacts/${JOB_ID}/evolution.json`,
        size: EVOLUTION_BUNDLE_LIMITS.serializedBytes + 1,
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow(
      /browser-safe 64 MiB limit.*fewer history frames.*maxEvolutionOutputBytes/iu,
    );
    expect(fetched).toBe(false);
  });

  it("accepts a bounded retained source response above the generic API limit", async () => {
    const payload = {
      source: {
        text: "x".repeat(512 * 1024),
      },
    };
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/"),
      { fetch: async () => jsonResponse(payload) },
    );
    await expect(
      client.buildingSource(
        JOB_ID,
        "building:1234567890abcdef",
      ),
    ).resolves.toEqual(payload);
  });

  it("uses exact same-origin session requests and exposes only redacted profiles", async () => {
    const calls: Array<{
      readonly input: string | URL;
      readonly init: RequestInit;
    }> = [];
    const responses = [
      jsonResponse({
        authorization: {
          mode: "shared-secret",
          required: true,
          authenticated: false,
        },
      }),
      new Response(null, {
        status: 204,
        headers: { "content-length": "0" },
      }),
      jsonResponse({
        credentialProfiles: [
          { id: "ado", label: "Azure", provider: "azure-devops" },
          { id: "github", label: "GitHub", provider: "github" },
        ],
      }),
      new Response(null, {
        status: 204,
        headers: { "content-length": "0" },
      }),
    ];
    const fetch: ImportApiFetch = async (input, init) => {
      calls.push({ input, init });
      return responses.shift()!;
    };
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/viewer"),
      { fetch },
    );

    expect(await client.authorizationStatus()).toEqual({
      mode: "shared-secret",
      required: true,
      authenticated: false,
    });
    await client.createSession(AUTHORIZATION_TOKEN);
    expect(await client.capabilities()).toEqual([
      { id: "ado", label: "Azure", provider: "azure-devops" },
      { id: "github", label: "GitHub", provider: "github" },
    ]);
    await client.logout();

    expect(calls.map(({ input }) => input.toString())).toEqual([
      "https://city.example.test/api/v1/auth/session",
      "https://city.example.test/api/v1/auth/session",
      "https://city.example.test/api/v1/imports/capabilities",
      "https://city.example.test/api/v1/auth/session",
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        mode: "same-origin",
      });
    }
    expect(headersOf(calls[0]!.init)).not.toHaveProperty("authorization");
    expect(headersOf(calls[1]!.init)).toEqual({
      authorization: `Bearer ${AUTHORIZATION_TOKEN}`,
      "x-code-city-request": "1",
    });
    expect(headersOf(calls[2]!.init)).not.toHaveProperty("authorization");
    expect(calls[3]!.init.method).toBe("DELETE");
    expect(calls[3]!.init.keepalive).toBe(true);
    expect(headersOf(calls[3]!.init)).toEqual({
      "x-code-city-request": "1",
    });
  });

  it("rejects non-canonical bootstrap tokens and unexpected read statuses", async () => {
    let fetchCount = 0;
    const responses = [
      jsonResponse(
        {
          authorization: {
            mode: "shared-secret",
            required: true,
            authenticated: false,
          },
        },
        { status: 201 },
      ),
      jsonResponse(
        { credentialProfiles: [] },
        { status: 206 },
      ),
    ];
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/"),
      {
        fetch: async () => {
          fetchCount += 1;
          return responses.shift()!;
        },
      },
    );

    await expect(client.createSession("not-a-token")).rejects.toThrow(
      /canonical/u,
    );
    expect(fetchCount).toBe(0);
    await expect(client.authorizationStatus()).rejects.toThrow(
      /success status/u,
    );
    await expect(client.capabilities()).rejects.toThrow(
      /success status/u,
    );
  });

  it("submits exact remote imports and verifies both job identity and Location", async () => {
    const calls: Array<{
      readonly input: string | URL;
      readonly init: RequestInit;
    }> = [];
    const fetch: ImportApiFetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(
        { job: queuedJob() },
        {
          status: 202,
          location: `/api/v1/jobs/${JOB_ID}`,
        },
      );
    };
    const client = new ViewerImportApiClient(
      new URL("http://raspberrypi.local/"),
      { fetch },
    );
    const request: RemoteImportSubmission = {
      source: {
        kind: "github" as const,
        repositoryUrl: "https://github.com/openai/example",
        credentialProfileId: "github",
        revision: { kind: "tag" as const, name: "v1" },
      },
      history: {
        mode: "date-range" as const,
        fromInclusive: "2026-01-01T00:00:00.000Z",
        toInclusive: "2026-01-31T23:59:59.000Z",
        maxCommits: 100,
        sampleEvery: 2,
        totalDeadlineMs: 60_000,
        maxAggregateChangedPaths: 10_000,
        maxAggregateChangedPathBytes: 250_000,
        maxAggregateSemanticBytes: 750_000,
        maxAggregateTreeEntries: 20_000,
        maxUniqueLineages: 5_000,
        maxEvolutionOutputBytes: 1_000_000,
      },
      identity: { title: "Imported" },
      analysis: { maxRetainedFiles: 1_000 },
    };

    expect(await client.createRemoteImport(request)).toEqual(queuedJob());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.toString()).toBe(
      "http://raspberrypi.local/api/v1/imports",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(headersOf(calls[0]!.init)).toEqual({
      "content-type": "application/json",
      "x-code-city-request": "1",
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(request);
  });

  it("keeps cancellation and completed-result removal on distinct requests", async () => {
    const calls: Array<{
      readonly input: string | URL;
      readonly init: RequestInit;
    }> = [];
    const deadlines: number[] = [];
    const responses = [
      jsonResponse({ job: queuedJob() }),
      jsonResponse({ deleted: true, job: completedJob() }),
    ];
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/"),
      {
        fetch: async (input, init) => {
          calls.push({ input, init });
          return responses.shift()!;
        },
        scheduleDeadline: (_callback, milliseconds) => {
          deadlines.push(milliseconds);
          return milliseconds;
        },
        clearDeadline: () => undefined,
      },
    );

    expect(await client.cancelJob(JOB_ID)).toEqual(queuedJob());
    expect(await client.removeCompletedJob(JOB_ID)).toEqual(
      completedJob(),
    );
    expect(calls.map(({ input }) => input.toString())).toEqual([
      `https://city.example.test/api/v1/jobs/${JOB_ID}`,
      `https://city.example.test/api/v1/imports/${JOB_ID}/result`,
    ]);
    for (const { init } of calls) {
      expect(init.method).toBe("DELETE");
      expect(headersOf(init)).toEqual({
        "x-code-city-request": "1",
      });
    }
    expect(deadlines).toEqual([
      11 * 60_000,
      31 * 60_000,
    ]);
  });

  it("reserves and uploads a Blob without attempting a forbidden Content-Length header", async () => {
    const request: UploadImportSubmission = {
      source: { kind: "city-model", sizeBytes: 2 },
    };
    const reservation = {
      token: UPLOAD_ID,
      uploadUrl: `/api/v1/imports/uploads/${UPLOAD_ID}`,
      mediaType: "application/json" as const,
      sizeBytes: 2,
      expiresAt: "2026-07-30T10:05:00.000Z",
    };
    const calls: RequestInit[] = [];
    const responses = [
      jsonResponse(
        { upload: reservation },
        {
          status: 201,
          location: reservation.uploadUrl,
        },
      ),
      jsonResponse(
        { job: queuedJob() },
        {
          status: 202,
          location: `/api/v1/jobs/${JOB_ID}`,
        },
      ),
    ];
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/"),
      {
        fetch: async (_input, init) => {
          calls.push(init);
          return responses.shift()!;
        },
      },
    );

    const reserved = await client.reserveUpload(request);
    const body = new Blob(["{}"], { type: "application/json" });
    expect(await client.upload(reserved, body)).toEqual(queuedJob());

    expect(headersOf(calls[1]!)).toEqual({
      "content-type": "application/json",
      "x-code-city-request": "1",
    });
    expect(headersOf(calls[1]!)).not.toHaveProperty("content-length");
    expect(calls[1]!.body).toBe(body);
  });

  it("preserves bounded field errors without reflecting malformed error bodies", async () => {
    const validError = jsonResponse(
      {
        error: {
          code: "invalid-import-request",
          message: "The import request is invalid.",
          fields: [
            {
              code: "required",
              path: "$.source.repositoryUrl",
              message: "Field is required.",
            },
          ],
        },
      },
      { status: 400 },
    );
    const malformedError = new Response("secret diagnostic", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    const responses = [validError, malformedError];
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/"),
      { fetch: async () => responses.shift()! },
    );

    const first = await client
      .createRemoteImport({
        source: { kind: "github", repositoryUrl: "" },
      })
      .catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ImportApiError);
    expect((first as ImportApiError).details).toMatchObject({
      status: 400,
      code: "invalid-import-request",
      fields: [
        {
          code: "required",
          path: "$.source.repositoryUrl",
          message: "Field is required.",
        },
      ],
    });

    const second = await client
      .capabilities()
      .catch((error: unknown) => error);
    expect(second).toBeInstanceOf(ImportApiError);
    expect((second as Error).message).not.toContain("secret diagnostic");
  });

  it("rejects redirected, cross-origin, and structurally inconsistent responses", async () => {
    const redirected = jsonResponse({ credentialProfiles: [] });
    Object.defineProperty(redirected, "redirected", { value: true });
    const crossOrigin = jsonResponse(
      { credentialProfiles: [] },
      { url: "https://attacker.example/api/v1/imports/capabilities" },
    );
    const badJob = jsonResponse(
      {
        job: {
          ...completedJob(),
          result: {
            ...completedJob().result!,
            artifactUrl: "https://attacker.example/model.json",
          },
        },
      },
      {
        status: 202,
        location: `/api/v1/jobs/${JOB_ID}`,
      },
    );
    const responses = [redirected, crossOrigin, badJob];
    const client = new ViewerImportApiClient(
      new URL("https://city.example.test/"),
      { fetch: async () => responses.shift()! },
    );

    await expect(client.capabilities()).rejects.toThrow(/redirect/u);
    await expect(client.capabilities()).rejects.toThrow(/redirect/u);
    await expect(
      client.createRemoteImport({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
        },
      }),
    ).rejects.toThrow(/result/u);
  });

  it("strictly validates capability, job, and reservation envelopes", () => {
    expect(() =>
      parseCapabilitiesResponse({
        credentialProfiles: [
          { id: "same", label: "One", provider: "github" },
          { id: "same", label: "Two", provider: "github" },
        ],
      }),
    ).toThrow(/unique/u);
    expect(() =>
      parseCapabilitiesResponse({
        credentialProfiles: [],
        repositoryScopes: ["private"],
      }),
    ).toThrow(/shape/u);
    expect(() =>
      parseImportJob({
        ...queuedJob(),
        source: "https://github.com/private/repository",
      }),
    ).toThrow(/shape/u);
    expect(() =>
      parseImportJob({
        ...queuedJob(),
        state: "completed",
      }),
    ).toThrow(/terminal/u);
    expect(parseImportJob(completedHistoryJob())).toEqual(
      completedHistoryJob(),
    );
    const historyFailure = {
      ...queuedJob(),
      state: "failed",
      error: {
        code: "history-too-long",
        message:
          "This mainline has more than 500 commits. Choose a custom history range.",
      },
    } as const;
    expect(parseImportJob(historyFailure)).toEqual(historyFailure);
    expect(
      parseImportJob({
        ...completedJob(),
        result: {
          ...completedJob().result!,
          source: { availability: "not-captured" },
        },
      }).result?.source,
    ).toEqual({ availability: "not-captured" });
    for (const evolution of [
      {
        ...completedHistoryJob().result!.evolution!,
        artifactUrl: "https://attacker.example/evolution.json",
      },
      {
        ...completedHistoryJob().result!.evolution!,
        size: 0,
      },
      {
        ...completedHistoryJob().result!.evolution!,
        size: EVOLUTION_BUNDLE_LIMITS.serializedBytes + 1,
      },
      {
        ...completedHistoryJob().result!.evolution!,
        sha256: "A".repeat(64),
      },
      {
        ...completedHistoryJob().result!.evolution!,
        repositoryUrl: "https://github.com/private/repository",
      },
    ]) {
      expect(() =>
        parseImportJob({
          ...completedHistoryJob(),
          result: {
            ...completedHistoryJob().result!,
            evolution,
          },
        }),
      ).toThrow(/evolution|shape/iu);
    }

    const request: UploadImportSubmission = {
      source: { kind: "city-model", sizeBytes: 2 },
    };
    expect(() =>
      parseUploadReservationResponse(
        {
          upload: {
            token: UPLOAD_ID,
            uploadUrl: "https://attacker.example/upload",
            mediaType: "application/json",
            sizeBytes: 2,
            expiresAt: CREATED_AT,
          },
        },
        request,
      ),
    ).toThrow(/inconsistent/u);
  });
});
