import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import {
  AI_GUIDANCE_CONFIG_VERSION,
  AiGuidanceAdapter,
  AI_GUIDANCE_MAX_PROVIDERS,
  AI_GUIDANCE_MAX_RESPONSE_BYTES,
} from "../apps/server/src/ai-guidance.js";
import { sourceTextLineRange } from "../apps/server/src/source-artifact.js";
import {
  environmentAiGuidanceAudit,
  environmentAiGuidanceConfiguration,
} from "../apps/server/src/main.js";

const source = {
  jobId: "00000000-0000-4000-8000-000000000000",
  buildingId: "typescript:0123456789abcdef",
  path: "src/example.ts",
  language: "typescript",
  text: "export function example() { return 1; }\n",
  location: { startLine: 1, endLine: 1 },
} as const;
const metrics = { sloc: 1, maximumComplexity: 1, decisionLoad: 0 } as const;
const providerJson = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

describe("AiGuidanceAdapter", () => {
  it("does not call a provider while disabled", () => {
    const fetch = vi.fn();
    const adapter = new AiGuidanceAdapter({ version: AI_GUIDANCE_CONFIG_VERSION, enabled: false, providers: [] }, { fetch });
    expect(adapter.preview(source, metrics, "local")).toMatchObject({ enabled: false, privacy: "no-prompt-storage" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("previews exactly the selected unit but only sends it after explicit request", async () => {
    let sent: RequestInit | undefined;
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit) => { sent = init; return providerJson({ suggestions: [{ title: "Extract branch", detail: "The selected method has a branch." }] }); });
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local model", endpoint: "http://127.0.0.1:11434/guidance", authorization: { header: "Authorization", value: "secret" } }] }, { fetch });
    const preview = adapter.preview(source, metrics, "local");
    expect(preview).toMatchObject({ enabled: true, provider: { id: "local", label: "Local model" }, transmission: { source: { text: source.text }, findings: metrics } });
    expect(JSON.stringify(preview)).not.toContain("secret");
    expect(fetch).not.toHaveBeenCalled();
    const result = await adapter.request(source, metrics, "local");
    expect(result.suggestions[0]).toMatchObject({ citation: { path: source.path, startLine: 1, endLine: 1 } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sent?.headers).toMatchObject({ authorization: "secret" });
    expect(JSON.parse(String(sent?.body))).toMatchObject({ source: { text: source.text } });
  });

  it("rejects remote loopback HTTP endpoints to prevent SSRF", () => {
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "remote", label: "Remote", endpoint: "http://example.test/guidance" }] })).toThrow(/HTTP/);
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "remote", label: "Remote", endpoint: "https://user:secret@example.test/guidance" }] })).toThrow(/credential-free/);
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "metadata", label: "Metadata", endpoint: "https://169.254.169.254/guidance" }] })).toThrow(/private|link-local|loopback|special/);
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "private", label: "Private", endpoint: "https://[fd00::1]/guidance" }] })).toThrow(/private|link-local|loopback|special/);
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "mapped", label: "Mapped", endpoint: "https://[::ffff:7f00:1]/guidance" }] })).toThrow(/private|link-local|loopback|special/);
  });

  it("rejects private DNS answers before a provider transport can run", async () => {
    const fetch = vi.fn();
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "remote", label: "Remote", endpoint: "https://ai.example.test/guidance" }] }, { fetch, resolve: async () => ["10.1.2.3"] });
    await expect(adapter.request(source, metrics, "remote")).rejects.toThrow(/unsafe address/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "64:ff9b:1::a00:1",
    "::ffff:0:a00:1",
    "100::1",
    "2001:db8::1",
    "2002:a00:1::",
  ])("rejects special or IPv4-transition DNS answer %s", async (address) => {
    const fetch = vi.fn();
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "remote", label: "Remote", endpoint: "https://ai.example.test/guidance" }] }, { fetch, resolve: async () => [address] });
    await expect(adapter.request(source, metrics, "remote")).rejects.toThrow(/unsafe address/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("settles promptly when cancellation occurs during DNS resolution", async () => {
    const controller = new AbortController();
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "remote", label: "Remote", endpoint: "https://ai.example.test/guidance" }] }, { resolve: async () => new Promise<readonly string[]>(() => undefined) });
    const pending = adapter.request(source, metrics, "remote", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled|timed out/iu);
  });

  it("does not start a provider request for an already-aborted signal", async () => {
    const fetch = vi.fn();
    const audit = vi.fn();
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] }, { fetch, audit });
    await expect(adapter.request(source, metrics, "local", AbortSignal.abort())).rejects.toThrow(/cancelled/);
    expect(fetch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "cancelled" }));
  });

  it("stops a streamed provider response at the byte limit", async () => {
    const encoder = new TextEncoder();
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("x".repeat(AI_GUIDANCE_MAX_RESPONSE_BYTES + 1))); } }), { headers: { "content-type": "application/json" } }));
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] }, { fetch });
    await expect(adapter.request(source, metrics, "local")).rejects.toThrow(/size limit/);
  });

  it("requires an exact JSON provider response", async () => {
    const wrongType = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] }, { fetch: async () => new Response('{"suggestions":[]}') });
    await expect(wrongType.request(source, metrics, "local")).rejects.toThrow(/content type/);
    const extraRoot = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] }, { fetch: async () => providerJson({ suggestions: [], metadata: "not allowed" }) });
    await expect(extraRoot.request(source, metrics, "local")).rejects.toThrow(/invalid response/);
  });

  it("keeps guidance successful when an audit sink throws and selects the requested provider", async () => {
    const fetch = vi.fn(async () => providerJson({ suggestions: [] }));
    const audit = vi.fn(() => { throw new Error("audit unavailable"); });
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [
      { id: "first", label: "First", endpoint: "http://localhost:11434/guidance" },
      { id: "second", label: "Second", endpoint: "http://localhost:11435/guidance" },
    ] }, { fetch, audit });
    await expect(adapter.request(source, metrics, "second")).resolves.toMatchObject({ provider: { id: "second" } });
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ port: "11435" }), expect.any(Object));
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("isolates provider failures and records metadata without a prompt", async () => {
    const audit = vi.fn();
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] }, { fetch: async () => { throw new Error("offline"); }, audit });
    await expect(adapter.request(source, metrics, "local")).rejects.toThrow("offline");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ providerId: "local", buildingId: source.buildingId, outcome: "failed", sourceBytes: expect.any(Number) }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(source.text);
  });

  it("cancels an in-flight provider operation", async () => {
    const controller = new AbortController();
    const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: "http://localhost:11434/guidance" }] }, { fetch: async (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
    const pending = adapter.request(source, metrics, "local", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled|timed out/iu);
  });

  it("uses the real pinned localhost transport and never follows redirects", async () => {
    let requests = 0;
    let host = "";
    let body = "";
    let announceStallClosed!: () => void;
    const stallClosed = new Promise<void>((resolve) => { announceStallClosed = resolve; });
    let announceErrorStallClosed!: () => void;
    const errorStallClosed = new Promise<void>((resolve) => { announceErrorStallClosed = resolve; });
    const provider = http.createServer((request, response) => {
      requests += 1;
      host = request.headers.host ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        body = Buffer.concat(chunks).toString("utf8");
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/guidance" });
          response.end();
          return;
        }
        if (request.url === "/stall") {
          response.writeHead(200, { "content-type": "application/json" });
          response.flushHeaders();
          response.once("close", announceStallClosed);
          return;
        }
        if (request.url === "/error-stall") {
          response.writeHead(503, { "content-type": "application/json" });
          response.flushHeaders();
          response.once("close", announceErrorStallClosed);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"suggestions":[]}');
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as AddressInfo).port;
    try {
      const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: `http://localhost:${port}/guidance` }] });
      await expect(adapter.request(source, metrics, "local")).resolves.toMatchObject({ suggestions: [] });
      expect(host).toBe(`localhost:${port}`);
      expect(JSON.parse(body)).toEqual(adapter.preview(source, metrics, "local").transmission);
      const redirecting = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: `http://localhost:${port}/redirect` }] });
      await expect(redirecting.request(source, metrics, "local")).rejects.toThrow(/did not complete/);
      expect(requests).toBe(2);
      const stalled = new AiGuidanceAdapter({ version: 1, enabled: true, timeoutMs: 1_000, providers: [{ id: "local", label: "Local", endpoint: `http://localhost:${port}/stall` }] });
      await expect(stalled.request(source, metrics, "local")).rejects.toThrow(/timed out/);
      await stallClosed;
      expect(requests).toBe(3);
      const stalledError = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "local", label: "Local", endpoint: `http://localhost:${port}/error-stall` }] });
      await expect(stalledError.request(source, metrics, "local")).rejects.toThrow(/did not complete/);
      await errorStallClosed;
      expect(requests).toBe(4);
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it("pins HTTPS to the validated DNS answer while preserving Host and TLS SNI", async () => {
    let captured: https.RequestOptions | undefined;
    const request = vi.spyOn(https, "request").mockImplementation(((options: https.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
      captured = options;
      const outgoing = new EventEmitter() as EventEmitter & {
        end(body?: string): void;
        destroy(error?: Error): void;
      };
      outgoing.destroy = (error?: Error) => {
        if (error !== undefined) outgoing.emit("error", error);
      };
      outgoing.end = () => {
        const incoming = Readable.from([Buffer.from('{"suggestions":[]}', "utf8")]) as http.IncomingMessage;
        incoming.statusCode = 200;
        incoming.headers = { "content-type": "application/json" };
        callback(incoming);
      };
      return outgoing;
    }) as typeof https.request);
    try {
      const adapter = new AiGuidanceAdapter({ version: 1, enabled: true, providers: [{ id: "remote", label: "Remote", endpoint: "https://ai.example.test/guidance" }] }, { resolve: async () => ["8.8.8.8"] });
      await expect(adapter.request(source, metrics, "remote")).resolves.toMatchObject({ suggestions: [] });
      expect(captured?.hostname).toBe("8.8.8.8");
      expect(captured?.servername).toBe("ai.example.test");
      expect((captured?.headers as Record<string, string>)["host"]).toBe("ai.example.test");
      expect(captured?.checkServerIdentity).toEqual(expect.any(Function));
    } finally {
      request.mockRestore();
    }
  });
});

describe("sourceTextLineRange", () => {
  it.each([
    ["LF", "one\ntwo\nthree\n", "two\n"],
    ["CRLF", "one\r\ntwo\r\nthree\r\n", "two\r\n"],
    ["CR", "one\rtwo\rthree\r", "two\r"],
  ])("extracts the same exact range for %s newlines", (_name, text, expected) => {
    expect(sourceTextLineRange(text, 2, 2)).toBe(expected);
  });
});

describe("AI guidance production configuration", () => {
  it("accepts exactly 64 providers and rejects 65 in both configuration entry points", () => {
    const providers = Array.from({ length: AI_GUIDANCE_MAX_PROVIDERS + 1 }, (_value, index) => ({
      id: `provider-${index}`,
      label: `Provider ${index}`,
      endpoint: "http://localhost:11434/guidance",
    }));
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers: providers.slice(0, AI_GUIDANCE_MAX_PROVIDERS) })).not.toThrow();
    expect(() => new AiGuidanceAdapter({ version: 1, enabled: true, providers })).toThrow(/at most 64/);
    expect(() => environmentAiGuidanceConfiguration(JSON.stringify({ version: 1, enabled: true, providers }))).toThrow(/at most 64/);
  });

  it("rejects an authorization header without a credential reference", () => {
    expect(() => environmentAiGuidanceConfiguration(JSON.stringify({
      version: 1,
      enabled: true,
      providers: [{ id: "remote", label: "Remote", endpoint: "https://example.test/guidance", authorizationHeader: "Authorization" }],
    }))).toThrow(/requires authorizationEnv/);
  });

  it("isolates a failed synchronous audit descriptor write", () => {
    const sink = environmentAiGuidanceAudit("stderr", (() => {
      throw new Error("broken pipe");
    }) as never)!;
    expect(() => sink({ providerId: "local", buildingId: "typescript:0123456789abcdef", outcome: "completed", sourceBytes: 12, durationMs: 3 })).not.toThrow();
  });
});
