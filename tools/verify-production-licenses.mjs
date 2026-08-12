import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageLock = JSON.parse(
  await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
);
const acceptedLicenses = new Set(["Apache-2.0", "MIT"]);
const licenseFilePattern = /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/iu;
const failures = [];
let checked = 0;

for (const [lockPath, entry] of Object.entries(packageLock.packages ?? {})) {
  if (lockPath === "" || entry.dev === true) continue;
  const component = lockPath.replace(/^node_modules\//u, "");
  if (!acceptedLicenses.has(entry.license)) {
    failures.push(`${component}: unsupported or missing license ${JSON.stringify(entry.license)}`);
    continue;
  }

  const installedPath = path.join(root, ...lockPath.split("/"));
  let names;
  try {
    names = await fs.readdir(installedPath);
  } catch (error) {
    if (entry.optional === true && error?.code === "ENOENT") continue;
    failures.push(`${component}: package is not installed`);
    continue;
  }
  if (!names.some((name) => licenseFilePattern.test(name))) {
    failures.push(`${component}: installed package has no license or notice file`);
    continue;
  }
  checked += 1;
}

if (failures.length > 0) {
  throw new Error(`Production license verification failed:\n- ${failures.join("\n- ")}`);
}

process.stdout.write(`Production license verification passed for ${checked} installed components.\n`);
