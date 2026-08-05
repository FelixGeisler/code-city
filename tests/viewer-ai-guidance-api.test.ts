import { describe, expect, it, vi } from "vitest";

import { ViewerImportApiClient } from "../apps/viewer/src/import-api.js";

const buildingId = "typescript:0123456789abcdef";
const descriptor = { version: "codecity.ai-context/1", kind: "file", buildingId } as const;
const context = { ...descriptor, label: "a.ts source file", range: { startLine: 1, endLine: 1 } } as const;
const contextDigest = "a".repeat(64);

function availablePreview(sourceText = "export {};\n", limits = { timeoutMs: 20_000, maximumSourceBytes: 131_072 }): unknown {
  return { preview: {
    enabled: true,
    availability: "available",
    provider: { id: "local", label: "Local" },
    transmission: { version: 1, task: "source-guidance", providerId: "local", context, contextDigest, source: { path: "src/a.ts", language: "typescript", text: sourceText, lines: { startLine: 1, endLine: 1 } }, findings: { sloc: 1, maximumComplexity: 1, decisionLoad: 0 } },
    limits,
    privacy: "no-prompt-storage",
    grant: "A".repeat(43),
  } };
}

describe("viewer AI guidance API", () => {
  it("creates previews only through a CSRF-marked POST", async () => {
    let request: RequestInit | undefined;
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit) => { request = init; return new Response(JSON.stringify({ preview: {
      enabled: true,
      availability: "available",
      provider: { id: "local", label: "Local" },
      transmission: { version: 1, task: "source-guidance", providerId: "local", context, contextDigest, source: { path: "src/a.ts", language: "typescript", text: "export {};\n", lines: { startLine: 1, endLine: 1 } }, findings: { sloc: 1, maximumComplexity: 1, decisionLoad: 0 } },
      limits: { timeoutMs: 20_000, maximumSourceBytes: 131_072 },
      privacy: "no-prompt-storage",
      grant: "A".repeat(43),
    } }), { status: 200, headers: { "content-type": "application/json" } }); });
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch });
    await client.aiGuidancePreview("00000000-0000-4000-8000-000000000000", descriptor, "local");
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("X-Code-City-Request")).toBe("1");
    expect(JSON.parse(String(request?.body))).toEqual(descriptor);
    expect(String(request?.body)).not.toContain("export");
  });

  it("rejects extra fields in AI responses", async () => {
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch: async () => new Response(JSON.stringify({ enabled: true, providers: [], extra: true }), { headers: { "content-type": "application/json" } }) });
    await expect(client.aiGuidanceProviders()).rejects.toThrow(/invalid shape/);
  });

  it("never places source text in the confirmation request", async () => {
    let request: RequestInit | undefined;
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit) => { request = init; return new Response(JSON.stringify({ result: { provider: { id: "local", label: "Local" }, context, contextDigest, suggestions: [] } }), { status: 200, headers: { "content-type": "application/json" } }); });
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch });
    await client.aiGuidanceRequest("A".repeat(43), 20_000);
    const body = String(request?.body);
    expect(body).toContain('"approval":"once"');
    expect(body).not.toContain("metrics");
    expect(body).not.toContain("text");
    expect(body).not.toContain("source");
    expect(new Headers(request?.headers).get("X-Code-City-Request")).toBe("1");
  });

  it("uses the advertised provider timeout plus bounded response overhead", async () => {
    const scheduled: number[] = [];
    const fetch = vi.fn(async (input: string | URL) => {
      if (new URL(input).pathname.includes("/preview/")) {
        return new Response(
          JSON.stringify(availablePreview("export {};\n", {
            timeoutMs: 45_000,
            maximumSourceBytes: 131_072,
          })),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ result: { provider: { id: "local", label: "Local" }, context, contextDigest, suggestions: [] } }), { headers: { "content-type": "application/json" } });
    });
    const client = new ViewerImportApiClient(new URL("http://localhost/"), {
      fetch,
      scheduleDeadline: (_callback, milliseconds) => {
        scheduled.push(milliseconds);
        return scheduled.length;
      },
      clearDeadline: () => undefined,
    });
    const result = await client.aiGuidancePreview(
      "00000000-0000-4000-8000-000000000000",
      descriptor,
      "local",
    );
    if (result.preview.availability !== "available") throw new Error("Expected an available preview.");
    await client.aiGuidanceRequest(
      result.preview.grant,
      result.preview.limits.timeoutMs,
    );
    expect(scheduled.at(-1)).toBe(55_000);
    expect(scheduled.at(-1)).toBeGreaterThan(30_000);
    expect(scheduled.at(-1)).toBeLessThan(2 * 60_000);
  });

  it.each([999, 60_001, 1_000.5])(
    "rejects invalid confirmation timeout %s before fetching",
    async (timeoutMs) => {
      const fetch = vi.fn(async () => new Response());
      const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch });
      await expect(client.aiGuidanceRequest("A".repeat(43), timeoutMs)).rejects.toThrow(/AI timeout is invalid/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("lets an already-aborted external signal win before scheduling or fetching", async () => {
    const fetch = vi.fn(async () => new Response());
    const scheduleDeadline = vi.fn(() => 1);
    const client = new ViewerImportApiClient(new URL("http://localhost/"), {
      fetch,
      scheduleDeadline,
    });
    await expect(
      client.aiGuidanceRequest("A".repeat(43), 60_000, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduleDeadline).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes the external-abort listener registration race", async () => {
    let abortedReads = 0;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const racingSignal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads > 1;
      },
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;
    const fetch = vi.fn(async () => new Response());
    const scheduleDeadline = vi.fn(() => 1);
    const client = new ViewerImportApiClient(new URL("http://localhost/"), {
      fetch,
      scheduleDeadline,
    });
    await expect(
      client.aiGuidanceRequest("A".repeat(43), 60_000, racingSignal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(addEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(scheduleDeadline).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves declaration columns in the parsed preview contract", async () => {
    const declarationDescriptor = {
      version: "codecity.ai-context/1",
      kind: "callable",
      buildingId,
      stableId: "callable:demo",
    } as const;
    const declarationContext = {
      ...declarationDescriptor,
      name: "demo",
      constructKind: "function",
      label: "demo function",
      range: { startLine: 2, startColumn: 3, endLine: 4, endColumn: 1 },
    } as const;
    const response = { preview: {
      enabled: true,
      availability: "available",
      provider: { id: "local", label: "Local" },
      transmission: { version: 1, task: "source-guidance", providerId: "local", context: declarationContext, contextDigest, source: { path: "src/a.ts", language: "typescript", text: "function demo() {\n  return 1;\n}", lines: declarationContext.range }, findings: { sloc: 3, maximumComplexity: 1, decisionLoad: 0 } },
      limits: { timeoutMs: 20_000, maximumSourceBytes: 131_072 },
      privacy: "no-prompt-storage",
      grant: "A".repeat(43),
    } };
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch: async () => new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }) });
    const result = await client.aiGuidancePreview(
      "00000000-0000-4000-8000-000000000000",
      declarationDescriptor,
      "local",
    );
    if (result.preview.availability !== "available" || result.preview.transmission.context.kind !== "callable") throw new Error("Expected a callable preview.");
    const startColumn: number = result.preview.transmission.context.range.startColumn;
    const endColumn: number = result.preview.transmission.context.range.endColumn;
    expect({ startColumn, endColumn }).toEqual({ startColumn: 3, endColumn: 1 });
    expect(result.preview.transmission.source.lines.startColumn).toBe(startColumn);
    expect(result.preview.transmission.source.lines.endColumn).toBe(endColumn);
  });

  it.each([
    { timeoutMs: 999, maximumSourceBytes: 131_072 },
    { timeoutMs: 60_001, maximumSourceBytes: 131_072 },
    { timeoutMs: 20_000, maximumSourceBytes: 131_073 },
  ])("rejects unsafe advertised AI limits %#", async (limits) => {
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch: async () => new Response(JSON.stringify(availablePreview("export {};\n", limits)), { headers: { "content-type": "application/json" } }) });
    await expect(client.aiGuidancePreview("00000000-0000-4000-8000-000000000000", descriptor, "local")).rejects.toThrow(/AI limits are invalid/);
  });

  it("rejects source whose UTF-8 bytes exceed the advertised limit", async () => {
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch: async () => new Response(JSON.stringify(availablePreview("€€", { timeoutMs: 20_000, maximumSourceBytes: 5 })), { headers: { "content-type": "application/json" } }) });
    await expect(client.aiGuidancePreview("00000000-0000-4000-8000-000000000000", descriptor, "local")).rejects.toThrow(/exceeds its advertised limit/);
  });

  it("rejects a transmission bound to a different provider", async () => {
    const response = availablePreview() as { preview: { transmission: { providerId: string } } };
    response.preview.transmission.providerId = "remote";
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch: async () => new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }) });
    await expect(client.aiGuidancePreview("00000000-0000-4000-8000-000000000000", descriptor, "local")).rejects.toThrow(/provider does not match/);
  });

  it("rejects malformed server-reported smell evidence", async () => {
    const smellContext = {
      version: "codecity.ai-context/1",
      kind: "smell",
      buildingId,
      findingId: "smell:high-complexity-method:0123456789abcdef",
      ruleId: "high-complexity-method",
      label: "Complex callable",
      range: { startLine: 3, endLine: 3 },
      evidence: { kind: "executable-unit", label: "complexity", value: 20, threshold: 15, subject: "run", line: 3, relatedBuildingIds: [buildingId] },
    } as const;
    const response = { preview: {
      enabled: true,
      availability: "available",
      provider: { id: "local", label: "Local" },
      transmission: { version: 1, task: "source-guidance", providerId: "local", context: smellContext, contextDigest, findingDigest: "b".repeat(64), source: { path: "src/a.ts", language: "typescript", text: "run();", lines: { startLine: 3, endLine: 3 } }, findings: { sloc: 1, maximumComplexity: 20, decisionLoad: 19 } },
      limits: { timeoutMs: 20_000, maximumSourceBytes: 131_072 },
      privacy: "no-prompt-storage",
      grant: "A".repeat(43),
    } };
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch: async () => new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }) });
    await expect(client.aiGuidancePreview("00000000-0000-4000-8000-000000000000", { version: "codecity.ai-context/1", kind: "smell", buildingId, findingId: smellContext.findingId, ruleId: smellContext.ruleId }, "local")).rejects.toThrow(/executable-unit smell evidence is invalid/);
  });

  it.each([
    { version: "codecity.ai-context/1", kind: "file", buildingId },
    { version: "codecity.ai-context/1", kind: "type", buildingId, stableId: "type:demo" },
    { version: "codecity.ai-context/1", kind: "callable", buildingId, stableId: "callable:demo" },
    { version: "codecity.ai-context/1", kind: "dependency", buildingId, dependencyId: "dependency:demo" },
    { version: "codecity.ai-context/1", kind: "smell", buildingId, findingId: "smell:high-complexity-method:0123456789abcdef", ruleId: "high-complexity-method" },
  ] as const)("sends only identifiers for $kind context previews", async (selected) => {
    let body = "";
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch: async (_input, init) => {
      body = String(init.body);
      return new Response(JSON.stringify({ preview: { enabled: true, availability: "unavailable", provider: { id: "local", label: "Local" }, context: selected, reason: "No exact range.", limits: { timeoutMs: 20_000, maximumSourceBytes: 131_072 }, privacy: "no-prompt-storage" } }), { headers: { "content-type": "application/json" } });
    } });
    const result = await client.aiGuidancePreview("00000000-0000-4000-8000-000000000000", selected, "local");
    expect(result.preview.availability).toBe("unavailable");
    expect(JSON.parse(body)).toEqual(selected);
    expect(body).not.toContain("metrics");
    expect(body).not.toContain("source");
  });
});
