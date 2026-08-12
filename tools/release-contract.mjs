import { promises as fs } from "node:fs";

const root = new URL("../", import.meta.url);

async function text(path) {
  return (await fs.readFile(new URL(path, root), "utf8")).replaceAll(
    "\r\n",
    "\n",
  );
}

const packageJson = JSON.parse(await text("package.json"));
const packageLock = JSON.parse(await text("package-lock.json"));
const readme = await text("README.md");
const versionSource = await text("packages/core/src/version.ts");
const releaseNotes = await text("RELEASE_NOTES.md");
const license = await text("LICENSE");
const notice = await text("NOTICE");
const security = await text("SECURITY.md");
const dockerfile = await text("Dockerfile");
const releaseWorkflow = await text(".github/workflows/release.yml");
const screenshotPaths = [
  "docs/modules/ROOT/images/code-city-overview.webp",
  "docs/modules/ROOT/images/code-city-analysis.webp",
];

const version = packageJson.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error("package.json must contain a stable semantic version.");
}
if (
  packageJson.private !== true ||
  packageJson.license !== "Apache-2.0" ||
  packageJson.repository?.url !==
    "https://github.com/FelixGeisler/code-city.git"
) {
  throw new Error("package.json release metadata is incomplete.");
}
if (packageLock.packages?.[""]?.version !== version) {
  throw new Error("package-lock.json root version does not match package.json.");
}
if (
  versionSource.trim() !==
  `export const CODE_CITY_VERSION = ${JSON.stringify(version)};`
) {
  throw new Error("The runtime version source does not match package.json.");
}
if (
  !readme.includes(`ghcr.io/felixgeisler/code-city:${version}`) ||
  !readme.includes("code-city-overview.webp") ||
  !readme.includes("code-city-analysis.webp")
) {
  throw new Error("README.md does not provide the versioned one-command overview.");
}
if (!releaseNotes.startsWith(`# Code City ${version}\n`)) {
  throw new Error("RELEASE_NOTES.md does not describe the release version.");
}
for (const screenshotPath of screenshotPaths) {
  const screenshot = await fs.stat(new URL(screenshotPath, root));
  if (!screenshot.isFile() || screenshot.size < 10_000) {
    throw new Error(`Release screenshot ${screenshotPath} is missing or empty.`);
  }
}
if (!license.includes("Apache License") || !license.includes("Version 2.0")) {
  throw new Error("LICENSE is not the Apache License 2.0 text.");
}
if (!notice.includes("does not grant permission to use trade names, trademarks")) {
  throw new Error("NOTICE does not preserve the trademark boundary.");
}
if (!security.includes("privately report a security vulnerability")) {
  throw new Error("SECURITY.md does not provide private reporting guidance.");
}

if (!dockerfile.includes(`ARG CODECITY_VERSION=${version}`)) {
  throw new Error("Dockerfile version does not match package.json.");
}
if (!dockerfile.includes('org.opencontainers.image.licenses="Apache-2.0"')) {
  throw new Error("Dockerfile does not declare the release license.");
}
if (!releaseWorkflow.includes("sbom: true") || !releaseWorkflow.includes("provenance: mode=max")) {
  throw new Error("Release workflow does not produce supply-chain attestations.");
}
if (
  !releaseWorkflow.includes("https://ghcr.io/token?service=ghcr.io&scope=repository:") ||
  !releaseWorkflow.includes("Verify the release image is anonymously readable") ||
  !releaseWorkflow.includes("Smoke the published immutable digest")
) {
  throw new Error("Release workflow does not verify and smoke a public image.");
}

const releaseTag = process.env.RELEASE_TAG;
if (releaseTag !== undefined && releaseTag !== `v${version}`) {
  throw new Error(
    `Release tag ${JSON.stringify(releaseTag)} must equal v${version}.`,
  );
}

process.stdout.write(`Code City ${version} release contract passed.\n`);
