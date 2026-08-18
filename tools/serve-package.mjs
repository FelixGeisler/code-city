import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_BASE_PATH,
  readPackageManifest,
  verifyManifestAgainstDirectory,
} from "./package-manifest.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const defaultDistDirectory = path.join(projectRoot, "dist");
const defaultManifestPath = path.join(projectRoot, "build", "evidence", "package-manifest.json");

function safeRequestPath(requestUrl) {
  if (typeof requestUrl !== "string") {
    return undefined;
  }
  const rawPath = requestUrl.split("?", 1)[0];
  let decodedRawPath;
  try {
    decodedRawPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decodedRawPath.includes("\\") || decodedRawPath.includes("\0")) {
    return undefined;
  }
  const rawSegments = decodedRawPath.split("/");
  if (rawSegments.includes(".") || rawSegments.includes("..")) {
    return undefined;
  }

  try {
    const parsed = new URL(requestUrl, "http://127.0.0.1");
    if (parsed.search || parsed.hash) {
      return undefined;
    }
    return decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
}

export async function createPackageServer({
  distDirectory = defaultDistDirectory,
  manifestPath = defaultManifestPath,
} = {}) {
  const manifest = await readPackageManifest(manifestPath);
  await verifyManifestAgainstDirectory(manifest, distDirectory);

  const resources = new Map();
  for (const record of manifest.files) {
    const content = await readFile(path.join(distDirectory, ...record.path.split("/")));
    resources.set(`${PACKAGE_BASE_PATH}${record.path}`, { content, record });
  }
  const entry = resources.get(`${PACKAGE_BASE_PATH}index.html`);
  if (!entry) {
    throw new Error("Production package has no index.html entry");
  }
  resources.set(PACKAGE_BASE_PATH, entry);

  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
      response.end();
      return;
    }

    const requestPath = safeRequestPath(request.url);
    const resource = requestPath && resources.get(requestPath);
    if (!resource) {
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
      return;
    }

    response.writeHead(200, {
      "Content-Length": String(resource.record.byteLength),
      "Content-Type": `${resource.record.mediaType}; charset=utf-8`,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : resource.content);
  });

  return { manifest, server };
}

export async function closePackageServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

export async function listen(server, { host = "127.0.0.1", port = 4173 } = {}) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  return server.address();
}

async function runPackagedServer() {
  const { server } = await createPackageServer();
  const address = await listen(server);
  const host = typeof address === "object" && address ? address.address : "127.0.0.1";
  const port = typeof address === "object" && address ? address.port : 4173;
  console.log(`Packaged Code City is available at http://${host}:${port}${PACKAGE_BASE_PATH}`);

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await closePackageServer(server);
    console.log("Packaged Code City server stopped.");
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runPackagedServer();
}
