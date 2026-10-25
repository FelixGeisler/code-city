import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeStandaloneManifest } from "./standalone-manifest.mjs";

export const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const canonicalStandaloneRoot = path.join(projectRoot, "build", "standalone");

const PUBLIC_FILES = Object.freeze({
  "index.html": "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Code City inactive standalone fixture</title><link rel=\"stylesheet\" href=\"/fixture.css\"></head><body><main><img src=\"/fixture.svg\" alt=\"\"><h1>Inactive standalone fixture</h1><p>This package is not the Code City browser client.</p></main></body></html>\n",
  "fixture.css": "body{font-family:system-ui,sans-serif;margin:2rem}main{max-width:40rem}img{width:3rem;height:3rem}\n",
  "fixture.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"#2563eb\" d=\"M1 15V7h4v8zm5 0V1h4v14zm5 0V5h4v10z\"/></svg>\n",
});

const PARSER_FILES = Object.freeze([
  ["node_modules/web-tree-sitter/web-tree-sitter.js", "web-tree-sitter.js"],
  ["node_modules/web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
  ["node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm", "tree-sitter-javascript.wasm"],
  ["vendor/tree-sitter-typescript/wasm/tree-sitter-typescript.wasm", "tree-sitter-typescript.wasm"],
  ["vendor/tree-sitter-typescript/wasm/tree-sitter-tsx.wasm", "tree-sitter-tsx.wasm"],
  ["node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm", "tree-sitter-c-sharp.wasm"],
]);

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withJavaScriptExtension(specifier) {
  return path.posix.extname(specifier) === "" ? `${specifier}.js` : specifier;
}

function rewriteModuleSpecifiers(source) {
  const staticImport = /(\b(?:from|import)\s*)(["'])(\.\.?\/[^"']+)\2/gu;
  const dynamicImport = /(\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2(\s*\))/gu;
  return source
    .replace(staticImport, (_match, prefix, quote, specifier) => `${prefix}${quote}${withJavaScriptExtension(specifier)}${quote}`)
    .replace(dynamicImport, (_match, prefix, quote, specifier, suffix) => `${prefix}${quote}${withJavaScriptExtension(specifier)}${quote}${suffix}`)
    .replaceAll("\r\n", "\n");
}

async function emittedFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compare(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await emittedFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Standalone compiler emitted a non-file: ${relative}`);
  }
  return files;
}

async function compileSources(artifactRoot) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-standalone-compile-"));
  try {
    const output = path.join(temporary, "output");
    const configPath = path.join(temporary, "tsconfig.json");
    await writeFile(configPath, `${JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: false,
        noEmitOnError: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        types: ["node"],
        typeRoots: [path.join(projectRoot, "node_modules", "@types")],
        rootDir: path.join(projectRoot, "src"),
        outDir: output,
      },
      files: [
        path.join(projectRoot, "src", "edge", "node", "standalone-cli.ts"),
        path.join(projectRoot, "src", "edge", "node", "standalone-worker-entry.ts"),
      ],
    })}\n`, "utf8");
    const compiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [compiler, "--project", configPath], { cwd: projectRoot, stdio: "pipe" });

    for (const relative of await emittedFiles(output)) {
      if (!relative.endsWith(".js")) throw new Error(`Standalone compiler emitted an unsupported file: ${relative}`);
      const packagedRelative = relative === "edge/node/standalone-worker-entry.js"
        ? "edge/node/analysis-worker-entry.js"
        : relative;
      const target = path.join(artifactRoot, "server", "src", ...packagedRelative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, rewriteModuleSpecifiers(await readFile(path.join(output, ...relative.split("/")), "utf8")), "utf8");
    }
    await writeFile(path.join(artifactRoot, "server", "standalone.mjs"), 'import "./src/edge/node/standalone-cli.js";\n', "utf8");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function buildStandaloneArtifact(outputRoot = canonicalStandaloneRoot) {
  const artifactRoot = path.resolve(outputRoot);
  await rm(artifactRoot, { recursive: true, force: true });
  await Promise.all(["public", "server", "parser"].map((name) => mkdir(path.join(artifactRoot, name), { recursive: true })));
  for (const [name, content] of Object.entries(PUBLIC_FILES)) await writeFile(path.join(artifactRoot, "public", name), content, "utf8");
  for (const [source, name] of PARSER_FILES) await cp(path.join(projectRoot, ...source.split("/")), path.join(artifactRoot, "parser", name));
  await compileSources(artifactRoot);
  const manifest = await writeStandaloneManifest(artifactRoot);
  return { artifactRoot, manifest };
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { artifactRoot, manifest } = await buildStandaloneArtifact();
  process.stdout.write(`Wrote ${manifest.files.length} standalone files to ${path.relative(projectRoot, artifactRoot)}.\n`);
}
