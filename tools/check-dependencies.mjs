import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVendorFiles } from "./check-parser-assets.mjs";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isExactVersion(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

export async function inspectDependencyClosure(rootDirectory) {
  await verifyVendorFiles(rootDirectory);
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
  const expectedDependencies = {
    "@vscode/tree-sitter-wasm": "0.3.1",
    "web-tree-sitter": "0.27.0",
  };
  invariant(
    JSON.stringify(packageManifest.dependencies) === JSON.stringify(expectedDependencies),
    "Direct production dependencies do not match the accepted parser pins",
  );
  for (const [name, version] of Object.entries(packageManifest.dependencies)) {
    invariant(isExactVersion(version), `Direct production dependency is not exact: ${name}@${version}`);
  }
  invariant(packageManifest.overrides?.["js-yaml"] === "5.4.2", "The js-yaml override differs from the accepted pin");

  const expectedDevDependencies = {
    "@antora/cli": "3.2.0",
    "@antora/site-generator": "3.2.0",
    typescript: "7.0.2",
    vite: "8.3.0",
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
  invariant(
    JSON.stringify(lockRoot.dependencies) === JSON.stringify(packageManifest.dependencies),
    "Lock root production dependencies differ from package.json",
  );
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

  const expectedRenewedRecords = {
    "web-tree-sitter": {
      version: "0.27.0",
      resolved: "https://registry.npmjs.org/web-tree-sitter/-/web-tree-sitter-0.27.0.tgz",
      integrity: "sha512-XK08gj6RwTMQatAG7uVRP8MunqotL/XC19vHgkSPKmELgbGPBj4ECvB8haHOUnyj6ls2B8t42UTro14zxGgAHg==",
      license: "MIT",
    },
    "@antora/cli": {
      version: "3.2.0",
      resolved: "https://registry.npmjs.org/@antora/cli/-/cli-3.2.0.tgz",
      integrity: "sha512-bJ5Vl+FMH52xm2jxdcbrEUN3aeoIYj5NGzLGsVwIPewM0RXee0kckbToAFnU0EK0Uw07cBomiJ5hwVELex0/ug==",
      license: "MPL-2.0",
    },
    "@antora/site-generator": {
      version: "3.2.0",
      resolved: "https://registry.npmjs.org/@antora/site-generator/-/site-generator-3.2.0.tgz",
      integrity: "sha512-bgShOpARuO+1MF50HUsv25C7msyZk6GpaP2EBcjqD3s0Dj51amQL5KMqAbwfKLjTCiAUTGpC/Yb8rGeogUnmYw==",
      license: "MPL-2.0",
    },
    vite: {
      version: "8.3.0",
      resolved: "https://registry.npmjs.org/vite/-/vite-8.3.0.tgz",
      integrity: "sha512-lhZBVvEHefgE+HQZC9O7EBJgCU/nVzFNl7vkS4RE0APtWLP02/8QVIkQtzBxPquh7lq5/78NHipTj7ODQ6XuyQ==",
      license: "MIT",
    },
    "js-yaml": {
      version: "5.4.2",
      resolved: "https://registry.npmjs.org/js-yaml/-/js-yaml-5.4.2.tgz",
      integrity: "sha512-m+aqu+LwO1O6sIopafj8HUVl5aawITwZQe/yHpMCKjaWBaA/d07B/QdMb3529REftiU+RMMHL3Vlsw3hON7vWg==",
      license: "MIT",
    },
  };
  for (const [name, expected] of Object.entries(expectedRenewedRecords)) {
    const record = lock.packages[`node_modules/${name}`];
    invariant(
      record?.version === expected.version
        && record.resolved === expected.resolved
        && record.integrity === expected.integrity
        && record.license === expected.license,
      `${name} lock provenance differs from accepted evidence`,
    );
  }

  const parserRuntime = lock.packages["node_modules/web-tree-sitter"];
  invariant(
    !parserRuntime.dependencies
      && !parserRuntime.optionalDependencies
      && !parserRuntime.peerDependencies,
    "web-tree-sitter dependency closure differs from accepted evidence",
  );
  const grammars = lock.packages["node_modules/@vscode/tree-sitter-wasm"];
  invariant(
    grammars?.version === "0.3.1"
      && grammars.license === "MIT"
      && grammars.integrity === "sha512-RJFoomET6FajjG511fmQxeBQfU6M24a0aFZPqpid+ttIxanWf1VGytBG0UmsGjt07qmIPJS8U31D+aecuCucsQ=="
      && !grammars.dependencies
      && !grammars.optionalDependencies
      && !grammars.peerDependencies,
    "@vscode/tree-sitter-wasm lock provenance differs from accepted #450 evidence",
  );

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
