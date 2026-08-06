import { describe, expect, it, vi } from "vitest";

import { AiProviderDiscoveryController } from
  "../apps/viewer/src/ai-provider-discovery.js";

describe("AI provider discovery", () => {
  it("coalesces concurrent discovery and caches a successful configured response", async () => {
    let resolve!: (value: {
      enabled: true;
      providers: readonly { readonly id: string; readonly label: string }[];
    }) => void;
    const load = vi.fn(() => new Promise<{
      enabled: true;
      providers: readonly { readonly id: string; readonly label: string }[];
    }>((accept) => { resolve = accept; }));
    const controller = new AiProviderDiscoveryController(load);

    const first = controller.discover();
    const second = controller.discover();
    expect(second).toBe(first);
    expect(controller.capability.state).toBe("loading");
    resolve({
      enabled: true,
      providers: [{ id: "local", label: "Local model" }],
    });
    await expect(first).resolves.toMatchObject({
      state: "configured",
      providers: [{ id: "local", label: "Local model" }],
    });
    await controller.discover();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("caches a successful disabled response but retries transient failures", async () => {
    const disabledLoad = vi.fn(async () => ({
      enabled: false as const,
      providers: [] as const,
    }));
    const disabled = new AiProviderDiscoveryController(disabledLoad);
    await expect(disabled.discover()).resolves.toEqual({
      state: "not-configured",
    });
    await disabled.discover();
    expect(disabledLoad).toHaveBeenCalledTimes(1);

    const retryLoad = vi.fn()
      .mockRejectedValueOnce(new Error("unauthorized"))
      .mockResolvedValueOnce({
        enabled: true,
        providers: [{ id: "local", label: "Local" }],
      });
    const retry = new AiProviderDiscoveryController(retryLoad);
    await expect(retry.discover()).resolves.toEqual({
      state: "unavailable",
    });
    await expect(retry.discover()).resolves.toMatchObject({
      state: "configured",
    });
    expect(retryLoad).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached and in-flight capabilities across an auth transition", async () => {
    let resolveFirst!: (value: {
      enabled: false;
      providers: readonly [];
    }) => void;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        enabled: true,
        providers: [{ id: "after-auth", label: "After auth" }],
      });
    const controller = new AiProviderDiscoveryController(load);
    const stale = controller.discover();
    controller.invalidate();
    resolveFirst({ enabled: false, providers: [] });
    await stale;
    expect(controller.capability.state).toBe("idle");
    await expect(controller.discover()).resolves.toMatchObject({
      state: "configured",
      providers: [{ id: "after-auth" }],
    });
  });
});
