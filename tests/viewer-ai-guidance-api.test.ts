import { describe, expect, it, vi } from "vitest";

import { ViewerImportApiClient } from "../apps/viewer/src/import-api.js";

describe("viewer AI guidance API", () => {
  it("creates previews only through a CSRF-marked POST", async () => {
    let request: RequestInit | undefined;
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit) => { request = init; return new Response(JSON.stringify({ preview: {
      enabled: true,
      provider: { id: "local", label: "Local" },
      transmission: { version: 1, task: "source-guidance", source: { path: "src/a.ts", language: "typescript", text: "export {};\n", lines: { startLine: 1, endLine: 1 } }, findings: { sloc: 1, maximumComplexity: 1, decisionLoad: 0 } },
      limits: { timeoutMs: 20_000, maximumSourceBytes: 131_072 },
      privacy: "no-prompt-storage",
      grant: "A".repeat(43),
    } }), { status: 200, headers: { "content-type": "application/json" } }); });
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch });
    await client.aiGuidancePreview("00000000-0000-4000-8000-000000000000", "typescript:0123456789abcdef", "local");
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("X-Code-City-Request")).toBe("1");
    expect(request?.body).toBeUndefined();
  });

  it("rejects extra fields in AI responses", async () => {
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch: async () => new Response(JSON.stringify({ enabled: true, providers: [], extra: true }), { headers: { "content-type": "application/json" } }) });
    await expect(client.aiGuidanceProviders()).rejects.toThrow(/invalid shape/);
  });

  it("never places source text in the confirmation request", async () => {
    let request: RequestInit | undefined;
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit) => { request = init; return new Response(JSON.stringify({ result: { provider: { id: "local", label: "Local" }, suggestions: [] } }), { status: 200, headers: { "content-type": "application/json" } }); });
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch });
    await client.aiGuidanceRequest("A".repeat(43));
    const body = String(request?.body);
    expect(body).toContain('"approval":"once"');
    expect(body).not.toContain("metrics");
    expect(body).not.toContain("text");
    expect(body).not.toContain("source");
    expect(new Headers(request?.headers).get("X-Code-City-Request")).toBe("1");
  });
});
