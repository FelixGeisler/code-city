import { describe, expect, it, vi } from "vitest";
import type { API } from "typescript/unstable/async";

import { TypeScriptWorkspace } from "../packages/analyzer/src/typescript-workspace.js";

const root = "/code-city/example";
const execution = { timeoutMs: 30_000 } as const;

describe("TypeScript 7 native workspace", () => {
  it("uses admitted config aliases without exposing unadmitted files", async () => {
    await using workspace = await TypeScriptWorkspace.create(
      [
        {
          path: `${root}/tsconfig.json`,
          text: JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: { "@target": ["target.ts"] },
            },
          }),
        },
        {
          path: `${root}/main.ts`,
          text: 'import { target } from "@target";',
        },
        {
          path: `${root}/target.ts`,
          text: "export const target = true;",
        },
      ],
      execution,
    );

    expect((await workspace.sourceFile(`${root}/main.ts`))?.text).toContain(
      'from "@target"',
    );
    expect(await workspace.resolveImport(`${root}/main.ts`, "@target")).toBe(
      `${root}/target.ts`,
    );
    expect(
      await workspace.sourceFile(`${root}/not-admitted.ts`),
    ).toBeUndefined();
  });

  it("reports syntax failures and closes its native session deterministically", async () => {
    const workspace = await TypeScriptWorkspace.create(
      [{ path: `${root}/broken.ts`, text: "export const = ;" }],
      execution,
    );

    expect(await workspace.hasSyntacticErrors(`${root}/broken.ts`)).toBe(true);
    await workspace.dispose();
    await workspace.dispose();
    await expect(workspace.sourceFile(`${root}/broken.ts`)).rejects.toThrow(
      "TypeScript workspace has been disposed.",
    );
  });

  it("honors caller cancellation before starting the native process", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));

    await expect(
      TypeScriptWorkspace.create(
        [{ path: `${root}/source.ts`, text: "export {};" }],
        { timeoutMs: 30_000, signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled by test");
  });

  it("kills and closes a stalled native process at the hard deadline", async () => {
    const kill = vi.fn(() => true);
    const close = vi.fn(async () => undefined);
    const api = {
      client: { process: { exitCode: null, kill } },
      updateSnapshot: () => new Promise(() => undefined),
      close,
    } as unknown as API;

    await expect(
      TypeScriptWorkspace.create(
        [{ path: `${root}/source.ts`, text: "export {};" }],
        { timeoutMs: 10, nativeApiFactory: () => api },
      ),
    ).rejects.toThrow("exceeded its deadline");
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(close).toHaveBeenCalled();
  });

  it("preserves the deadline when closing the killed transport rejects", async () => {
    const kill = vi.fn(() => true);
    const close = vi.fn(async () => {
      throw new Error("Cannot call write after a stream was destroyed");
    });
    const api = {
      client: { process: { exitCode: null, kill } },
      updateSnapshot: () => new Promise(() => undefined),
      close,
    } as unknown as API;

    await expect(
      TypeScriptWorkspace.create(
        [{ path: `${root}/source.ts`, text: "export {};" }],
        { timeoutMs: 10, nativeApiFactory: () => api },
      ),
    ).rejects.toThrow("exceeded its deadline");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the native API after initialization crashes", async () => {
    const close = vi.fn(async () => undefined);
    const api = {
      updateSnapshot: async () => {
        throw new Error("native crash");
      },
      close,
    } as unknown as API;

    await expect(
      TypeScriptWorkspace.create(
        [{ path: `${root}/source.ts`, text: "export {};" }],
        { timeoutMs: 30_000, nativeApiFactory: () => api },
      ),
    ).rejects.toThrow("native crash");
    expect(close).toHaveBeenCalledOnce();
  });
});
