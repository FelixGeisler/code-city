import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const viewerRoot = path.resolve("apps/viewer");

describe("viewer security boundary", () => {
  it("ships restrictive CSP and referrer policies for bundled assets", async () => {
    const html = await fs.readFile(
      path.join(viewerRoot, "index.html"),
      "utf8",
    );

    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("img-src 'self' blob:");
    expect(html).toContain("worker-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).not.toMatch(
      /<(?:script|img|link)\b[^>]+(?:src|href)=["']https?:/iu,
    );
  });

  it("keeps network primitives inside the three explicit load gateways", async () => {
    const sourceDirectory = path.join(viewerRoot, "src");
    const sourceNames = (await fs.readdir(sourceDirectory))
      .filter((name) => name.endsWith(".ts"));
    const networkPattern =
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/u;
    const gateways = new Set([
      "import-api.ts",
      "model-source.ts",
      "published-cities-api.ts",
    ]);

    for (const name of sourceNames) {
      const source = await fs.readFile(
        path.join(sourceDirectory, name),
        "utf8",
      );
      if (gateways.has(name)) {
        expect(source).toContain("globalThis.fetch");
      } else {
        expect(source, name).not.toMatch(networkPattern);
      }
    }
  });

  it("emits icons as CSP-compatible same-origin assets", async () => {
    const config = await fs.readFile(
      path.join(viewerRoot, "vite.config.ts"),
      "utf8",
    );
    expect(config).toContain("assetsInlineLimit: 0");
  });
});
