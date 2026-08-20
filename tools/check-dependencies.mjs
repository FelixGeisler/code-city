import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isExactVersion(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

export async function inspectDependencyClosure(rootDirectory) {
  const packagePath = path.join(rootDirectory, "package.json");
  const lockPath = path.join(rootDirectory, "package-lock.json");
  const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
  const lock = JSON.parse(await readFile(lockPath, "utf8"));

  invariant(packageManifest.private === true, "Root package must remain private");
  invariant(packageManifest.type === "module", "Root package must remain ESM");
  invariant(packageManifest.license === "Apache-2.0", "Root package must remain Apache-2.0");
  invariant(packageManifest.packageManager === "npm@11.6.2", "Root package manager must remain npm 11.6.2");
  invariant(packageManifest.engines?.node === ">=24 <25", "Root Node engine changed");
  invariant(packageManifest.engines?.npm === ">=11 <12", "Root npm engine changed");
  invariant(!Object.hasOwn(packageManifest, "dependencies"), "Root runtime dependencies are forbidden");
  invariant(packageManifest.overrides?.["js-yaml"] === "4.3.1", "The js-yaml override changed");

  const expectedDevDependencies = {
    "@antora/cli": "3.1.15",
    "@antora/site-generator": "3.1.15",
    typescript: "7.0.2",
    vite: "8.2.1",
  };
  invariant(
    JSON.stringify(packageManifest.devDependencies) === JSON.stringify(expectedDevDependencies),
    "Direct development dependencies do not match the accepted exact pins",
  );
  for (const [name, version] of Object.entries(packageManifest.devDependencies)) {
    invariant(isExactVersion(version), `Direct development dependency is not exact: ${name}@${version}`);
  }

  invariant(lock.lockfileVersion === 3, "package-lock.json must use lockfileVersion 3");
  const lockRoot = lock.packages?.[""];
  invariant(lockRoot, "package-lock.json has no root package record");
  invariant(lockRoot.name === packageManifest.name, "Lock root name differs from package.json");
  invariant(lockRoot.version === packageManifest.version, "Lock root version differs from package.json");
  invariant(lockRoot.license === packageManifest.license, "Lock root license differs from package.json");
  invariant(!Object.hasOwn(lockRoot, "dependencies"), "Lock root contains runtime dependencies");
  invariant(
    JSON.stringify(lockRoot.devDependencies) === JSON.stringify(packageManifest.devDependencies),
    "Lock root development dependencies differ from package.json",
  );
  invariant(JSON.stringify(lockRoot.engines) === JSON.stringify(packageManifest.engines), "Lock root engines differ from package.json");

  let registryPackageCount = 0;
  for (const [location, record] of Object.entries(lock.packages)) {
    if (location === "") {
      continue;
    }
    invariant(location.startsWith("node_modules/"), `Unexpected non-registry lock entry: ${location}`);
    invariant(typeof record.version === "string" && record.version.length > 0, `Lock entry has no version: ${location}`);
    invariant(typeof record.resolved === "string" && record.resolved.length > 0, `Lock entry has no resolution: ${location}`);
    const resolution = new URL(record.resolved);
    invariant(
      resolution.protocol === "https:" && resolution.hostname === "registry.npmjs.org" && !resolution.username && !resolution.password,
      `Lock entry is not resolved from the HTTPS npm registry: ${location}`,
    );
    invariant(typeof record.integrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity), `Lock entry has no SHA-512 integrity: ${location}`);
    invariant(typeof record.license === "string" && record.license.trim().length > 0, `Lock entry has no declared license: ${location}`);
    registryPackageCount += 1;
  }

  const vite = lock.packages["node_modules/vite"];
  invariant(vite?.version === "8.2.1" && vite.license === "MIT", "Vite lock record must be exactly 8.2.1/MIT");
  const typescript = lock.packages["node_modules/typescript"];
  invariant(typescript?.version === "7.0.2" && typescript.license === "Apache-2.0", "TypeScript lock record must be exactly 7.0.2/Apache-2.0");

  return { registryPackageCount };
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const result = await inspectDependencyClosure(root);
  console.log(`Validated ${result.registryPackageCount} registry package records.`);
}
