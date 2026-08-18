import { createHash } from "node:crypto";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_BASE_PATH,
  assertPackageStateUnchanged,
  capturePackageState,
  readPackageManifest,
  verifyManifestAgainstDirectory,
} from "./package-manifest.mjs";
import {
  assertNoWorkerConstructionOrMessageContract,
  collectRuntimeReferences,
  inspectEntryPolicy,
} from "./package-policy.mjs";
import { closePackageServer, createPackageServer, listen } from "./serve-package.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const distDirectory = path.join(projectRoot, "dist");
const manifestPath = path.join(projectRoot, "build", "evidence", "package-manifest.json");

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function rawRequestStatus(port, requestPath) {
  return await new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      method: "GET",
      path: requestPath,
      port,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function assertProductionShape(manifest) {
  const html = manifest.files.filter((record) => record.path.endsWith(".html"));
  const css = manifest.files.filter((record) => record.path.endsWith(".css"));
  const javascript = manifest.files.filter((record) => record.path.endsWith(".js"));
  invariant(html.length === 1 && html[0].path === "index.html", "Production package must contain only the index HTML document");
  invariant(css.length === 1, "Production package must contain exactly one stylesheet");
  invariant(javascript.length === 2, "Production package must contain one main module and one worker module");
  invariant(manifest.files.length === html.length + css.length + javascript.length, "Production package contains a non-runtime artifact");

  const workerAssets = javascript.filter((record) => /(?:^|\/)processing-worker-[A-Za-z0-9_-]+\.js$/.test(record.path));
  invariant(workerAssets.length === 1, "Production package must contain exactly one separate processing worker asset");
  return workerAssets[0];
}

function assertClosedReference(reference, manifestPaths) {
  invariant(!/^(?:https?:|\/\/|data:|blob:)/i.test(reference), `Remote or inline runtime reference is forbidden: ${reference}`);
  invariant(reference.startsWith(PACKAGE_BASE_PATH), `Runtime reference is outside ${PACKAGE_BASE_PATH}: ${reference}`);
  const parsed = new URL(reference, "https://example.invalid");
  invariant(parsed.origin === "https://example.invalid", `Runtime reference is not same-origin: ${reference}`);
  invariant(!parsed.search && !parsed.hash, `Runtime reference must not contain a query or fragment: ${reference}`);
  const relativePath = decodeURIComponent(parsed.pathname.slice(PACKAGE_BASE_PATH.length));
  invariant(manifestPaths.has(relativePath || "index.html"), `Runtime reference is absent from the package: ${reference}`);
}

export async function auditCanonicalPackage() {
  const canonicalBefore = await capturePackageState(distDirectory, manifestPath);
  let server;
  let failure;

  try {
    const manifest = await readPackageManifest(manifestPath);
    await verifyManifestAgainstDirectory(manifest, distDirectory);
    const workerAsset = assertProductionShape(manifest);
    const manifestPaths = new Set(manifest.files.map((record) => record.path));

    const packageFiles = new Map();
    for (const record of manifest.files) {
      const content = await readFile(path.join(distDirectory, ...record.path.split("/")));
      packageFiles.set(record.path, content.toString("utf8"));
      if (record.path.endsWith(".js")) {
        assertNoWorkerConstructionOrMessageContract(content.toString("utf8"), `Packaged ${record.path}`);
      }
    }

    const entryHtml = packageFiles.get("index.html");
    inspectEntryPolicy(entryHtml);
    const references = collectRuntimeReferences(entryHtml, packageFiles);
    invariant(references.length > 0, "Production entry has no runtime references");
    for (const reference of references) {
      assertClosedReference(reference, manifestPaths);
    }

    for (const record of manifest.files) {
      assertClosedReference(`${PACKAGE_BASE_PATH}${record.path}`, manifestPaths);
    }

    ({ server } = await createPackageServer({ distDirectory, manifestPath }));
    const address = await listen(server, { host: "127.0.0.1", port: 0 });
    invariant(typeof address === "object" && address, "Package server did not return a local address");
    const origin = `http://127.0.0.1:${address.port}`;

    const routes = [{ path: "index.html", url: `${origin}${PACKAGE_BASE_PATH}` }];
    for (const record of manifest.files) {
      routes.push({ path: record.path, url: `${origin}${PACKAGE_BASE_PATH}${record.path}` });
    }

    for (const route of routes) {
      const record = manifest.files.find((candidate) => candidate.path === route.path);
      const response = await fetch(route.url);
      invariant(response.status === 200, `Package request failed (${response.status}): ${route.url}`);
      invariant(response.url.startsWith(`${origin}${PACKAGE_BASE_PATH}`), `Package request escaped its mount: ${response.url}`);
      invariant(response.headers.get("content-type")?.split(";", 1)[0] === record.mediaType, `Wrong media type for ${route.path}`);
      invariant(response.headers.get("content-length") === String(record.byteLength), `Wrong content length for ${route.path}`);
      const content = Buffer.from(await response.arrayBuffer());
      invariant(content.byteLength === record.byteLength, `HTTP body length differs for ${route.path}`);
      invariant(digest(content) === record.sha256, `HTTP body digest differs for ${route.path}`);
    }

    const workerResponse = await fetch(`${origin}${PACKAGE_BASE_PATH}${workerAsset.path}`);
    invariant(workerResponse.status === 200, "The emitted worker URL is not fetchable");
    await workerResponse.arrayBuffer();

    const confinedPaths = [
      "/",
      "/package.json",
      `${PACKAGE_BASE_PATH}../package.json`,
      `${PACKAGE_BASE_PATH}%2e%2e/package.json`,
      `${PACKAGE_BASE_PATH}%5c..%5cpackage.json`,
      `${PACKAGE_BASE_PATH}not-in-manifest.js`,
    ];
    for (const confinedPath of confinedPaths) {
      const status = await rawRequestStatus(address.port, confinedPath);
      invariant(status === 404, `Package server did not confine path ${confinedPath}: ${status}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (server) {
      try {
        await closePackageServer(server);
        invariant(!server.listening, "Package server did not shut down cleanly");
      } catch (closeError) {
        failure = failure
          ? new AggregateError([failure, closeError], "Package audit failed and the server did not shut down")
          : closeError;
      }
    }
    try {
      await assertPackageStateUnchanged(canonicalBefore, distDirectory, manifestPath);
    } catch (stateError) {
      failure = failure
        ? new AggregateError([failure, stateError], "Package audit failed and mutated the canonical package")
        : stateError;
    }
  }

  if (failure) {
    throw failure;
  }
  console.log("Audited the unchanged canonical package over confined local HTTP and shut it down cleanly.");
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await auditCanonicalPackage();
}
