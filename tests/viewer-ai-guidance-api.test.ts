import { describe, expect, it, vi } from "vitest";

import { ViewerImportApiClient } from "../apps/viewer/src/import-api.js";

describe("viewer AI guidance API", () => {
  it("never places source text in the confirmation request", async () => {
    let request: RequestInit | undefined;
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit) => { request = init; return new Response(JSON.stringify({ result: { provider: { id: "local", label: "Local" }, suggestions: [] } }), { status: 200, headers: { "content-type": "application/json" } }); });
    const client = new ViewerImportApiClient(new URL("http://localhost/"), { fetch });
    await client.aiGuidanceRequest("00000000-0000-4000-8000-000000000000", "typescript:0123456789abcdef");
    const body = String(request?.body);
    expect(body).toContain('"approval":"once"');
    expect(body).not.toContain("metrics");
    expect(body).not.toContain("text");
    expect(body).not.toContain("source");
  });
});
