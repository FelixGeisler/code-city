import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildStandaloneArtifact, projectRoot } from "./build-standalone.mjs";

const developmentRoot = path.join(projectRoot, "build", "development");
await buildStandaloneArtifact(developmentRoot);
process.stdout.write("Built the development standalone artifact in build/development.\n");
await import(pathToFileURL(path.join(developmentRoot, "server", "standalone.mjs")).href);
