import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveProductionViewerRoot,
  startLocalOpenServer,
  type LocalOpenServerHandle,
} from "../apps/cli/src/open-server.js";
import { validateCityModel } from "../packages/core/src/index.js";

interface LocalResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

interface LocalRequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawPath?: string;
}

const temporaryDirectories: string[] = [];
const openServers: LocalOpenServerHandle[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeFixture(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const destination = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, "utf8");
}

async function fixture(): Promise<{
  readonly repositoryRoot: string;
  readonly viewerRoot: string;
  readonly outsideSecret: string;
}> {
  const root = await temporaryDirectory("code-city-open-");
  const repositoryRoot = path.join(root, "repository");
  const viewerRoot = path.join(root, "viewer");
  const outsideSecret = path.join(root, "outside-secret.txt");
  await writeFixture(
    repositoryRoot,
    "main.ts",
    "export function choose(value: boolean) { return value ? 1 : 0; }\n",
  );
  await writeFixture(
    viewerRoot,
    "index.html",
    '<!doctype html><title>Offline viewer</title><script type="module" src="/assets/app.js"></script>',
  );
  await writeFixture(
    viewerRoot,
    "assets/app.js",
    'document.title = "Code City";\n',
  );
  await writeFixture(viewerRoot, "assets/unknown.fixture", "not served");
  await fs.writeFile(outsideSecret, "must remain private", "utf8");
  return { repositoryRoot, viewerRoot, outsideSecret };
}

function localRequest(
  url: URL,
  options: LocalRequestOptions = {},
): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        method: options.method ?? "GET",
        path: options.rawPath ?? `${url.pathname}${url.search}`,
        headers: options.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.setTimeout(2_000, () => {
      request.destroy(new Error("Local open-server request timed out."));
    });
    request.on("error", reject);
    request.end();
  });
}

function expectSecurityHeaders(
  response: LocalResponse,
  cacheControl?: string,
): void {
  expect(response.headers["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  if (cacheControl !== undefined) {
    expect(response.headers["cache-control"]).toBe(cacheControl);
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  milliseconds = 2_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Server lifecycle did not settle.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.allSettled(openServers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("bounded local codecity open server", () => {
  it("maps the compiled CLI module to the production viewer output", () => {
    const compiledModule = pathToFileURL(
      path.resolve(
        "build",
        "app",
        "apps",
        "cli",
        "src",
        "open-server.js",
      ),
    );
    expect(resolveProductionViewerRoot(compiledModule)).toBe(
      path.resolve("build", "viewer"),
    );
  });

  it("analyzes a repository in memory and serves a validated model offline", async () => {
    const roots = await fixture();
    const network = vi.fn(async () => {
      throw new Error("External networking is disabled.");
    });
    vi.stubGlobal("fetch", network);

    const server = await startLocalOpenServer({
      roots: [roots.repositoryRoot],
      viewerRoot: roots.viewerRoot,
    });
    openServers.push(server);

    expect(server.url.protocol).toBe("http:");
    expect(server.url.hostname).toBe("127.0.0.1");
    expect(Number(server.url.port)).toBeGreaterThan(0);
    expect(server.url.searchParams.get("model")).not.toBeNull();
    expect(server.modelUrl.origin).toBe(server.url.origin);

    const viewer = await localRequest(server.url);
    expect(viewer.status).toBe(200);
    expect(viewer.headers["content-type"]).toMatch(/^text\/html\b/u);
    expect(viewer.body.toString("utf8")).toContain("Offline viewer");
    expectSecurityHeaders(viewer);

    const modelResponse = await localRequest(server.modelUrl);
    expect(modelResponse.status).toBe(200);
    expect(modelResponse.headers["content-type"]).toMatch(
      /^application\/json\b/u,
    );
    expectSecurityHeaders(modelResponse, "no-store");
    const model = validateCityModel(
      JSON.parse(modelResponse.body.toString("utf8")) as unknown,
    );
    expect(model.repositories).toHaveLength(1);
    expect(model.buildings.map(({ path: sourcePath }) => sourcePath)).toEqual([
      "main.ts",
    ]);
    expect(network).not.toHaveBeenCalled();
  });

  it("serves only known viewer MIME types and rejects traversal", async () => {
    const roots = await fixture();
    const server = await startLocalOpenServer({
      roots: [roots.repositoryRoot],
      viewerRoot: roots.viewerRoot,
      port: 0,
    });
    openServers.push(server);

    const script = await localRequest(
      new URL("/assets/app.js", server.url),
    );
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toMatch(
      /^(?:application|text)\/javascript\b/u,
    );
    expectSecurityHeaders(script);

    const unknown = await localRequest(
      new URL("/assets/unknown.fixture", server.url),
    );
    expect(unknown.status).toBe(415);
    expect(unknown.body.toString("utf8")).not.toContain("not served");

    for (const rawPath of [
      "/..%2foutside-secret.txt",
      "/%2e%2e%5coutside-secret.txt",
      "/assets/%2e%2e/%2e%2e/outside-secret.txt",
    ]) {
      const traversed = await localRequest(server.url, { rawPath });
      expect([400, 404]).toContain(traversed.status);
      expect(traversed.body.toString("utf8")).not.toContain(
        "must remain private",
      );
    }
  });

  it("rejects invalid hosts and unsupported methods without CORS", async () => {
    const roots = await fixture();
    const server = await startLocalOpenServer({
      roots: [roots.repositoryRoot],
      viewerRoot: roots.viewerRoot,
    });
    openServers.push(server);

    const invalidHost = await localRequest(server.url, {
      headers: { Host: `localhost:${server.url.port}` },
    });
    expect(invalidHost.status).toBe(400);
    expectSecurityHeaders(invalidHost);

    const unsupported = await localRequest(server.url, {
      method: "POST",
    });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.allow).toMatch(/\bGET\b/u);
    expectSecurityHeaders(unsupported);
  });

  it("fails before listening when production viewer assets are absent", async () => {
    const root = await temporaryDirectory("code-city-open-missing-");
    const repositoryRoot = path.join(root, "repository");
    const viewerRoot = path.join(root, "missing-viewer");
    await writeFixture(repositoryRoot, "main.ts", "export const value = 1;\n");

    await expect(
      startLocalOpenServer({
        roots: [repositoryRoot],
        viewerRoot,
      }),
    ).rejects.toThrow(/npm run viewer:build/u);
  });

  it("closes promptly on injected abort and explicit idempotent close", async () => {
    const roots = await fixture();
    const controller = new AbortController();
    const aborted = await startLocalOpenServer({
      roots: [roots.repositoryRoot],
      viewerRoot: roots.viewerRoot,
      signal: controller.signal,
    });
    openServers.push(aborted);
    controller.abort();
    await settleWithin(aborted.closed);

    const explicitlyClosed = await startLocalOpenServer({
      roots: [roots.repositoryRoot],
      viewerRoot: roots.viewerRoot,
    });
    openServers.push(explicitlyClosed);
    await settleWithin(explicitlyClosed.close());
    await settleWithin(explicitlyClosed.close());
    await settleWithin(explicitlyClosed.closed);
  });

  it(
    "rolls back startup when a captured process signal handler runs",
    { timeout: 3_000 },
    async () => {
      const roots = await fixture();
      const sigintListeners = process.listenerCount("SIGINT");
      const sigtermListeners = process.listenerCount("SIGTERM");
      const originalOnce = process.once;
      let injected = false;
      vi.spyOn(process, "once").mockImplementation(
        ((eventName: string | symbol, listener: () => void) => {
          const result = Reflect.apply(originalOnce, process, [
            eventName,
            listener,
          ]) as NodeJS.Process;
          if (eventName === "SIGTERM" && !injected) {
            injected = true;
            queueMicrotask(listener);
          }
          return result;
        }) as typeof process.once,
      );

      const startup = startLocalOpenServer({
        roots: [roots.repositoryRoot],
        viewerRoot: roots.viewerRoot,
      }).then((server) => {
        openServers.push(server);
        return server;
      });
      await expect(settleWithin(startup)).rejects.toThrow(
        /startup was aborted/iu,
      );
      expect(injected).toBe(true);
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    },
  );

  it(
    "rolls back lifecycle listeners after a bind failure",
    { timeout: 4_000 },
    async () => {
      const roots = await fixture();
      const blocker = await startLocalOpenServer({
        roots: [roots.repositoryRoot],
        viewerRoot: roots.viewerRoot,
      });
      openServers.push(blocker);
      const sigintListeners = process.listenerCount("SIGINT");
      const sigtermListeners = process.listenerCount("SIGTERM");

      const startup = startLocalOpenServer({
        roots: [roots.repositoryRoot],
        viewerRoot: roots.viewerRoot,
        port: Number(blocker.url.port),
      }).then((server) => {
        openServers.push(server);
        return server;
      });
      await expect(settleWithin(startup, 3_000)).rejects.toThrow(
        /could not bind/iu,
      );
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    },
  );
});
