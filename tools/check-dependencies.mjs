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
    "web-tree-sitter": "0.27.1",
  };
  invariant(
    JSON.stringify(packageManifest.dependencies) === JSON.stringify(expectedDependencies),
    "Direct production dependencies do not match the accepted parser pins",
  );
  for (const [name, version] of Object.entries(packageManifest.dependencies)) {
    invariant(isExactVersion(version), `Direct production dependency is not exact: ${name}@${version}`);
  }
  invariant(
    JSON.stringify(packageManifest.overrides) === JSON.stringify({ braces: "3.0.3", "js-yaml": "5.4.2" }),
    "The root overrides differ from the accepted exact pins",
  );

  const expectedDevDependencies = {
    "@antora/cli": "3.2.0",
    "@antora/site-generator": "3.2.0",
    typescript: "7.0.2",
    vite: "8.3.4",
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
      version: "0.27.1",
      resolved: "https://registry.npmjs.org/web-tree-sitter/-/web-tree-sitter-0.27.1.tgz",
      integrity: "sha512-qtx0VyUyNRHtL3ze7+v0hCKB/sLcAmY7ZAVp/ZK/bCj0yED8ptvNrr7Vd7DwDyKDWN9baqcUx4uaD2r2ql+6IA==",
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
      version: "8.3.4",
      resolved: "https://registry.npmjs.org/vite/-/vite-8.3.4.tgz",
      integrity: "sha512-IftLE8phJhdNRIGNEV4JCCvfNScoZQVfcXaN8TQropWGJtOHcu+iAB9pHcuGvmEb/kddw0LBe/jS8ztdC6xdiQ==",
      license: "MIT",
    },
    "js-yaml": {
      version: "5.4.2",
      resolved: "https://registry.npmjs.org/js-yaml/-/js-yaml-5.4.2.tgz",
      integrity: "sha512-m+aqu+LwO1O6sIopafj8HUVl5aawITwZQe/yHpMCKjaWBaA/d07B/QdMb3529REftiU+RMMHL3Vlsw3hON7vWg==",
      license: "MIT",
    },
    handlebars: {
      version: "4.7.10",
      resolved: "https://registry.npmjs.org/handlebars/-/handlebars-4.7.10.tgz",
      integrity: "sha512-P5VJMVM7qgBn6vjXMw8WG9uVI+ncf2pi72j4de4yz5ZULLj2RGqLYaKOYGsgyrViQ0tePOVlN1tDCCXXtFqXKg==",
      license: "MIT",
    },
    "source-map-js": {
      version: "1.2.2",
      resolved: "https://registry.npmjs.org/source-map-js/-/source-map-js-1.2.2.tgz",
      integrity: "sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==",
      license: "BSD-3-Clause",
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

  const expectedHighClosure = {
    "@antora/content-aggregator": {
      version: "3.2.0",
      resolved: "https://registry.npmjs.org/@antora/content-aggregator/-/content-aggregator-3.2.0.tgz",
      integrity: "sha512-Q7lTjNFlpQx3SWW8QbNv5P4f1DhiKhYY3PyMifRHc4npuILOU0q4+kmlO1W1swSDDCg5pDjmgwitwAi9VQgvhg==",
      dependencies: { "@antora/expand-path-helper": "~3.0", "@antora/logger": "3.2.0", "@antora/user-require-helper": "~3.0", braces: "~3.0", "cache-directory": "~2.0", "fast-glob": "~3.3", hpagent: "~1.2", "isomorphic-git": "~1.38", "js-yaml": "~5.4", "multi-progress": "~4.0", picomatch: "~4.0", progress: "~2.0", "should-proxy": "~1.0", "simple-get": "~4.0", vinyl: "~3.0" },
    },
    "@antora/site-generator": {
      version: "3.2.0",
      resolved: "https://registry.npmjs.org/@antora/site-generator/-/site-generator-3.2.0.tgz",
      integrity: "sha512-bgShOpARuO+1MF50HUsv25C7msyZk6GpaP2EBcjqD3s0Dj51amQL5KMqAbwfKLjTCiAUTGpC/Yb8rGeogUnmYw==",
      dependencies: { "@antora/asciidoc-loader": "3.2.0", "@antora/content-aggregator": "3.2.0", "@antora/content-classifier": "3.2.0", "@antora/document-converter": "3.2.0", "@antora/file-publisher": "3.2.0", "@antora/logger": "3.2.0", "@antora/navigation-builder": "3.2.0", "@antora/page-composer": "3.2.0", "@antora/playbook-builder": "3.2.0", "@antora/redirect-producer": "3.2.0", "@antora/site-mapper": "3.2.0", "@antora/site-publisher": "3.2.0", "@antora/ui-loader": "3.2.0", "@antora/user-require-helper": "~3.0" },
    },
    "@antora/ui-loader": {
      version: "3.2.0",
      resolved: "https://registry.npmjs.org/@antora/ui-loader/-/ui-loader-3.2.0.tgz",
      integrity: "sha512-EYagiuG2Tk5QtnG/rwTzu/8mxDtL8J2oqZc74g0h4h3iatJeD8yNrDc8iDhNaycEZNaxPRfIK73tpKuIFZw+Iw==",
      dependencies: { "@antora/expand-path-helper": "~3.0", braces: "~3.0", "cache-directory": "~2.0", "fast-glob": "~3.3", hpagent: "~1.2", "js-yaml": "~5.4", picomatch: "~4.0", "should-proxy": "~1.0", "simple-get": "~4.0", vinyl: "~3.0", yauzl: "~3.4" },
    },
    "@asciidoctor/core": {
      version: "2.2.9",
      resolved: "https://registry.npmjs.org/@asciidoctor/core/-/core-2.2.9.tgz",
      integrity: "sha512-tIPRHo1T2SFmAm+j77cDsj0RuaszP7xJxsaVTTAF5CwKyTbazw9TnIVlpIWM5yWfIWAWcAZy92RcnPgMJwny1w==",
      dependencies: { "asciidoctor-opal-runtime": "0.3.4", unxhr: "~1.2" },
    },
    "asciidoctor-opal-runtime": {
      version: "0.3.4",
      resolved: "https://registry.npmjs.org/asciidoctor-opal-runtime/-/asciidoctor-opal-runtime-0.3.4.tgz",
      integrity: "sha512-zqd6zn1LV+PZ69AP/kEbB00zuPHMIAJY3IX8+aZV+X1qOwatYvKGjsMmdMc5ApfhtkjZ4mYkqiTPJWnEnBiMJg==",
      dependencies: { "fast-glob": "~3.3", unxhr: "~1.2" },
    },
    braces: {
      version: "3.0.3",
      resolved: "https://registry.npmjs.org/braces/-/braces-3.0.3.tgz",
      integrity: "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==",
      dependencies: { "fill-range": "^7.1.1" },
    },
    "fast-glob": {
      version: "3.3.3",
      resolved: "https://registry.npmjs.org/fast-glob/-/fast-glob-3.3.3.tgz",
      integrity: "sha512-7MptL8U0cqcFdzIzwOTHoilX9x5BrNqye7Z/LuC7kCMRio1EMSyqRK3BEAUD7sXRq4iT4AzTVuZdhgQ2TCvYLg==",
      dependencies: { "@nodelib/fs.stat": "^2.0.2", "@nodelib/fs.walk": "^1.2.3", "glob-parent": "^5.1.2", merge2: "^1.3.0", micromatch: "^4.0.8" },
    },
    micromatch: {
      version: "4.0.8",
      resolved: "https://registry.npmjs.org/micromatch/-/micromatch-4.0.8.tgz",
      integrity: "sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA==",
      dependencies: { braces: "^3.0.3", picomatch: "^2.3.1" },
    },
  };
  for (const [name, expected] of Object.entries(expectedHighClosure)) {
    const record = lock.packages[`node_modules/${name}`];
    invariant(record?.dev === true, `${name} must remain development-only`);
    invariant(record.version === expected.version && record.resolved === expected.resolved && record.integrity === expected.integrity, `${name} lock provenance differs from the approved high closure`);
    invariant(JSON.stringify(record.dependencies) === JSON.stringify(expected.dependencies), `${name} dependency declarations differ from the approved high closure`);
  }
  invariant(
    JSON.stringify(lock.packages["node_modules/handlebars"].dependencies) === JSON.stringify({ minimist: "^1.2.8", "neo-async": "^2.6.2", "source-map": "^0.6.1", wordwrap: "^1.0.0" }),
    "handlebars transitive declarations differ from 4.7.10",
  );
  invariant(!lock.packages["node_modules/source-map-js"].dependencies, "source-map-js 1.2.2 unexpectedly adds a dependency");
  invariant(registryPackageCount === 206, "The lockfile package inventory changed");

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
