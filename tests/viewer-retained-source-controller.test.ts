import { describe, expect, it, vi } from "vitest";

import { RetainedSourceController } from "../apps/viewer/src/retained-source-controller.js";
import type { BuildingSource } from "../apps/viewer/src/source-navigation.js";

const source = (path: string): BuildingSource => ({
  buildingId: "building",
  repositoryId: "repository",
  path,
  text: "source",
  language: "typescript",
  location: { startLine: 1, endLine: 1 },
  provenance: {
    repositoryId: "repository",
    provider: "github",
    revision: { kind: "commit", value: "a".repeat(40) },
  },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("RetainedSourceController", () => {
  it("retains only the current selected-building response", async () => {
    const controller = new RetainedSourceController();
    const first = deferred<BuildingSource>();
    const second = deferred<BuildingSource>();
    const loaded = vi.fn();
    const failed = vi.fn();

    controller.load("first", () => first.promise, () => true, { loaded, failed });
    controller.load("second", () => second.promise, () => true, { loaded, failed });
    first.resolve(source("first.ts"));
    second.resolve(source("second.ts"));
    await Promise.all([first.promise, second.promise]);

    expect(loaded).toHaveBeenCalledOnce();
    expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ path: "second.ts" }));
    expect(controller.sourceFor("first")).toBeUndefined();
    expect(controller.sourceFor("second")?.path).toBe("second.ts");
    expect(failed).not.toHaveBeenCalled();
  });

  it("cancels requests on clear and ignores stale failures", async () => {
    const controller = new RetainedSourceController();
    const request = deferred<BuildingSource>();
    const failed = vi.fn();
    let signal: AbortSignal | undefined;
    controller.load("building", (value) => {
      signal = value;
      return request.promise;
    }, () => true, { loaded: vi.fn(), failed });

    controller.clear();
    request.reject(new Error("stale"));
    await request.promise.catch(() => undefined);

    expect(signal?.aborted).toBe(true);
    expect(failed).not.toHaveBeenCalled();
  });
});
