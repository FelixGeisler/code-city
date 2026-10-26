import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";

export async function writeStandaloneBrowserProviderHarness(directory) {
  await mkdir(directory, { recursive: true });
  const control = path.join(directory, "control.json");
  const log = path.join(directory, "provider.jsonl");
  const revisionModule = path.join(directory, "revision-gateway.mjs");
  const sourceModule = path.join(directory, "source-gateway.mjs");
  const parserModule = path.join(directory, "parser-adapter.mjs");
  const preload = path.join(directory, "provider-preload.mjs");
  const acquisitionRelease = path.join(directory, "release-acquisition");
  const analysisRelease = path.join(directory, "release-analysis");
  await Promise.all([rm(acquisitionRelease, { force: true }), rm(analysisRelease, { force: true })]);
  const workerEntry = pathToFileURL(path.join(canonicalStandaloneRoot, "server", "src", "edge", "node", "analysis-worker-entry.js")).href;
  const parserAdapter = pathToFileURL(path.join(canonicalStandaloneRoot, "server", "src", "edge", "tree-sitter-adapter.js")).href;
  const revision = "a".repeat(40);
  const shared = `import { createHash } from "node:crypto";\nimport { appendFileSync, existsSync, readFileSync, watch } from "node:fs";\nimport path from "node:path";\nconst controlPath=${JSON.stringify(control)};const logPath=${JSON.stringify(log)};\nconst scenario=JSON.parse(readFileSync(controlPath,"utf8"));\nconst record=(event,detail={})=>appendFileSync(logPath,JSON.stringify({pid:process.pid,event,...detail})+"\\n");\nconst waitForRelease=(releasePath,signal)=>new Promise((resolve)=>{if(existsSync(releasePath)){resolve();return;}const watcher=watch(path.dirname(releasePath),(_event,name)=>{if(name===path.basename(releasePath)&&existsSync(releasePath))finish();});const finish=()=>{watcher.close();signal?.removeEventListener("abort",finish);resolve();};signal?.addEventListener("abort",finish,{once:true});if(existsSync(releasePath))finish();});\n`;
  await writeFile(revisionModule, `${shared}
export function createGithubRevisionGateway() { return async (_repository, signal) => {
  record("revision-start", { mode: scenario.mode });
  if (scenario.mode === "block-provider") {
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    record("revision-aborted", { aborted: signal.aborted });
    return { kind: "provider-failure" };
  }
  record("revision-complete");
  return { kind: "revision", revision: ${JSON.stringify(revision)} };
}; }
`, "utf8");
  await writeFile(sourceModule, `${shared}
const encoder=new TextEncoder();
function successfulRows() { return [
  ["src/Zeta.js","export const z = 1;\\n"],
  ["src/a space.js","export const a = 1;\\nexport const b = 2;\\n"],
  ["src/literal[1].js","export function choose(value) {\\n  if (value > 0) return value;\\n  return value ? 1 : 0;\\n}\\n"],
  ["src/é.js","export function composed(value) { return value && 1; }\\n"],
  ["src/Ω.js","export function first() { return 1; }\\nexport function second() { return 2; }\\n"],
]; }
function rows() {
  if (scenario.mode === "mixed") return [["bad.js","export const = ;"],...successfulRows()];
  if (scenario.mode === "all-failed") return [["bad.js","export const = ;"]];
  if (scenario.mode === "busy-parser") return Array.from({length:8},(_,index)=>["busy-"+String(index).padStart(2,"0")+".js",";".repeat(2000000)]);
  if (scenario.mode === "progress-barriers") return [successfulRows()[0], ["text-failure.js",null], successfulRows()[1]];
  if (scenario.mode === "fast-4000") return Array.from({length:4000},(_,index)=>["fast-"+String(index).padStart(4,"0")+".js",null]);
  if (scenario.mode === "large-failures") return Array.from({length:4000},(_,index)=>["failed/"+String(index).padStart(4,"0")+"-"+"x".repeat(120)+".js",null]);
  return successfulRows();
}
const sources=new Map(rows().map(([sourcePath,source])=>{const rawBytes=source===null?Uint8Array.from([0xc3,0x28]):encoder.encode(source);const sha=createHash("sha1").update("blob "+rawBytes.byteLength+"\\0").update(rawBytes).digest("hex");return [sourcePath,{rawBytes,sha}];}));
let sourceReads=0;
export function createGithubRawSourceGateway() { return {
  async loadInventory(_repository,_selected,signal) {
    record("inventory", { mode: scenario.mode, count: sources.size });
    if (scenario.mode === "block-inventory") {
      record("inventory-held");
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      record("inventory-aborted", { aborted: signal.aborted });
      return { kind:"provider-failure" };
    }
    return { kind:"inventory", entries:[...(sources.has("src/Zeta.js")?[{path:"src",mode:"040000",type:"tree"}]:[]),...[...sources].map(([sourcePath,value])=>({path:sourcePath,mode:"100644",type:"blob",sha:value.sha}))] };
  },
  async readRawSource(_repository,_selected,candidate,signal) { const source=sources.get(candidate.rawPath); if(source===undefined)return {kind:"provider-failure"}; if(scenario.mode==="progress-barriers"){const sourceIndex=sourceReads++;if(sourceReads===3)record("acquisition-window-filled");if(sourceIndex===0){record("first-acquisition-held");await waitForRelease(${JSON.stringify(acquisitionRelease)},signal);record("first-acquisition-released");}}record("source"); return {kind:"source",rawBytes:source.rawBytes}; },
}; }
`, "utf8");
  await writeFile(parserModule, `${shared}
import { createTreeSitterAdapter as createPackagedTreeSitterAdapter } from ${JSON.stringify(parserAdapter)};
export function createTreeSitterAdapter(assets,options){const parser=createPackagedTreeSitterAdapter(assets,options);if(scenario.mode!=="progress-barriers")return parser;let first=true;return {initialize:()=>parser.initialize(),async project(family,source){if(first){first=false;record("first-analysis-held");await waitForRelease(${JSON.stringify(analysisRelease)});record("first-analysis-released");}return parser.project(family,source);}};}
`, "utf8");
  await writeFile(preload, `import { registerHooks } from "node:module";\nconst workerEntry=${JSON.stringify(workerEntry)};const revisionReplacement=${JSON.stringify(pathToFileURL(revisionModule).href)};const sourceReplacement=${JSON.stringify(pathToFileURL(sourceModule).href)};const parserReplacement=${JSON.stringify(pathToFileURL(parserModule).href)};\nregisterHooks({resolve(specifier,context,nextResolve){if(context.parentURL===workerEntry&&specifier==="../github-revision-gateway.js")return {url:revisionReplacement,shortCircuit:true};if(context.parentURL===workerEntry&&specifier==="../github-source-gateway.js")return {url:sourceReplacement,shortCircuit:true};if(context.parentURL===workerEntry&&specifier==="../tree-sitter-adapter.js")return {url:parserReplacement,shortCircuit:true};return nextResolve(specifier,context);}});\n`, "utf8");
  await writeFile(control, `${JSON.stringify({ mode: "success" })}\n`, "utf8");
  await writeFile(log, "", "utf8");
  return Object.freeze({ control, log, preload, acquisitionRelease, analysisRelease });
}
