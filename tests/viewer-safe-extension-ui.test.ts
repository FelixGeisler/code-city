import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
describe("safe extension viewer flow", () => {
  it("provides labelled import, worker preview, diagnostics, and export controls", async () => { const html = await readFile(path.resolve("apps/viewer/index.html"), "utf8"); expect(html).toContain('id="safe-extension-panel"'); expect(html).toContain('id="safe-extension-json"'); expect(html).toContain('aria-describedby="safe-extension-diagnostics"'); expect(html).toContain('id="safe-extension-preview"'); expect(html).toContain('id="safe-extension-export"'); });
});
