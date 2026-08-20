export function createBrowserHarnessSource({ projectRootUrl, assets }) {
  return `
import { createTreeSitterAdapter } from ${JSON.stringify(`${projectRootUrl}src/edge/tree-sitter-adapter.ts`)};
import { processAdmittedBaseMetrics } from ${JSON.stringify(`${projectRootUrl}src/application/base-metric-processing.ts`)};

const ASSETS = ${JSON.stringify(assets)};
const COUNT_KEYS = ["lexicalExclusion","explicitUnit","valueAnchor","typeOnly","if","loop","case","catch","ternary","logicalAnd","logicalOr","nullish","logicalAndAssign","logicalOrAssign","nullishAssign"];
const encoder = new TextEncoder();
const decisionNames = {"if":"if","loop":"loop","case":"case","catch":"catch","ternary":"ternary","logical-and":"logicalAnd","logical-or":"logicalOr","nullish":"nullish","logical-and-assign":"logicalAndAssign","logical-or-assign":"logicalOrAssign","nullish-assign":"nullishAssign"};
const kindName = (observation) => observation.kind === "lexical-exclusion" ? "lexicalExclusion" : observation.kind === "explicit-unit" ? "explicitUnit" : observation.kind === "value-anchor" ? "valueAnchor" : observation.kind === "type-only" ? "typeOnly" : decisionNames[observation.decisionKind];
const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map((byte) => byte.toString(16).padStart(2,"0")).join("");
const emptyCounts = () => Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
const tupleDigest = async (tuples) => digest(JSON.stringify(tuples));
const tuplesFrom = (observations) => observations.map((observation) => [kindName(observation), observation.startByte, observation.endByte]);
const countsFrom = (observations) => { const counts=emptyCounts(); for(const observation of observations) counts[kindName(observation)] += 1; return counts; };
const summary = async (analysis) => ({
  S: analysis.S,
  U: analysis.U,
  unitForms: analysis.units.map((unit) => unit.kind),
  unitByteSpans: analysis.units.map((unit) => unit.kind === "top-level" ? null : [unit.startByte, unit.endByte]),
  observationKindCounts: countsFrom(analysis.observations),
  observationOrderDigest: await tupleDigest(tuplesFrom(analysis.observations)),
});
const expectedSummary = async ({S,U,tuples,unitForms=["top-level"],unitByteSpans=[null]}) => ({S,U,unitForms,unitByteSpans,observationKindCounts:(()=>{const c=emptyCounts();for(const tuple of tuples)c[tuple[0]]+=1;return c;})(),observationOrderDigest:await tupleDigest(tuples)});

function resources() {
  const live={parser:0,tree:0,cursor:0,observationStream:0};
  const peak={parser:0,tree:0,cursor:0,source:1,observationStream:0};
  const cleanup={parserDeletes:0,treeDeletes:0,cursorDeletes:0,sourceReleases:0,observationStreamReleases:0};
  const names={"parser-created":["parser",1],"parser-deleted":["parser",-1],"tree-created":["tree",1],"tree-deleted":["tree",-1],"cursor-created":["cursor",1],"cursor-deleted":["cursor",-1],"observation-stream-created":["observationStream",1],"observation-stream-released":["observationStream",-1]};
  return {live,peak,cleanup,event(event){const x=names[event];if(!x)return;live[x[0]]+=x[1];peak[x[0]]=Math.max(peak[x[0]],live[x[0]]);if(event==="parser-deleted")cleanup.parserDeletes++;if(event==="tree-deleted")cleanup.treeDeletes++;if(event==="cursor-deleted")cleanup.cursorDeletes++;if(event==="observation-stream-released")cleanup.observationStreamReleases++;},application(event){if(event==="source-released")cleanup.sourceReleases++;}};
}
function createParser(tracker) { return createTreeSitterAdapter({runtimeJavaScript:ASSETS[0].url,runtimeWasm:ASSETS[1].url,grammarJavaScript:ASSETS[2].url,grammarTypeScript:ASSETS[3].url,grammarTsx:ASSETS[4].url},{importRuntime:()=>globalThis.__codeCityRuntimePromise,observeResource:(event)=>tracker.event(event)}); }

const MAX=2097152;
const core="(".repeat(100000)+"0"+")".repeat(100000);
const nesting=core+"//"+"p".repeat(MAX-core.length-2);
const million=";".repeat(1000000);
const longString='"'+"x".repeat(MAX-3)+'";';
const commentOnly="//"+"c".repeat(MAX-2);
const tsType="type X="+"(".repeat(10000)+"string"+")".repeat(10000)+";";
const tsx="<A>".repeat(10000)+"x"+"</A>".repeat(10000)+";";
const millionTuples=Array.from({length:1000000},(_,index)=>["valueAnchor",index,index+1]);
const tsxTuples=[["valueAnchor",0,tsx.length],...Array.from({length:10000},(_,index)=>["valueAnchor",3*index,70001-4*index])];
const cases=[
  {id:"js-nesting-100000",family:"javascript-no-jsx",path:"stress.js",source:nesting,tuples:[["valueAnchor",0,MAX],["lexicalExclusion",core.length,MAX]],S:1,U:1},
  {id:"js-million-empty-statements",family:"javascript-no-jsx",path:"stress.js",source:million,tuples:millionTuples,S:1,U:1},
  {id:"js-long-string",family:"javascript-no-jsx",path:"stress.js",source:longString,tuples:[["valueAnchor",0,MAX]],S:1,U:1},
  {id:"js-comment-only",family:"javascript-no-jsx",path:"stress.js",source:commentOnly,tuples:[["lexicalExclusion",0,MAX]],S:0,U:0,unitForms:[],unitByteSpans:[]},
  {id:"ts-type-nesting-10000",family:"typescript",path:"stress.ts",source:tsType,tuples:[["typeOnly",0,tsType.length]],S:1,U:0,unitForms:[],unitByteSpans:[]},
  {id:"tsx-elements-10000",family:"tsx",path:"stress.tsx",source:tsx,tuples:tsxTuples,S:1,U:1},
];

const outputCases=[];
for(const item of cases){
  console.log("browser-evidence:start:"+item.id);
  const tracker=resources();
  const parser=createParser(tracker);
  const result=await processAdmittedBaseMetrics([{canonicalPath:item.path,normalizedSource:item.source}],parser,(event)=>tracker.application(event));
  if(result.kind!=="processed") throw new Error(item.id+" failed");
  const expected=await expectedSummary(item);
  const observed=await summary(result.analyses[0]);
  const expectedDigest=await digest(JSON.stringify(expected));
  const observedDigest=await digest(JSON.stringify(observed));
  const cleanup={parserDeletes:tracker.cleanup.parserDeletes,treeDeletes:tracker.cleanup.treeDeletes,cursorDeletes:tracker.cleanup.cursorDeletes,sourceReleases:tracker.cleanup.sourceReleases,observationStreamReleases:tracker.cleanup.observationStreamReleases};
  const pass=JSON.stringify(expected)===JSON.stringify(observed)&&expectedDigest===observedDigest&&JSON.stringify(cleanup)===JSON.stringify({parserDeletes:1,treeDeletes:1,cursorDeletes:2,sourceReleases:1,observationStreamReleases:1});
  outputCases.push({id:item.id,family:item.family,inputUtf8Bytes:encoder.encode(item.source).byteLength,expected,observed,expectedDigest,observedDigest,cleanup,pass});
  console.log("browser-evidence:done:"+item.id);
}

const matrixPaths=[];
for(let index=0;index<4000;index++){
  const suffix=["js","jsx","ts","tsx"][index%4];
  matrixPaths.push("matrix/"+String(index).padStart(4,"0")+"."+suffix);
}
const factsText=matrixPaths.map((canonicalPath)=>canonicalPath+"\\t0\\t0\\n").join("");
const factsDigest=await digest(factsText);
const expectedMatrix={totalS:0,totalU:0,totalUnits:0,totalDecisionObservations:0,totalObservations:20,factsDigest};
const matrixRuns=[];
for(let run=0;run<2;run++){
  console.log("browser-evidence:start:matrix:"+run);
  const tracker=resources();
  const parser=createParser(tracker);
  const matrixModules=matrixPaths.map((canonicalPath,index)=>({canonicalPath,normalizedSource:index<20?commentOnly:""}));
  const result=await processAdmittedBaseMetrics(matrixModules,parser,(event)=>tracker.application(event));
  if(result.kind!=="processed"||result.analyses.length!==4000)throw new Error("matrix failed");
  const facts=result.analyses.map((analysis)=>analysis.canonicalPath+"\\t"+analysis.S+"\\t"+analysis.U+"\\n").join("");
  const observed={totalS:result.analyses.reduce((n,a)=>n+a.S,0),totalU:result.analyses.reduce((n,a)=>n+a.U,0),totalUnits:result.analyses.reduce((n,a)=>n+a.units.length,0),totalDecisionObservations:result.analyses.reduce((n,a)=>n+a.observations.filter((o)=>o.kind==="decision").length,0),totalObservations:result.analyses.reduce((n,a)=>n+a.observations.length,0),factsDigest:await digest(facts)};
  const peakLive={parser:tracker.peak.parser,tree:tracker.peak.tree,cursor:tracker.peak.cursor,source:1,observationStream:tracker.peak.observationStream};
  const cleanup={parserDeletes:tracker.cleanup.parserDeletes,treeDeletes:tracker.cleanup.treeDeletes,cursorDeletes:tracker.cleanup.cursorDeletes,sourceReleases:tracker.cleanup.sourceReleases,observationStreamReleases:tracker.cleanup.observationStreamReleases};
  const ordered={modules:4000,normalizedBytes:41943040,observed,peakLive,cleanup};
  const runDigest=await digest(JSON.stringify(ordered));
  const pass=JSON.stringify(expectedMatrix)===JSON.stringify(observed)&&JSON.stringify(peakLive)===JSON.stringify({parser:1,tree:1,cursor:1,source:1,observationStream:1})&&JSON.stringify(cleanup)===JSON.stringify({parserDeletes:4000,treeDeletes:4000,cursorDeletes:8000,sourceReleases:4000,observationStreamReleases:4000});
  matrixRuns.push({modules:4000,normalizedBytes:41943040,expected:expectedMatrix,observed,peakLive,cleanup,runDigest,pass});
  console.log("browser-evidence:done:matrix:"+run);
}
const assetRequests=ASSETS.map(({role,path,sha256})=>({role,path,sha256}));
const result={schemaVersion:1,assetRequests,cases:outputCases,matrixRuns,browserExceptions:[],unexpectedNetworkRequests:[],overallPass:outputCases.every((entry)=>entry.pass)&&matrixRuns.every((entry)=>entry.pass)&&matrixRuns[0].runDigest===matrixRuns[1].runDigest};
document.querySelector("#result").textContent=JSON.stringify(result);
`;
}
