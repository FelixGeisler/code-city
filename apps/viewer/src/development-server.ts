import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createServer as createViteServer, type ViteDevServer } from "vite";

import {
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../../server/src/server.js";
import { provisionWindowsDevelopmentWorkspace } from "./windows-development-workspace.js";

export interface ViewerDevelopmentServerOptions {
  readonly dataDirectory?: string;
  readonly viewerRoot?: string;
  readonly host?: string;
  readonly port?: number;
  readonly apiPort?: number;
  readonly trustWindowsGitWorkspace?: boolean;
  readonly log?: (message: string) => void;
}

export interface ViewerDevelopmentServerHandle {
  readonly url: URL;
  readonly apiUrl: URL;
  close(): Promise<void>;
}

function listeningUrl(server: ViteDevServer, host: string): URL {
  const address = server.httpServer?.address();
  if (address === null || typeof address === "string" || address === undefined) {
    throw new Error("The viewer development server did not expose a TCP address.");
  }
  const port = (address as AddressInfo).port;
  return new URL(`http://${host}:${String(port)}/`);
}

async function closeStartedServers(
  viewer: ViteDevServer | undefined,
  api: CodeCityServerHandle | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  if (viewer !== undefined) {
    try {
      await viewer.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (api !== undefined) {
    try {
      await api.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Viewer development servers could not be closed cleanly.");
  }
}

/** Starts the real API and a Vite viewer that proxies every same-origin API request. */
export async function startViewerDevelopmentServer(
  options: ViewerDevelopmentServerOptions = {},
): Promise<ViewerDevelopmentServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const viewerRoot = path.resolve(options.viewerRoot ?? "build/viewer");
  const indexPath = path.join(viewerRoot, "index.html");
  try {
    await fs.access(indexPath);
  } catch {
    throw new Error(
      "The production viewer is missing. Run npm run build before starting viewer development.",
    );
  }

  let api: CodeCityServerHandle | undefined;
  let viewer: ViteDevServer | undefined;
  try {
    api = await startCodeCityServer({
      host,
      port: options.apiPort ?? 0,
      dataDirectory: path.resolve(options.dataDirectory ?? ".code-city-dev"),
      viewerRoot,
      sourceRetention: "retain",
      trustWindowsGitWorkspace: options.trustWindowsGitWorkspace ?? false,
    });
    viewer = await createViteServer({
      configFile: path.resolve("apps/viewer/vite.config.ts"),
      server: {
        host,
        port: options.port ?? 5173,
        strictPort: true,
        proxy: {
          "/api": {
            target: api.url.href,
            changeOrigin: true,
          },
        },
      },
    });
    await viewer.listen();
    const url = listeningUrl(viewer, host);
    options.log?.(`Code City viewer is available at ${url.href}`);
    options.log?.(`Development API is available at ${api.url.href}`);
    let closed = false;
    return Object.freeze({
      url,
      apiUrl: api.url,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeStartedServers(viewer, api);
      },
    });
  } catch (error) {
    await closeStartedServers(viewer, api).catch(() => undefined);
    throw error;
  }
}

export async function developmentWorkspaceOptions(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  provisionWindows = provisionWindowsDevelopmentWorkspace,
): Promise<Pick<
  ViewerDevelopmentServerOptions,
  "dataDirectory" | "trustWindowsGitWorkspace"
>> {
  const configuredDataDirectory = environment["CODECITY_DATA_DIR"];
  const automaticWorkspace =
    platform === "win32" && configuredDataDirectory === undefined
      ? await provisionWindows()
      : undefined;
  const configuredTrust =
    environment["CODECITY_TRUST_WINDOWS_GIT_WORKSPACE"];
  if (configuredTrust !== undefined && configuredTrust !== "1") {
    throw new Error(
      "CODECITY_TRUST_WINDOWS_GIT_WORKSPACE must be exactly 1 when enabled.",
    );
  }
  return {
    ...(automaticWorkspace === undefined
      ? configuredDataDirectory === undefined
        ? {}
        : { dataDirectory: configuredDataDirectory }
      : { dataDirectory: automaticWorkspace.dataDirectory }),
    ...(automaticWorkspace?.trustWindowsGitWorkspace === true ||
    configuredTrust === "1"
      ? { trustWindowsGitWorkspace: true }
      : {}),
  };
}

async function runViewerDevelopmentServer(): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let handle: ViewerDevelopmentServerHandle | undefined;
  try {
    handle = await startViewerDevelopmentServer({
      ...(await developmentWorkspaceOptions()),
      log: (message) => process.stdout.write(`${message}\n`),
    });
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await handle?.close();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await runViewerDevelopmentServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
