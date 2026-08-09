import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  startViewerDevelopmentServer,
  type ViewerDevelopmentServerHandle,
} from "../apps/viewer/src/development-server.js";
import { ViewerImportApiClient } from "../apps/viewer/src/import-api.js";

const temporaryDirectories: string[] = [];
const handles: ViewerDevelopmentServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("serves the documented development viewer with a real same-origin API", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-viewer-dev-"));
  temporaryDirectories.push(root);
  const viewerRoot = path.join(root, "viewer");
  await fs.mkdir(viewerRoot);
  await fs.writeFile(
    path.join(viewerRoot, "index.html"),
    "<!doctype html><title>Code City test viewer</title>",
    "utf8",
  );

  const handle = await startViewerDevelopmentServer({
    dataDirectory: path.join(root, "data"),
    viewerRoot,
    host: "127.0.0.1",
    port: 0,
    apiPort: 0,
  });
  handles.push(handle);

  const viewerResponse = await fetch(handle.url);
  expect(viewerResponse.status).toBe(200);
  expect(await viewerResponse.text()).toContain("Code City");

  const citySceneResponse = await fetch(new URL("src/city-scene.ts", handle.url));
  expect(citySceneResponse.status).toBe(200);
  const citySceneSource = await citySceneResponse.text();
  const orbitControlsPath = citySceneSource.match(
    /["'](\/[^"']+three_addons_controls_OrbitControls__js\.js\?v=[^"']+)/u,
  )?.[1];
  expect(orbitControlsPath).toBeDefined();
  const orbitControlsResponse = await fetch(
    new URL(orbitControlsPath as string, handle.url),
  );
  expect(orbitControlsResponse.status).toBe(200);
  expect(orbitControlsResponse.headers.get("content-type")).toContain(
    "text/javascript",
  );

  const apiResponse = await fetch(
    new URL("api/v1/auth/session", handle.url),
  );
  expect(apiResponse.status).toBe(200);
  expect(apiResponse.headers.get("content-type")).toBe(
    "application/json; charset=utf-8",
  );
  await expect(apiResponse.json()).resolves.toMatchObject({
    authorization: expect.any(Object),
  });
  await expect(
    new ViewerImportApiClient(handle.url).authorizationStatus(),
  ).resolves.toMatchObject({ required: false });
});
