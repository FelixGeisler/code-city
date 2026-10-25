import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";

export async function writeStandaloneBrowserProviderHarness(directory) {
  await mkdir(directory, { recursive: true });
  const control = path.join(directory, "control.json");
  const log = path.join(directory, "provider.jsonl");
  const revisionModule = path.join(directory, "revision-gateway.mjs");
  const sourceModule = path.join(directory, "source-gateway.mjs");
  const preload = path.join(directory, "provider-preload.mjs");
  const workerEntry = pathToFileURL(path.join(canonicalStandaloneRoot, "server", "src", "edge", "node", "analysis-worker-entry.js")).href;
  const revision = "a".repeat(40);
  const blob = "b".repeat(40);
  const shared = `import { appendFileSync, readFileSync } from "node:fs";\nconst controlPath=${JSON.stringify(control)};const logPath=${JSON.stringify(log)};\nconst scenario=JSON.parse(readFileSync(controlPath,"utf8"));\nconst record=(event,detail={})=>appendFileSync(logPath,JSON.stringify({pid:process.pid,event,...detail})+"\\n");\n`;
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
const encoder=new TextEncoder();const blob=${JSON.stringify(blob)};
function rows() {
  if (scenario.mode === "mixed") return [["bad.js","export const = ;"],["good.js","export const good = 1;\\n"]];
  if (scenario.mode === "all-failed") return [["bad.js","export const = ;"]];
  if (scenario.mode === "busy-parser") return Array.from({length:8},(_,index)=>["busy-"+String(index).padStart(2,"0")+".js",";".repeat(2000000)]);
  if (scenario.mode === "large-failures") return Array.from({length:4000},(_,index)=>["failed/"+String(index).padStart(4,"0")+"-"+"x".repeat(120)+".js",null]);
  return [["success.js","export function choose(value) { return value > 0 ? value : 0; }\\n"]];
}
const sources=new Map(rows());
export function createGithubRawSourceGateway() { return {
  async loadInventory() { record("inventory", { mode: scenario.mode, count: sources.size }); return { kind:"inventory", entries:[...sources.keys()].map((sourcePath)=>({path:sourcePath,mode:"100644",type:"blob",sha:blob})) }; },
  async readRawSource(_repository,_selected,candidate) { const source=sources.get(candidate.rawPath); if(source===undefined)return {kind:"provider-failure"}; record("source", { path:candidate.rawPath }); return source===null ? {kind:"source",rawBytes:Uint8Array.from([0xc3,0x28])} : {kind:"source",rawBytes:encoder.encode(source)}; },
}; }
`, "utf8");
  await writeFile(preload, `import { registerHooks } from "node:module";\nconst workerEntry=${JSON.stringify(workerEntry)};const revisionReplacement=${JSON.stringify(pathToFileURL(revisionModule).href)};const sourceReplacement=${JSON.stringify(pathToFileURL(sourceModule).href)};\nregisterHooks({resolve(specifier,context,nextResolve){if(context.parentURL===workerEntry&&specifier==="../github-revision-gateway.js")return {url:revisionReplacement,shortCircuit:true};if(context.parentURL===workerEntry&&specifier==="../github-source-gateway.js")return {url:sourceReplacement,shortCircuit:true};return nextResolve(specifier,context);}});\n`, "utf8");
  await writeFile(control, `${JSON.stringify({ mode: "success" })}\n`, "utf8");
  await writeFile(log, "", "utf8");
  return Object.freeze({ control, log, preload });
}
