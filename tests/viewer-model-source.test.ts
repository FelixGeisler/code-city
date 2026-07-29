import { describe, expect, it } from "vitest";

import {
  AutomaticModelLoadGate,
  assetRootFromResponseUrl,
  remoteViewerDisplayUrl,
  resolveAssetUrl,
  sortLegendGroups,
  VIEWER_LOAD_DEADLINE_MS,
  VIEWER_LOGO_MAX_BYTES,
  VIEWER_MODEL_MAX_BYTES,
  VIEWER_PROFILE_MAX_BYTES,
  ViewerLoadGateway,
} from "../apps/viewer/src/model-source.js";
import type { SemanticGroup } from "../packages/core/src/model.js";

describe("viewer model sources", () => {
  it("aborts and invalidates superseded automatic loads", () => {
    const gate = new AutomaticModelLoadGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);

    gate.invalidate();
    expect(second.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(false);
  });

  it("derives the asset root from the final response URL", () => {
    const root = assetRootFromResponseUrl(
      "https://cdn.example.test/releases/v1/city.json",
    );

    expect(root.href).toBe("https://cdn.example.test/releases/v1/");
    expect(resolveAssetUrl("assets/logo.svg", root).href).toBe(
      "https://cdn.example.test/releases/v1/assets/logo.svg",
    );
  });

  it("uses explicit stable byte and deadline limits", () => {
    expect(VIEWER_MODEL_MAX_BYTES).toBe(128 * 1024 * 1024);
    expect(VIEWER_PROFILE_MAX_BYTES).toBe(1024 * 1024);
    expect(VIEWER_LOGO_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(VIEWER_LOAD_DEADLINE_MS).toBe(30_000);
  });

  it("loads a remote model without credentials, redirects, or a referrer", async () => {
    const calls: Array<{
      readonly input: string | URL;
      readonly init: RequestInit;
    }> = [];
    const gateway = new ViewerLoadGateway({
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response('{"schemaVersion":"1.0"}', {
          status: 200,
          headers: {
            "content-length": "23",
            "content-type": "application/json",
          },
        });
      },
    });
    const requested = new URL("https://example.test/cities/demo.json");

    const loaded = await gateway.loadRemoteModel(requested);

    expect(loaded.model).toEqual({ schemaVersion: "1.0" });
    expect(loaded.responseUrl.href).toBe(requested.href);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.toString()).toBe(requested.href);
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "cors",
    });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects credential-bearing URLs and remote redirects", async () => {
    let fetchCount = 0;
    const credentialGateway = new ViewerLoadGateway({
      fetch: async () => {
        fetchCount += 1;
        return new Response("{}");
      },
    });
    await expect(
      credentialGateway.loadRemoteModel(
        new URL("https://user:secret@example.test/city.json"),
      ),
    ).rejects.toThrow(/credentials/u);
    expect(fetchCount).toBe(0);

    const redirected = new Response("{}", { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    const redirectGateway = new ViewerLoadGateway({
      fetch: async () => redirected,
    });
    await expect(
      redirectGateway.loadRemoteModel(
        new URL("https://example.test/city.json"),
      ),
    ).rejects.toThrow(/redirects are not allowed/u);
  });

  it("enforces local and remote byte caps before parsing", async () => {
    const gateway = new ViewerLoadGateway();
    await expect(
      gateway.loadLocalJson(
        new Blob([new Uint8Array(VIEWER_PROFILE_MAX_BYTES + 1)]),
        "profile",
      ),
    ).rejects.toThrow(/1,048,576-byte viewer limit/u);

    const remoteGateway = new ViewerLoadGateway({
      fetch: async () =>
        new Response(null, {
          status: 200,
          headers: {
            "content-length": String(VIEWER_LOGO_MAX_BYTES + 1),
          },
        }),
    });
    await expect(
      remoteGateway.loadRemoteLogo(
        new URL("https://example.test/logo.svg"),
        "svg",
      ),
    ).rejects.toThrow(/2,097,152-byte viewer limit/u);
  });

  it("exposes remote images only through revocable Blob URLs", async () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const gateway = new ViewerLoadGateway({
      fetch: async () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
          status: 200,
        }),
      createObjectUrl: (blob) => {
        created.push(blob);
        return "blob:code-city-logo";
      },
      revokeObjectUrl: (url) => {
        revoked.push(url);
      },
    });

    const image = await gateway.loadRemoteLogo(
      new URL("https://example.test/logo.svg"),
      "svg",
    );

    expect(image.objectUrl).toBe("blob:code-city-logo");
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("image/svg+xml");
    image.dispose();
    image.dispose();
    expect(revoked).toEqual(["blob:code-city-logo"]);
  });

  it("aborts a stalled load at its deadline and always clears the timer", async () => {
    let expire: (() => void) | undefined;
    const cleared: unknown[] = [];
    const gateway = new ViewerLoadGateway({
      deadlineMs: 25,
      fetch: async () =>
        await new Promise<Response>(() => {
          // Intentionally unresolved: the gateway deadline must win.
        }),
      scheduleDeadline: (callback) => {
        expire = callback;
        return "viewer-deadline";
      },
      clearDeadline: (handle) => {
        cleared.push(handle);
      },
    });

    const load = gateway.loadRemoteModel(
      new URL("https://example.test/stalled.json"),
    );
    const rejection = expect(load).rejects.toThrow(
      /25 ms viewer deadline/u,
    );
    expire?.();
    await rejection;
    expect(cleared).toEqual(["viewer-deadline"]);
  });

  it.each([
    "../logo.svg",
    "%2e%2e/logo.svg",
    "assets%2flogo.svg",
  ])("does not resolve an unsafe asset reference %s", (relativePath) => {
    expect(() =>
      resolveAssetUrl(
        relativePath,
        new URL("https://example.test/models/"),
      ),
    ).toThrow(/root|traversal|normalized/u);
  });

  it("rejects credentials in response and asset-root URLs", () => {
    expect(() =>
      assetRootFromResponseUrl(
        "https://user:secret@example.test/models/city.json",
      ),
    ).toThrow(/credentials/u);
    expect(() =>
      resolveAssetUrl(
        "assets/logo.svg",
        new URL("https://user:secret@example.test/models/"),
      ),
    ).toThrow(/credential-free/u);
  });

  it("removes signed query data and fragments from remote display labels", () => {
    expect(
      remoteViewerDisplayUrl(
        new URL(
          "https://example.test/models/city.json?token=secret#selection",
        ),
      ),
    ).toBe("https://example.test/models/city.json");
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/pixel.png" /></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" />',
  ])("rejects active or network-capable SVG logos", async (svg) => {
    let objectUrlCount = 0;
    const gateway = new ViewerLoadGateway({
      fetch: async () => new Response(svg, { status: 200 }),
      createObjectUrl: () => {
        objectUrlCount += 1;
        return "blob:unsafe";
      },
    });

    await expect(
      gateway.loadRemoteLogo(
        new URL("https://example.test/logo.svg"),
        "svg",
      ),
    ).rejects.toThrow(/executable or external content/u);
    expect(objectUrlCount).toBe(0);
  });

  it("sorts equal legend labels deterministically by id", () => {
    const groups: SemanticGroup[] = [
      { id: "b", label: "Same", color: "#000", priority: 1 },
      { id: "a", label: "Same", color: "#111", priority: 1 },
      { id: "high", label: "Later", color: "#222", priority: 2 },
    ];

    expect(sortLegendGroups(groups).map(({ id }) => id)).toEqual([
      "high",
      "a",
      "b",
    ]);
  });
});
