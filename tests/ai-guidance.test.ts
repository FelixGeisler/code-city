import { describe, expect, it, vi } from "vitest";

import {
  AI_GUIDANCE_CONFIG_VERSION,
  AI_GUIDANCE_MAX_RESPONSE_BYTES,
  AiGuidanceAdapter,
} from "../apps/server/src/ai-guidance.js";
import { environmentAiGuidanceConfiguration } from "../apps/server/src/main.js";

const source = {
  jobId: "00000000-0000-4000-8000-000000000000",
  buildingId: "typescript:0123456789abcdef",
  path: "src/example.ts",
  language: "typescript",
  text: "export function example() { return 1; }\n",
  location: { startLine: 1, endLine: 1 },
} as const;
const metrics = { sloc: 1, maximumComplexity: 1, decisionLoad: 0 } as const;

describe("AiGuidanceAdapter", () => {
  it("does not call a provider while disabled", () => {
    const fetch = vi.fn();
    const adapter = new AiGuidanceAdapter({ version: AI_GUIDANCE_CONFIG_VERSION, enabled: false, providers: [] }, { fetch });
    expect(adapter.preview(source, metrics)).toMatchObject({ enabled: false, privacy: "no-prompt-storage" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("previews exactly the selected unit but only sends it after explicit request", async () => {
    let sent: RequestInit | undefined;
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit) => { sent = init; return new Response(JSON.stringify({ suggestions: [{ title: "Extract branch", detail: "The selected method has a branch." }] })); });
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local model", endpoint: "http://127.0.0.1:11434/guidance", authorization: { header: "Authorization", value: "secret" } }] }, { fetch });
    const preview = adapter.preview(source, metrics);
    expect(preview).toMatchObject({ enabled: true, provider: { id: "local", label: "Local model" }, source: { text: source.text }, metrics });
    expect(JSON.stringify(preview)).not.toContain("secret");
    expect(fetch).not.toHaveBeenCalled();
    const result = await adapter.request(source, metrics);
    expect(result.suggestions[0]).toMatchObject({ citation: { path: source.path, startLine: 1, endLine: 1 } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sent?.headers).toMatchObject({ Authorization: "secret" });
    expect(JSON.parse(String(sent?.body))).toMatchObject({ source: { text: source.text } });
  });

  it("rejects remote loopback HTTP endpoints to prevent SSRF", () => {
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "remote", label: "Remote", endpoint: "http://example.test/guidance" }] })).toThrow(/HTTPS/);
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "remote", label: "Remote", endpoint: "https://user:secret@example.test/guidance" }] })).toThrow(/credential-free/);
  });

  it("allows an HTTP endpoint on the IPv6 loopback interface", () => {
    expect(
      () =>
        new AiGuidanceAdapter({
          version: 1,
          enabled: true,
          providers: [
            {
              id: "local",
              label: "Local",
              endpoint: "http://[::1]:11434/guidance",
            },
          ],
        }),
    ).not.toThrow();
  });

  it("isolates provider failures and records metadata without a prompt", async () => {
    const audit = vi.fn();
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] }, { fetch: async () => { throw new Error("offline"); }, audit });
    await expect(adapter.request(source, metrics)).rejects.toThrow("offline");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ providerId: "local", buildingId: source.buildingId, outcome: "failed", sourceBytes: expect.any(Number) }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(source.text);
  });

  it("cancels an in-flight provider operation", async () => {
    const controller = new AbortController();
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] }, { fetch: async (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
    const pending = adapter.request(source, metrics, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled|timed out/iu);
  });

  it("does not contact a provider for an already-cancelled request", async () => {
    const fetch = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const adapter = new AiGuidanceAdapter(
      {
        version: 1,
        enabled: true,
        providers: [
          {
            id: "local",
            label: "Local",
            endpoint: "http://localhost:11434/guidance",
          },
        ],
      },
      { fetch },
    );
    await expect(
      adapter.request(source, metrics, controller.signal),
    ).rejects.toThrow(/cancelled|timed out/iu);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops reading a provider response at the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(AI_GUIDANCE_MAX_RESPONSE_BYTES + 1),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const adapter = new AiGuidanceAdapter(
      {
        version: 1,
        enabled: true,
        providers: [
          {
            id: "local",
            label: "Local",
            endpoint: "http://localhost:11434/guidance",
          },
        ],
      },
      { fetch: async () => new Response(body) },
    );
    await expect(adapter.request(source, metrics)).rejects.toThrow(
      /size limit/iu,
    );
    expect(cancelled).toBe(true);
  });
});

describe("AI guidance environment configuration", () => {
  it("resolves a credential only from the named environment variable", () => {
    expect(
      environmentAiGuidanceConfiguration(
        JSON.stringify({
          version: 1,
          enabled: true,
          providers: [
            {
              id: "review",
              label: "Review",
              endpoint: "https://ai.example.test/guidance",
              authorizationEnv: "GUIDANCE_TOKEN",
            },
          ],
        }),
        { GUIDANCE_TOKEN: "secret" },
      ),
    ).toMatchObject({
      enabled: true,
      providers: [
        {
          authorization: {
            header: "Authorization",
            value: "secret",
          },
        },
      ],
    });
  });

  it("rejects an authorization header without a credential reference", () => {
    expect(() =>
      environmentAiGuidanceConfiguration(
        JSON.stringify({
          version: 1,
          enabled: true,
          providers: [
            {
              id: "review",
              label: "Review",
              endpoint: "https://ai.example.test/guidance",
              authorizationHeader: "X-Api-Key",
            },
          ],
        }),
        {},
      ),
    ).toThrow(/authorizationEnv/u);
  });

  it("allows global disablement without loading provider credentials", () => {
    expect(
      environmentAiGuidanceConfiguration(
        JSON.stringify({
          version: 1,
          enabled: false,
          providers: [
            {
              id: "review",
              label: "Review",
              endpoint: "https://ai.example.test/guidance",
              authorizationEnv: "MISSING_TOKEN",
            },
          ],
        }),
        {},
      ),
    ).toMatchObject({ enabled: false });
  });
});
