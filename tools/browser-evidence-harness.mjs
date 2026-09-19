export function createBrowserHarnessSource({ projectRootUrl, assets }) {
  return `
import { createTreeSitterAdapter } from ${JSON.stringify(`${projectRootUrl}src/edge/tree-sitter-adapter.ts`)};
import { processAdmittedBaseMetrics } from ${JSON.stringify(`${projectRootUrl}src/application/base-metric-processing.ts`)};
import { deriveBaseMetricAnalysis } from ${JSON.stringify(`${projectRootUrl}src/domain/base-metrics.ts`)};
import { buildCity } from ${JSON.stringify(`${projectRootUrl}src/domain/city-model.ts`)};
import { validateCityPayload } from ${JSON.stringify(`${projectRootUrl}src/application/city-payload.ts`)};
import { createCityPresenter } from ${JSON.stringify(`${projectRootUrl}src/edge/city-presenter.ts`)};
import { stageSemanticPublication } from ${JSON.stringify(`${projectRootUrl}src/edge/semantic-publication.ts`)};

const shellStyles=document.createElement("link");
shellStyles.rel="stylesheet";
shellStyles.href=${JSON.stringify(`${projectRootUrl}src/edge/shell.css`)};
document.head.append(shellStyles);
await new Promise((resolve,reject)=>{shellStyles.addEventListener("load",resolve,{once:true});shellStyles.addEventListener("error",reject,{once:true});});
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
  const live={parser:0,tree:0,cursor:0,source:0,observationStream:0};
  const peak={parser:0,tree:0,cursor:0,source:0,observationStream:0};
  const cleanup={parserDeletes:0,treeDeletes:0,cursorDeletes:0,sourceReleases:0,observationStreamReleases:0};
  const names={"parser-created":["parser",1],"parser-deleted":["parser",-1],"tree-created":["tree",1],"tree-deleted":["tree",-1],"cursor-created":["cursor",1],"cursor-deleted":["cursor",-1],"observation-stream-created":["observationStream",1],"observation-stream-released":["observationStream",-1]};
  return {live,peak,cleanup,event(event){const x=names[event];if(!x)return;live[x[0]]+=x[1];if(live[x[0]]<0)throw new Error("resource release without acquisition: "+event);peak[x[0]]=Math.max(peak[x[0]],live[x[0]]);if(event==="parser-deleted")cleanup.parserDeletes++;if(event==="tree-deleted")cleanup.treeDeletes++;if(event==="cursor-deleted")cleanup.cursorDeletes++;if(event==="observation-stream-released")cleanup.observationStreamReleases++;},application(event){if(event==="source-acquired"){live.source++;peak.source=Math.max(peak.source,live.source);}if(event==="source-released"){live.source--;if(live.source<0)throw new Error("source release without acquisition");cleanup.sourceReleases++;}}};
}
function createParser(tracker) { return createTreeSitterAdapter({runtimeJavaScript:ASSETS[0].url,runtimeWasm:ASSETS[1].url,grammarJavaScript:ASSETS[2].url,grammarTypeScript:ASSETS[3].url,grammarTsx:ASSETS[4].url},{importRuntime:()=>globalThis.__codeCityRuntimePromise,observeResource:(event)=>tracker.event(event)}); }
function createInspectingParser(tracker,path,observed) { const parser=createParser(tracker); return {initialize:()=>parser.initialize(),async project(family,source){const stream=await parser.project(family,source);observed.push(await summary(deriveBaseMetricAnalysis(path,source,stream.observations)));return stream;}}; }
function createRecordingParser(tracker,observed) { const parser=createParser(tracker); return {initialize:()=>parser.initialize(),async project(family,source){const stream=await parser.project(family,source);let decisions=0;for(const observation of stream.observations)if(observation.kind==="decision")decisions++;observed.push({observationCount:stream.observations.length,decisionObservationCount:decisions,observationPackedByteLength:stream.observations.packedByteLength()});return stream;}}; }

const MAX=2097152;
const core="(".repeat(100000)+"0"+")".repeat(100000);
const nesting=core+"//"+"p".repeat(MAX-core.length-2);
const million=";".repeat(1000000);
const longString='"'+"x".repeat(MAX-3)+'";';
const commentOnly="//"+"c".repeat(MAX-2);
const typeQueryCall="importOriginal<typeof import('./module')>();";
const typeQueryGlrStress=typeQueryCall+"//"+"g".repeat(MAX-typeQueryCall.length-2);
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
  {id:"ts-type-query-import-glr-2mib",family:"typescript",path:"stress.ts",source:typeQueryGlrStress,tuples:[["valueAnchor",0,typeQueryCall.length],["lexicalExclusion",typeQueryCall.length,MAX]],S:1,U:1},
  {id:"tsx-elements-10000",family:"tsx",path:"stress.tsx",source:tsx,tuples:tsxTuples,S:1,U:1},
];

const outputCases=[];
for(const item of cases){
  console.log("browser-evidence:start:"+item.id);
  const tracker=resources();
  const inspected=[];
  const parser=createInspectingParser(tracker,item.path,inspected);
  const result=await processAdmittedBaseMetrics([{canonicalPath:item.path,normalizedSource:item.source}],parser,(event)=>tracker.application(event));
  if(result.kind!=="processed"||result.facts.length!==1) throw new Error(item.id+" failed");
  const expected=await expectedSummary(item);
  const observed=inspected[0];
  const expectedDigest=await digest(JSON.stringify(expected));
  const observedDigest=await digest(JSON.stringify(observed));
  const cleanup={parserDeletes:tracker.cleanup.parserDeletes,treeDeletes:tracker.cleanup.treeDeletes,cursorDeletes:tracker.cleanup.cursorDeletes,sourceReleases:tracker.cleanup.sourceReleases,observationStreamReleases:tracker.cleanup.observationStreamReleases};
  const pass=JSON.stringify(expected)===JSON.stringify(observed)&&expectedDigest===observedDigest&&result.facts[0].S===item.S&&result.facts[0].U===item.U&&Object.keys(result.facts[0]).join(",")==="canonicalPath,S,U,M"&&JSON.stringify(cleanup)===JSON.stringify({parserDeletes:1,treeDeletes:1,cursorDeletes:2,sourceReleases:1,observationStreamReleases:1})&&Object.values(tracker.live).every((count)=>count===0)&&tracker.peak.source===1;
  outputCases.push({id:item.id,family:item.family,inputUtf8Bytes:encoder.encode(item.source).byteLength,expected,observed,expectedDigest,observedDigest,cleanup,pass});
  console.log("browser-evidence:done:"+item.id);
}

for(const item of [
  {family:"typescript",path:"malformed.ts",source:typeQueryCall+" }"},
  {family:"tsx",path:"malformed.tsx",source:"const view=<A/>; "+typeQueryCall+" </B>"},
]){
  const tracker=resources();
  const result=await processAdmittedBaseMetrics([{canonicalPath:item.path,normalizedSource:item.source}],createParser(tracker),(event)=>tracker.application(event));
  if(JSON.stringify(result)!==JSON.stringify({kind:"failure",category:"Metric processing failed",code:"M1-MET-1"})||!Object.values(tracker.live).every((count)=>count===0)||JSON.stringify(tracker.cleanup)!==JSON.stringify({parserDeletes:1,treeDeletes:1,cursorDeletes:1,sourceReleases:1,observationStreamReleases:0}))throw new Error("patched grammar malformed rejection changed: "+item.family);
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
  const finalized=[];
  const parser=createRecordingParser(tracker,finalized);
  const matrixModules=matrixPaths.map((canonicalPath,index)=>({canonicalPath,normalizedSource:index<20?commentOnly:""}));
  const result=await processAdmittedBaseMetrics(matrixModules,parser,(event)=>tracker.application(event));
  if(result.kind!=="processed"||result.facts.length!==4000)throw new Error("matrix failed");
  const facts=result.facts.map((fact)=>fact.canonicalPath+"\\t"+fact.S+"\\t"+fact.U+"\\n").join("");
  const observed={totalS:result.facts.reduce((n,a)=>n+a.S,0),totalU:result.facts.reduce((n,a)=>n+a.U,0),totalUnits:result.facts.reduce((n,a)=>n+a.U,0),totalDecisionObservations:finalized.reduce((n,a)=>n+a.decisionObservationCount,0),totalObservations:finalized.reduce((n,a)=>n+a.observationCount,0),factsDigest:await digest(facts)};
  const peakLive={parser:tracker.peak.parser,tree:tracker.peak.tree,cursor:tracker.peak.cursor,source:tracker.peak.source,observationStream:tracker.peak.observationStream};
  const cleanup={parserDeletes:tracker.cleanup.parserDeletes,treeDeletes:tracker.cleanup.treeDeletes,cursorDeletes:tracker.cleanup.cursorDeletes,sourceReleases:tracker.cleanup.sourceReleases,observationStreamReleases:tracker.cleanup.observationStreamReleases};
  const ordered={modules:4000,normalizedBytes:41943040,observed,peakLive,cleanup};
  const runDigest=await digest(JSON.stringify(ordered));
  const pass=JSON.stringify(expectedMatrix)===JSON.stringify(observed)&&JSON.stringify(peakLive)===JSON.stringify({parser:1,tree:1,cursor:1,source:1,observationStream:1})&&JSON.stringify(cleanup)===JSON.stringify({parserDeletes:4000,treeDeletes:4000,cursorDeletes:8000,sourceReleases:4000,observationStreamReleases:4000})&&Object.values(tracker.live).every((count)=>count===0);
  matrixRuns.push({modules:4000,normalizedBytes:41943040,expected:expectedMatrix,observed,peakLive,cleanup,runDigest,pass});
  console.log("browser-evidence:done:matrix:"+run);
}
const complexityPaths=[];
for(let index=0;index<4000;index++){
  const suffix=["js","jsx","ts","tsx"][index%4];
  complexityPaths.push("complexity/"+String(index).padStart(4,"0")+"."+suffix);
}
const dense="a&&a; ".repeat(349525)+";;";
if(encoder.encode(dense).byteLength!==2097152)throw new Error("complexity dense source size changed");
const complexityFactsText=complexityPaths.map((canonicalPath,index)=>canonicalPath+"\\t"+(index<20?1:0)+"\\t"+(index<20?1:0)+"\\t"+(index<20?349526:0)+"\\n").join("");
const complexityFactsDigest=await digest(complexityFactsText);
const expectedComplexity={totalS:20,totalU:20,totalM:6990520,totalDecisionObservations:6990500,factsDigest:complexityFactsDigest};
const complexityMatrixRuns=[];
for(let run=0;run<2;run++){
  console.log("browser-evidence:start:complexity-matrix:"+run);
  const tracker=resources();
  const finalized=[];
  const parser=createRecordingParser(tracker,finalized);
  const modules=complexityPaths.map((canonicalPath,index)=>({canonicalPath,normalizedSource:index<20?dense:""}));
  const processing=await processAdmittedBaseMetrics(modules,parser,(event)=>tracker.application(event));
  if(processing.kind!=="processed"||processing.facts.length!==4000)throw new Error("complexity matrix failed");
  const facts=processing.facts.map((fact)=>fact.canonicalPath+"\\t"+fact.S+"\\t"+fact.U+"\\t"+fact.M+"\\n").join("");
  const observed={totalS:processing.facts.reduce((n,a)=>n+a.S,0),totalU:processing.facts.reduce((n,a)=>n+a.U,0),totalM:processing.facts.reduce((n,a)=>n+a.M,0),totalDecisionObservations:finalized.reduce((n,a)=>n+a.decisionObservationCount,0),factsDigest:await digest(facts)};
  const densePackedByteLength=finalized[0].observationPackedByteLength;
  const peakLive={parser:tracker.peak.parser,tree:tracker.peak.tree,cursor:tracker.peak.cursor,source:tracker.peak.source,observationStream:tracker.peak.observationStream};
  const cleanup={parserDeletes:tracker.cleanup.parserDeletes,treeDeletes:tracker.cleanup.treeDeletes,cursorDeletes:tracker.cleanup.cursorDeletes,sourceReleases:tracker.cleanup.sourceReleases,observationStreamReleases:tracker.cleanup.observationStreamReleases};
  const retainedOnlyFinalFacts=processing.facts.every((fact)=>Object.keys(fact).join(",")==="canonicalPath,S,U,M")&&finalized.length===4000;
  const ordered={modules:4000,normalizedBytes:41943040,observed,densePackedByteLength,peakLive,cleanup,retainedOnlyFinalFacts};
  const runDigest=await digest(JSON.stringify(ordered));
  const pass=JSON.stringify(expectedComplexity)===JSON.stringify(observed)&&complexityFactsDigest==="f2ec54ea39565022686f3d17d07360570b1ebf6d097ca4254f95700bd0a520d4"&&densePackedByteLength>0&&finalized.slice(0,20).every((entry)=>entry.decisionObservationCount===349525&&entry.observationPackedByteLength===densePackedByteLength)&&finalized.slice(20).every((entry)=>entry.decisionObservationCount===0&&entry.observationPackedByteLength===0)&&JSON.stringify(peakLive)===JSON.stringify({parser:1,tree:1,cursor:1,source:1,observationStream:1})&&JSON.stringify(cleanup)===JSON.stringify({parserDeletes:4000,treeDeletes:4000,cursorDeletes:8000,sourceReleases:4000,observationStreamReleases:4000})&&Object.values(tracker.live).every((count)=>count===0)&&retainedOnlyFinalFacts;
  complexityMatrixRuns.push({modules:4000,normalizedBytes:41943040,expected:expectedComplexity,observed,densePackedByteLength,peakLive,cleanup,retainedOnlyFinalFacts,runDigest,pass});
  console.log("browser-evidence:done:complexity-matrix:"+run);
}
function exactClip(matrix,corner,column){const a=Math.fround(Math.fround(matrix[column])*Math.fround(corner[0]));const b=Math.fround(Math.fround(matrix[column+4])*Math.fround(corner[1]));const c=Math.fround(Math.fround(matrix[column+8])*Math.fround(corner[2]));const d=Math.fround(matrix[column+12]);const first=Math.fround(a+b);const second=Math.fround(first+c);const result=Math.fround(second+d);if(![a,b,c,d,first,second,result].every(Number.isFinite))throw new Error("maximum non-finite clip arithmetic");return result;}
function matrixOracle(matrix,bounds,centre,lateralFit){
  if(!Array.isArray(matrix)||matrix.length!==16)throw new Error("maximum matrix missing");
  let corners=0;
  for(const x of [bounds[0],bounds[3]])for(const y of [bounds[1],bounds[4]])for(const z of [bounds[2],bounds[5]]){
    const corner=[x-centre[0],y-centre[1],z-centre[2]];const clipX=exactClip(matrix,corner,0);const clipY=exactClip(matrix,corner,1);const clipZ=exactClip(matrix,corner,2);const clipW=exactClip(matrix,corner,3);const depth=Math.fround(clipZ/clipW);
    if(!(clipW>0&&depth>-1&&depth<1))throw new Error("maximum strict W/depth oracle failed");
    if(lateralFit&&!(-1<clipX/clipW&&clipX/clipW<1&&-1<clipY/clipW&&clipY/clipW<1))throw new Error("maximum overview framing failed");
    corners++;
  }
  return {corners,positiveW:true,strictDepth:true,lateralFit};
}
function maximumGeometryOracle(city,buildingUpload,plateUpload){
  const count=city.geometry.count;const origins=[...city.geometry.origins];const sizes=[...city.geometry.sizes];
  const sourceBounds=[Math.min(...Array.from({length:count},(_,i)=>origins[i*3])),Math.min(...Array.from({length:count},(_,i)=>origins[i*3+1])),Math.min(...Array.from({length:count},(_,i)=>origins[i*3+2])),Math.max(...Array.from({length:count},(_,i)=>origins[i*3]+sizes[i*3])),Math.max(...Array.from({length:count},(_,i)=>origins[i*3+1]+sizes[i*3+1])),Math.max(...Array.from({length:count},(_,i)=>origins[i*3+2]+sizes[i*3+2]))];
  if(JSON.stringify(sourceBounds)!==JSON.stringify([...city.geometry.bounds]))throw new Error("maximum source bounds changed");
  const cells=Array.from({length:count},(_,index)=>({minimum:[origins[index*3]-3,-0.5,origins[index*3+2]-3],dimensions:[sizes[index*3]+6,0.5,sizes[index*3+2]+6]}));
  const sceneBounds=[Math.min(sourceBounds[0],...cells.map(cell=>cell.minimum[0])),Math.min(sourceBounds[1],...cells.map(cell=>cell.minimum[1])),Math.min(sourceBounds[2],...cells.map(cell=>cell.minimum[2])),Math.max(sourceBounds[3],...cells.map(cell=>cell.minimum[0]+cell.dimensions[0])),Math.max(sourceBounds[4],...cells.map(cell=>cell.minimum[1]+cell.dimensions[1])),Math.max(sourceBounds[5],...cells.map(cell=>cell.minimum[2]+cell.dimensions[2]))];
  const centre=[(sceneBounds[0]+sceneBounds[3])/2,(sceneBounds[1]+sceneBounds[4])/2,(sceneBounds[2]+sceneBounds[5])/2];
  const buildingBytes=Uint8Array.from(buildingUpload);const buildingView=new DataView(buildingBytes.buffer);const plateBytes=Uint8Array.from(plateUpload);const plateView=new DataView(plateBytes.buffer);
  if(buildingUpload.length!==count*28||plateUpload.length!==count*24)throw new Error("maximum instance byte count changed");
  for(let index=0;index<count;index++)for(let axis=0;axis<3;axis++){
    if(buildingView.getFloat32(index*28+axis*4,true)!==Math.fround(origins[index*3+axis]-centre[axis]))throw new Error("maximum building shared centre changed");
    if(buildingView.getFloat32(index*28+12+axis*4,true)!==sizes[index*3+axis])throw new Error("maximum building dimensions changed");
    if(plateView.getFloat32(index*24+axis*4,true)!==Math.fround(cells[index].minimum[axis]-centre[axis]))throw new Error("maximum exact plate minimum changed");
    if(plateView.getFloat32(index*24+12+axis*4,true)!==cells[index].dimensions[axis])throw new Error("maximum exact plate dimensions changed");
  }
  const boxes=Array.from({length:count},(_,index)=>({index,origin:origins.slice(index*3,index*3+3),size:sizes.slice(index*3,index*3+3)}));
  return {sourceBounds,sceneBounds,centre,cells,boxes};
}
function maximumProjectionOracle(matrix,geometry,dimensions,inspector){
  if(!Number.isInteger(dimensions.width)||dimensions.width<=0||!Number.isInteger(dimensions.height)||dimensions.height<=0)throw new Error("maximum oracle dimensions changed");
  const project=(world)=>{
    const relative=world.map((component,axis)=>component-geometry.centre[axis]);
    if(!relative.every((component)=>Number.isFinite(component)&&Math.fround(component)===component))throw new Error("maximum district coordinate changed");
    const clip=[0,1,2,3].map((column)=>exactClip(matrix,relative,column));
    if(!(clip[3]>0))throw new Error("maximum district W oracle failed");
    const ndcX=Math.fround(clip[0]/clip[3]);const ndcY=Math.fround(clip[1]/clip[3]);const depth=Math.fround(clip[2]/clip[3]);
    if(![ndcX,ndcY,depth].every(Number.isFinite)||!(-1<depth&&depth<1))throw new Error("maximum district quotient oracle failed");
    const screenX=(ndcX*0.5+0.5)*dimensions.width;const screenY=(-ndcY*0.5+0.5)*dimensions.height;
    if(![screenX,screenY].every(Number.isFinite))throw new Error("maximum district screen oracle failed");
    return {screenX,screenY,ndcX,ndcY};
  };
  const projected=geometry.cells.map((cell)=>{
    const x0=cell.minimum[0];const x1=x0+cell.dimensions[0];const z0=cell.minimum[2];const z1=z0+cell.dimensions[2];
    const anchor=project([(x0+x1)/2,0,(z0+z1)/2]);
    const corners=[[x0,0,z0],[x1,0,z0],[x0,0,z1],[x1,0,z1]].map(project);
    const xs=corners.map(({screenX})=>screenX);const ys=corners.map(({screenY})=>screenY);
    const area=(Math.max(...xs)-Math.min(...xs))*(Math.max(...ys)-Math.min(...ys));
    if(!Number.isFinite(area))throw new Error("maximum district area oracle failed");
    return {screenX:anchor.screenX,screenY:anchor.screenY,area,lateral:-1<anchor.ndcX&&anchor.ndcX<1&&-1<anchor.ndcY&&anchor.ndcY<1};
  });
  const width=dimensions.width>=480?144:104;const height=20;
  const boxes=projected.map((district,index)=>({index,area:district.area,left:district.screenX-width/2,top:district.screenY-height/2,right:district.screenX+width/2,bottom:district.screenY+height/2,lateral:district.lateral}));
  const overlaps=(left,right)=>left.left<right.right&&right.left<left.right&&left.top<right.bottom&&right.top<left.bottom;
  const exclusion=inspector?{left:inspector.left-4,top:inspector.top-4,right:inspector.left+inspector.width+4,bottom:inspector.top+inspector.height+4}:undefined;
  const eligible=[];const categories=Array(projected.length).fill("offscreen");let offscreen=0;let inspectorRejected=0;
  for(const box of boxes){
    if(!box.lateral||!(box.left<dimensions.width&&box.right>0&&box.top<dimensions.height&&box.bottom>0)){offscreen++;continue;}
    if(exclusion&&overlaps(box,exclusion)){categories[box.index]="inspector";inspectorRejected++;continue;}
    categories[box.index]="collision";eligible.push(box);
  }
  eligible.sort((left,right)=>right.area-left.area||left.index-right.index);
  const accepted=[];let collision=0;
  for(const box of eligible){const inflated={left:box.left-2,top:box.top-2,right:box.right+2,bottom:box.bottom+2};if(accepted.some((candidate)=>overlaps(inflated,candidate))){collision++;continue;}accepted.push(inflated);categories[box.index]="visible";}
  const counts={projected:projected.length,admitted:eligible.length,collision,offscreen,inspector:inspectorRejected,visible:accepted.length};
  if(counts.visible+counts.collision!==counts.admitted||counts.admitted+counts.offscreen+counts.inspector!==counts.projected)throw new Error("maximum oracle count partition changed");
  return {projected,categories,width,counts};
}
function maximumLabelState(host,canvas,snapshot,matrix,geometry){
  const overlay=host.querySelector("[data-district-labels]");const labels=[...overlay.children];const overlayRect=overlay.getBoundingClientRect();const canvasRect=canvas.getBoundingClientRect();const inspector=host.querySelector("[data-inspector]");const inspectorRect=inspector.hidden?undefined:inspector.getBoundingClientRect();
  const localInspector=inspectorRect?{left:inspectorRect.left-overlayRect.left,top:inspectorRect.top-overlayRect.top,width:inspectorRect.width,height:inspectorRect.height}:undefined;
  const dimensions={width:snapshot.cssWidth,height:snapshot.cssHeight};const oracle=maximumProjectionOracle(matrix,geometry,dimensions,localInspector);
  if(snapshot.districts.length!==oracle.projected.length||labels.length!==oracle.projected.length)throw new Error("maximum label alignment changed");
  let exactPositions=true;let exactVisibility=true;
  for(let index=0;index<oracle.projected.length;index++){
    const expected=oracle.projected[index];const observed=snapshot.districts[index];
    if(Object.keys(observed).join(",")!=="screenX,screenY,area,lateral"||observed.screenX!==expected.screenX||observed.screenY!==expected.screenY||observed.area!==expected.area||observed.lateral!==expected.lateral)throw new Error("maximum projection mismatch index="+index+" expected="+JSON.stringify(expected)+" observed="+JSON.stringify(observed));
    const expectedTransform=document.createElement("div");expectedTransform.style.transform="translate("+(expected.screenX-oracle.width/2)+"px, "+(expected.screenY-10)+"px)";
    const shouldHide=oracle.categories[index]!=="visible";
    if(labels[index].hidden!==shouldHide||labels[index].style.width!==oracle.width+"px"||labels[index].style.transform!==expectedTransform.style.transform)throw new Error("maximum layout mismatch index="+index+" expected="+JSON.stringify({hidden:shouldHide,width:oracle.width+"px",transform:expectedTransform.style.transform,category:oracle.categories[index]})+" observed="+JSON.stringify({hidden:labels[index].hidden,width:labels[index].style.width,transform:labels[index].style.transform}));
  }
  return {dom:labels.length,width:oracle.width+"px",overlayMatchesCanvas:overlayRect.left===canvasRect.left&&overlayRect.top===canvasRect.top&&overlayRect.width===canvasRect.width&&overlayRect.height===canvasRect.height,pointerEvents:getComputedStyle(overlay).pointerEvents,counts:oracle.counts,exactPositions,exactVisibility};
}
function maximumPickAtPoint(matrix,geometry,rectangle,point){
  const directionRow=[-matrix[3],-matrix[7],-matrix[11]];const directionLength=Math.hypot(...directionRow);const D=directionRow.map((component)=>component/directionLength);
  const rightRow=[matrix[0],matrix[4],matrix[8]];const fx=Math.hypot(...rightRow);const R=rightRow.map((component)=>component/fx);
  const verticalRow=[matrix[1],matrix[5],matrix[9]];const fy=Math.hypot(...verticalRow);const V=verticalRow.map((component)=>component/fy);
  const dr=matrix[12]/fx;const dv=matrix[13]/fy;const camera=geometry.centre.map((component,axis)=>component-dr*R[axis]-dv*V[axis]+matrix[15]*D[axis]);
  const nx=2*(point.x-rectangle.left)/rectangle.width-1;const ny=1-2*(point.y-rectangle.top)/rectangle.height;
  const direction=D.map((component,axis)=>-component+nx/fx*R[axis]+ny/fy*V[axis]);let nearest=null;
  for(const box of geometry.boxes){let minimum=Number.NEGATIVE_INFINITY;let maximum=Number.POSITIVE_INFINITY;let misses=false;for(let axis=0;axis<3;axis++){const lower=box.origin[axis];const upper=lower+box.size[axis];if(direction[axis]===0){if(camera[axis]<lower||camera[axis]>upper){misses=true;break;}continue;}const first=(lower-camera[axis])/direction[axis];const second=(upper-camera[axis])/direction[axis];minimum=Math.max(minimum,Math.min(first,second));maximum=Math.min(maximum,Math.max(first,second));if(minimum>maximum){misses=true;break;}}if(misses||maximum<0)continue;const distance=Math.max(0,minimum);if(nearest===null||distance<nearest.distance||(distance===nearest.distance&&box.index<nearest.index))nearest={index:box.index,distance};}
  return nearest?.index??null;
}
function maximumClickCases(matrix,geometry,snapshot){
  const dimensions={width:snapshot.cssWidth,height:snapshot.cssHeight};const rectangle={left:0,top:0,width:dimensions.width,height:dimensions.height};const oracle=maximumProjectionOracle(matrix,geometry,dimensions);const samples=[];
  for(let labelIndex=0;labelIndex<oracle.projected.length;labelIndex++){if(oracle.categories[labelIndex]!=="visible")continue;const projected=oracle.projected[labelIndex];const left=projected.screenX-oracle.width/2;const top=projected.screenY-10;for(const xf of [0.5,0.05,0.95,0.25,0.75])for(const yf of [0.5,0.15,0.85]){const point={x:left+oracle.width*xf,y:top+20*yf};if(point.x<=0||point.x>=dimensions.width||point.y<=0||point.y>=dimensions.height)continue;samples.push({point,index:maximumPickAtPoint(matrix,geometry,rectangle,point)});}}
  const hit=samples.find(({index})=>index!==null);const miss=samples.find(({index})=>index===null);if(!hit||!miss)throw new Error("maximum label click-through cases unavailable samples="+samples.length+" hits="+samples.filter(({index})=>index!==null).length+" misses="+samples.filter(({index})=>index===null).length);return {hit,miss};
}
function dispatchMaximumClick(canvas,point,pointerId){const down=new PointerEvent("pointerdown",{pointerId,button:0,buttons:1,clientX:point.x,clientY:point.y,bubbles:true,cancelable:true});const up=new PointerEvent("pointerup",{pointerId,button:0,buttons:0,clientX:point.x,clientY:point.y,bubbles:true,cancelable:true});canvas.dispatchEvent(down);canvas.dispatchEvent(up);return down.target===canvas&&up.target===canvas;}
function presentationPlatform(state,compileFailure=false){
  return {createCanvas(){
    const canvas=document.createElement("canvas");
    const addListener=canvas.addEventListener.bind(canvas);
    Object.defineProperty(canvas,"addEventListener",{value(type,listener,options){if(type==="webglcontextlost")state.lossCallbacks.push(listener);if(["webglcontextlost","keydown","wheel","pointerdown","pointermove","pointerup","pointercancel","pointerleave","lostpointercapture","contextmenu"].includes(type))state.listenerAdds.push(type);return addListener(type,listener,options);}});
    const removeListener=canvas.removeEventListener.bind(canvas);
    Object.defineProperty(canvas,"removeEventListener",{value(type,listener,options){if(["webglcontextlost","keydown","wheel","pointerdown","pointermove","pointerup","pointercancel","pointerleave","lostpointercapture","contextmenu"].includes(type))state.listenerRemoves.push(type);return removeListener(type,listener,options);}});
    const acquire=canvas.getContext.bind(canvas);
    Object.defineProperty(canvas,"getContext",{value(kind,attributes){
      const actual=acquire(kind,attributes);
      if(!actual)return null;
      state.actualContexts++;
      const programKinds=new Map();const vaoKinds=new Map();const uniformNames=new Map();
      let programCount=0;let vaoCount=0;let currentProgram=null;let currentVao=null;let currentPass=null;
      const programKind=(count)=>count===1?"city":"unexpected";
      const vaoKind=(count)=>count===1?"building":count===2?"plate":"unexpected";
      return new Proxy(actual,{get(target,property){
        if(property==="createProgram")return ()=>{const program=target.createProgram();if(program)programKinds.set(program,programKind(++programCount));return program;};
        if(property==="createVertexArray")return ()=>{const vao=target.createVertexArray();if(vao)vaoKinds.set(vao,vaoKind(++vaoCount));return vao;};
        if(property==="useProgram")return (program)=>{currentProgram=program;return target.useProgram(program);};
        if(property==="bindVertexArray")return (vao)=>{currentVao=vao;return target.bindVertexArray(vao);};
        if(property==="bufferData")return (kind,data,usage)=>{state.uploads.push(Array.from(new Uint8Array(data.buffer,data.byteOffset,data.byteLength)));return target.bufferData(kind,data,usage);};
        if(property==="bufferSubData")return (kind,offset,data)=>{state.subUploads.push(Array.from(new Uint8Array(data.buffer,data.byteOffset,data.byteLength)));return target.bufferSubData(kind,offset,data);};
        if(property==="getUniformLocation")return (program,name)=>{const location=target.getUniformLocation(program,name);if(location)uniformNames.set(location,name);return location;};
        if(property==="uniform1i")return (location,value)=>{const name=uniformNames.get(location);state.uniforms.push({name,value});if(name==="u_passKind")currentPass=value;return target.uniform1i(location,value);};
        if(property==="uniformMatrix4fv")return (location,transpose,matrix)=>{state.matrices.push(Array.from(matrix));return target.uniformMatrix4fv(location,transpose,matrix);};
        if(property==="shaderSource")return (shader,source)=>{state.shaderSources.push(source);return target.shaderSource(shader,source);};
        if(property==="drawElementsInstanced")return (...args)=>{const program=programKinds.get(currentProgram);const vao=vaoKinds.get(currentVao);const expectedVao=currentPass===0?"plate":currentPass===1?"building":"unexpected";if(program!=="city"||vao!==expectedVao||args[0]!==0x0004)throw new Error("Non-fill draw identity");state.draws++;state.operations.push(expectedVao);if(currentPass===1)state.drawUniforms.push(state.uniforms.filter(({name})=>name==="u_hoverIndex"||name==="u_selectionIndex").slice(-2).map(({name,value})=>({name,value})));return target.drawElementsInstanced(...args);};
        if(property==="disable")return (...args)=>{if(args[0]===0x0b71)state.operations.push("depth:off");return target.disable(...args);};
        if(property==="enable")return (...args)=>{if(args[0]===0x0b71)state.operations.push("depth:on");if(args[0]===0x8037)state.polygonOffsetEnables++;return target.enable(...args);};
        if(property==="isContextLost"&&state.contextLost)return ()=>true;
        if(property==="getShaderParameter")return (shader,pname)=>{const actualStatus=target.getShaderParameter(shader,pname);return compileFailure&&pname===0x8b81?false:actualStatus;};
        if(["deleteShader","deleteProgram","deleteBuffer","deleteVertexArray"].includes(property))return (...args)=>{state.deletes[property]++;return target[property](...args);};
        const value=Reflect.get(target,property,target);
        return typeof value==="function"?value.bind(target):value;
      }});
    }});
    state.canvases.push(canvas);
    return canvas;
  },createResizeObserver(callback){state.observerCallbacks.push(callback);return new ResizeObserver(callback);},
  requestAnimationFrame(callback){return window.requestAnimationFrame(callback);},
  cancelAnimationFrame(handle){window.cancelAnimationFrame(handle);},
  windowTarget(){return {addEventListener(type,listener,options){state.listenerAdds.push(type);return window.addEventListener(type,listener,options);},removeEventListener(type,listener,options){state.listenerRemoves.push(type);return window.removeEventListener(type,listener,options);}};},
  documentTarget(){return {get visibilityState(){return document.visibilityState;},addEventListener(type,listener,options){state.listenerAdds.push(type);return document.addEventListener(type,listener,options);},removeEventListener(type,listener,options){state.listenerRemoves.push(type);return document.removeEventListener(type,listener,options);}};}};
}
function presentationHost(width,height){
  const host=document.createElement("div");
  host.dataset.city="";
  host.style.position="relative";
  host.style.border="0";
  host.style.minHeight="0";
  const dimensions={};
  let currentWidth=width;let currentHeight=height;
  Object.defineProperties(dimensions,{width:{get:()=>currentWidth,set(value){currentWidth=value;host.style.width=value+"px";}},height:{get:()=>currentHeight,set(value){currentHeight=value;host.style.height=value+"px";}}});
  dimensions.width=width;dimensions.height=height;
  const reset=document.createElement("button");
  reset.type="button";
  reset.textContent="Reset view";
  let resetAdds=0,resetRemoves=0;
  const addReset=reset.addEventListener.bind(reset);
  const removeReset=reset.removeEventListener.bind(reset);
  Object.defineProperty(reset,"addEventListener",{value(type,listener,options){if(type==="click")resetAdds++;return addReset(type,listener,options);}});
  Object.defineProperty(reset,"removeEventListener",{value(type,listener,options){if(type==="click")resetRemoves++;return removeReset(type,listener,options);}});
  document.body.append(host,reset);
  return {host,dimensions,reset,resetEvidence:()=>({adds:resetAdds,removes:resetRemoves})};
}
const presentationCity=validateCityPayload(buildCity([{canonicalPath:"browser.js",S:1,U:1,M:1}]));
const presentationModel=presentationCity.geometry;
const emptyEventSink={hoverIndex(){},activationIndex(){},selectionAction(){},districtProjection(){}};
function stageCommit(presenter,host,generation,city=presentationCity,semantic=false,capture){
  const priorChildren=[...host.childNodes];
  const revision=document.createElement("output");
  const publication=semantic?stageSemanticPublication(document,host,revision,"a".repeat(40),city.inspection,city.districts):undefined;
  const eventSink=semantic?{...emptyEventSink,activationIndex(callbackGeneration,index){publication.setSelection(index);capture?.activations.push({generation:callbackGeneration,index});},districtProjection(_generation,snapshot){publication.districtProjection(snapshot);capture?.projections.push(snapshot);}}:emptyEventSink;
  const staged=presenter.stage(generation,city.geometry,city.presentation,eventSink);
  if(staged.kind!=="staged")return staged;
  if(capture)capture.staged=staged.snapshot;
  if(priorChildren.length!==host.childNodes.length||priorChildren.some((node,index)=>host.childNodes[index]!==node))throw new Error("Presenter stage was not detached");
  const committed=presenter.commit(staged.token);
  if(committed.kind!=="committed")return committed;
  if(capture)capture.committed=committed.snapshot;
  if(committed.snapshot!==staged.snapshot)throw new Error("Stage/commit projection handoff changed");
  if(presenter.setVisualState(generation,null,null).kind!=="applied")throw new Error("Initial visual state was not applied");
  if(publication){publication.commit(staged.canvas,committed.snapshot);host.__districtPublication=publication;}else host.replaceChildren(staged.canvas);
  return {kind:"committed"};
}
const presentation={webgl2Available:false,actualContexts:0,initialDraws:0,repeatDraws:0,resizeDraws:0,focus:null,maximum:null,accessibility:null,inputCleanup:null,lossDefaultPrevented:null,lossDraws:0,lossFailures:[],lossOrdering:null,lossCleanup:null,lossTerminalState:null,compileFailureResult:null,compileFailureDraws:0,compileFailures:[],compileCleanup:null,compileFailureTerminalState:null,pass:false};
const makeState=()=>({canvases:[],draws:0,actualContexts:0,observerCallbacks:[],lossCallbacks:[],listenerAdds:[],listenerRemoves:[],uploads:[],subUploads:[],uniforms:[],drawUniforms:[],matrices:[],shaderSources:[],operations:[],polygonOffsetEnables:0,contextLost:false,deletes:{deleteShader:0,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0}});
let focusPass=false;
let faceShadingPass=false;
{
  const holder=presentationHost(320,180);
  const state=makeState();
  const failures=[];
  const presenter=createCityPresenter({host:holder.host,resetControl:holder.reset,platform:presentationPlatform(state),isEligible:()=>true,failed:(...args)=>failures.push(args)});
  const first=stageCommit(presenter,holder.host,1);
  if(first.kind!=="committed")throw new Error("Installed Chrome WebGL2 is unavailable or rejected");
  presentation.webgl2Available=true;
  presentation.initialDraws=state.draws;
  const firstCanvas=state.canvases[0];
  if(firstCanvas.width!==320||firstCanvas.height!==180)throw new Error("Actual WebGL2 backing dimensions differ");
  presentation.accessibility={tabIndex:firstCanvas.tabIndex,label:firstCanvas.getAttribute("aria-label"),description:firstCanvas.getAttribute("aria-describedby"),listenerAdds:[...state.listenerAdds],resetText:holder.reset.textContent};
  const repeat=stageCommit(presenter,holder.host,2);
  presentation.repeatDraws=state.draws-presentation.initialDraws;
  const activeCanvas=state.canvases.at(-1);
  const immutableUploads=JSON.stringify(state.uploads);
  const transition=(hover,selection)=>{const before=state.draws;const uniformStart=state.uniforms.length;if(presenter.setVisualState(2,hover,selection).kind!=="applied")throw new Error("Actual WebGL2 surface focus failed");return {draws:state.draws-before,uniforms:state.uniforms.slice(uniformStart)};};
  const selection=transition(null,0);
  const same=transition(0,0);
  const hover=transition(0,null);
  const clear=transition(null,null);
  const beforeCamera=state.draws;activeCanvas.dispatchEvent(new KeyboardEvent("keydown",{key:"d",cancelable:true}));const camera={draws:state.draws-beforeCamera,uniforms:state.drawUniforms.at(-1)};
  holder.dimensions.width=400;holder.dimensions.height=240;
  const beforeResize=state.draws;state.observerCallbacks.at(-1)();presentation.resizeDraws=state.draws-beforeResize;
  const beforeReset=state.draws;holder.reset.click();const reset={draws:state.draws-beforeReset,uniforms:state.drawUniforms.at(-1)};
  faceShadingPass=state.shaderSources.some((shader)=>shader.includes("base + 0.12 * (vec3(1.0) - base)")&&shader.includes("0.82 * base")&&shader.includes("0.62 * base"));
  const shaderFocus=state.shaderSources.some((shader)=>shader.includes("uniform int u_hoverIndex;")&&shader.includes("uniform int u_selectionIndex;")&&shader.includes("displayed = 0.70 * ordinary;")&&shader.includes("mix(displayed, ordinary, 0.15)")&&shader.includes("mix(ordinary, vec3(1.0), 0.15)"));
  const initialUniforms=state.drawUniforms.slice(0,2);
  presentation.focus={allocationUploads:state.uploads.map((bytes)=>bytes.length),initialUniforms,selection,same,hover,clear,camera,reset,immutableUploads:JSON.stringify(state.uploads)===immutableUploads,subUploads:state.subUploads.length,shaderFocus,faceShading:faceShadingPass,polygonOffsetEnables:state.polygonOffsetEnables,cleanup:null};
  focusPass=JSON.stringify(initialUniforms)===JSON.stringify([[{name:"u_hoverIndex",value:-1},{name:"u_selectionIndex",value:-1}],[{name:"u_hoverIndex",value:-1},{name:"u_selectionIndex",value:-1}]])&&JSON.stringify(selection)===JSON.stringify({draws:2,uniforms:[{name:"u_hoverIndex",value:-1},{name:"u_selectionIndex",value:0},{name:"u_passKind",value:0},{name:"u_passKind",value:1}]})&&JSON.stringify(same)===JSON.stringify({draws:2,uniforms:[{name:"u_hoverIndex",value:0},{name:"u_selectionIndex",value:0},{name:"u_passKind",value:0},{name:"u_passKind",value:1}]})&&JSON.stringify(hover)===JSON.stringify({draws:2,uniforms:[{name:"u_hoverIndex",value:0},{name:"u_selectionIndex",value:-1},{name:"u_passKind",value:0},{name:"u_passKind",value:1}]})&&JSON.stringify(clear)===JSON.stringify({draws:2,uniforms:[{name:"u_hoverIndex",value:-1},{name:"u_selectionIndex",value:-1},{name:"u_passKind",value:0},{name:"u_passKind",value:1}]});
  if(repeat.kind!=="committed"||presentation.initialDraws!==2||presentation.repeatDraws!==2||presentation.resizeDraws!==2||failures.length!==0||holder.host.firstChild!==activeCanvas||activeCanvas.width!==400||activeCanvas.height!==240)throw new Error("Actual WebGL2 present/repeat/focus/resize evidence failed");
  const maximumCity=validateCityPayload(buildCity(Array.from({length:4000},(_,index)=>({canonicalPath:"district-"+String(index).padStart(4,"0")+"/module.js",S:0,U:0,M:0}))));
  const maximumUploadStart=state.uploads.length;const maximumDrawStart=state.draws;const maximumPassStart=state.uniforms.filter(({name})=>name==="u_passKind").length;const maximumMatrixStart=state.matrices.length;const maximumCapture={staged:null,committed:null,projections:[],activations:[]};
  const maximumResult=stageCommit(presenter,holder.host,4000,maximumCity,true,maximumCapture);
  const maximumUploads=state.uploads.slice(maximumUploadStart);const maximumGeometry=maximumGeometryOracle(maximumCity,maximumUploads[2],maximumUploads[3]);const maximumCanvas=holder.host.querySelector("canvas");if(!maximumCanvas||maximumCanvas!==state.canvases.at(-1))throw new Error("maximum committed canvas identity changed");
  const maximumPhase=(lateralFit,snapshot)=>{const matrix=state.matrices.at(-1);return {lateralFit,matrix,snapshot,labels:maximumLabelState(holder.host,maximumCanvas,snapshot,matrix,maximumGeometry)};};
  const maximumPhases=[maximumPhase(true,maximumCapture.committed)];
  if(failures.length)throw new Error("maximum presenter failed before click "+JSON.stringify(failures));
  if(maximumPhases[0].labels.counts.visible===0)throw new Error("maximum overview oracle produced no visible labels "+JSON.stringify(maximumPhases[0].labels.counts));
  const clickCases=maximumClickCases(maximumPhases[0].matrix,maximumGeometry,maximumPhases[0].snapshot);const hostRectangle=holder.host.getBoundingClientRect();const syntheticRectangle={left:hostRectangle.left,top:hostRectangle.top,width:maximumPhases[0].snapshot.cssWidth,height:maximumPhases[0].snapshot.cssHeight,right:hostRectangle.left+maximumPhases[0].snapshot.cssWidth,bottom:hostRectangle.top+maximumPhases[0].snapshot.cssHeight};const clientPoint=(point)=>({x:point.x+syntheticRectangle.left,y:point.y+syntheticRectangle.top});
  Object.defineProperties(maximumCanvas,{getBoundingClientRect:{value:()=>syntheticRectangle,configurable:true},setPointerCapture:{value(){},configurable:true},releasePointerCapture:{value(){},configurable:true}});
  const noHitTargetsCanvas=dispatchMaximumClick(maximumCanvas,clientPoint(clickCases.miss.point),71);const noHitActivation=maximumCapture.activations.at(-1);const noHitInspectorCleared=holder.host.querySelector("[data-inspector]").hidden;
  const buildingTargetsCanvas=dispatchMaximumClick(maximumCanvas,clientPoint(clickCases.hit.point),72);const buildingActivation=maximumCapture.activations.at(-1);const buildingInspectorVisible=!holder.host.querySelector("[data-inspector]").hidden;holder.host.__districtPublication.setSelection(null);
  const clickThrough={buildingExpected:clickCases.hit.index,buildingObserved:buildingActivation?.index??null,buildingInspectorVisible,noHitObserved:noHitActivation?noHitActivation.index:"missing",noHitInspectorCleared,targetsCanvas:noHitTargetsCanvas&&buildingTargetsCanvas};
  if(noHitActivation?.generation!==4000||noHitActivation.index!==null||!noHitInspectorCleared||buildingActivation?.generation!==4000||buildingActivation.index!==clickCases.hit.index||!buildingInspectorVisible)throw new Error("maximum native label click-through changed");
  delete maximumCanvas.getBoundingClientRect;delete maximumCanvas.setPointerCapture;delete maximumCanvas.releasePointerCapture;
  maximumCanvas.dispatchEvent(new KeyboardEvent("keydown",{key:"d",cancelable:true}));maximumPhases.push(maximumPhase(false,maximumCapture.projections.at(-1)));
  maximumCanvas.dispatchEvent(new KeyboardEvent("keydown",{key:"D",shiftKey:true,cancelable:true}));maximumPhases.push(maximumPhase(false,maximumCapture.projections.at(-1)));
  maximumCanvas.dispatchEvent(new WheelEvent("wheel",{deltaY:-120,cancelable:true}));maximumPhases.push(maximumPhase(false,maximumCapture.projections.at(-1)));
  holder.dimensions.width=480;holder.dimensions.height=300;state.observerCallbacks.at(-1)();maximumPhases.push(maximumPhase(false,maximumCapture.projections.at(-1)));
  holder.dimensions.width=479;state.observerCallbacks.at(-1)();maximumPhases.push(maximumPhase(false,maximumCapture.projections.at(-1)));
  holder.reset.click();maximumPhases.push(maximumPhase(true,maximumCapture.projections.at(-1)));
  if(maximumCapture.projections.length!==6)throw new Error("maximum numeric callback count changed");
  const maximumLabels=maximumPhases.map(({labels})=>labels);
  const matricesBeforeInspector=state.matrices.length;holder.host.__districtPublication.setSelection(0);const selectedLabels=maximumLabelState(holder.host,maximumCanvas,maximumPhases.at(-1).snapshot,maximumPhases.at(-1).matrix,maximumGeometry);holder.host.__districtPublication.setSelection(null);const clearedLabels=maximumLabelState(holder.host,maximumCanvas,maximumPhases.at(-1).snapshot,maximumPhases.at(-1).matrix,maximumGeometry);const cachedInspectorRelayout=state.matrices.length===matricesBeforeInspector;
  const matrixOracles=maximumPhases.map(({matrix,lateralFit})=>matrixOracle(matrix,maximumGeometry.sceneBounds,maximumGeometry.centre,lateralFit));
  presentation.maximum={result:maximumResult,groups:maximumGeometry.cells.length,uploads:maximumUploads.map((bytes)=>bytes.length),draws:state.draws-maximumDrawStart,passKinds:state.uniforms.filter(({name})=>name==="u_passKind").slice(maximumPassStart).map(({value})=>value),matrices:state.matrices.length-maximumMatrixStart,sourceBounds:maximumGeometry.sourceBounds,sceneBounds:maximumGeometry.sceneBounds,centre:maximumGeometry.centre,matrixOracles,labels:maximumLabels,selectedLabels,clearedLabels,clickThrough,cachedInspectorRelayout,exactPlateUpload:true};
  presentation.actualContexts+=state.actualContexts;
  holder.host.__districtPublication.rollback();
  presenter.dispose();
  presentation.focus.cleanup={...state.deletes};
  presentation.inputCleanup={listenerAdds:[...state.listenerAdds],listenerRemoves:[...state.listenerRemoves],reset:holder.resetEvidence()};
  holder.host.remove();holder.reset.remove();
}
{
  const holder=presentationHost(320,180);const state=makeState();const failures=[];let semantic;
  const presenter=createCityPresenter({host:holder.host,resetControl:holder.reset,platform:presentationPlatform(state),isEligible:()=>true,failed:(...args)=>{const cleanupAtNotification={...state.deletes};const semanticPresentAtNotification=semantic?.isConnected===true;const hostChildrenAtNotification=holder.host.childNodes.length;semantic?.remove();presentation.lossOrdering={semanticPresentAtNotification,hostChildrenAtNotification,cleanupAtNotification,semanticPresentAfterControllerClear:semantic?.isConnected===true};failures.push(args);}});
  if(stageCommit(presenter,holder.host,3).kind!=="committed")throw new Error("Actual WebGL2 context-loss setup failed");
  semantic=document.createElement("section");semantic.dataset.inspector="";holder.host.append(semantic);
  const canvas=state.canvases[0];const before=state.draws;const event=new Event("webglcontextlost",{cancelable:true});state.contextLost=true;canvas.dispatchEvent(event);
  presentation.lossDefaultPrevented=event.defaultPrevented;presentation.lossDraws=state.draws-before;presentation.lossFailures=failures;presentation.lossCleanup=state.deletes;
  const retainedLoss=state.lossCallbacks[0];const terminalLossDraws=state.draws;const terminalLossCleanup=JSON.stringify(state.deletes);
  if(event.defaultPrevented||presentation.lossDraws!==0||state.lossCallbacks.length!==1||typeof retainedLoss!=="function"||failures.length!==1||JSON.stringify(failures[0])!==JSON.stringify([3,"Presentation failed","M1-PRES-1"])||JSON.stringify(presentation.lossOrdering)!==JSON.stringify({semanticPresentAtNotification:true,hostChildrenAtNotification:2,cleanupAtNotification:{deleteShader:2,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0},semanticPresentAfterControllerClear:false})||terminalLossCleanup!==JSON.stringify({deleteShader:2,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0})||holder.host.firstChild!==null)throw new Error("Actual WebGL2 context-loss evidence failed");
  retainedLoss(new Event("webglcontextlost",{cancelable:true}));canvas.dispatchEvent(new Event("webglcontextlost",{cancelable:true}));state.observerCallbacks[0]();
  presentation.lossTerminalState={retainedCallbacks:state.lossCallbacks.length,failures:failures.length,drawsAfterTerminal:state.draws-terminalLossDraws,canvases:state.canvases.length,hostChildren:holder.host.childNodes.length,cleanupUnchanged:JSON.stringify(state.deletes)===terminalLossCleanup};
  if(JSON.stringify(presentation.lossTerminalState)!==JSON.stringify({retainedCallbacks:1,failures:1,drawsAfterTerminal:0,canvases:1,hostChildren:0,cleanupUnchanged:true}))throw new Error("Actual WebGL2 repeated context-loss callback was not inert");
  presentation.actualContexts+=state.actualContexts;holder.host.remove();holder.reset.remove();
}
{
  const holder=presentationHost(320,180);const state=makeState();const failures=[];const presenter=createCityPresenter({host:holder.host,resetControl:holder.reset,platform:presentationPlatform(state,true),isEligible:()=>true,failed:(...args)=>failures.push(args)});
  presentation.compileFailureResult=stageCommit(presenter,holder.host,4);presentation.compileFailureDraws=state.draws;presentation.compileFailures=failures;presentation.compileCleanup=state.deletes;
  const retainedCompileLoss=state.lossCallbacks[0];
  if(JSON.stringify(presentation.compileFailureResult)!==JSON.stringify({kind:"failure",category:"Presentation failed",code:"M1-PRES-1"})||state.draws!==0||state.lossCallbacks.length!==1||typeof retainedCompileLoss!=="function"||failures.length!==0||JSON.stringify(state.deletes)!==JSON.stringify({deleteShader:1,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0})||state.canvases.length!==1||holder.host.firstChild!==null)throw new Error("Actual WebGL2 compile-failure evidence failed");
  const terminalCompileDraws=state.draws;const terminalCompileCleanup=JSON.stringify(state.deletes);retainedCompileLoss(new Event("webglcontextlost",{cancelable:true}));state.canvases[0].dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
  presentation.compileFailureTerminalState={retainedCallbacks:state.lossCallbacks.length,failures:failures.length,drawsAfterTerminal:state.draws-terminalCompileDraws,canvases:state.canvases.length,hostChildren:holder.host.childNodes.length,cleanupUnchanged:JSON.stringify(state.deletes)===terminalCompileCleanup};
  if(JSON.stringify(presentation.compileFailureTerminalState)!==JSON.stringify({retainedCallbacks:1,failures:0,drawsAfterTerminal:0,canvases:1,hostChildren:0,cleanupUnchanged:true}))throw new Error("Actual WebGL2 compile-failure retained callback was not inert");
  presentation.actualContexts+=state.actualContexts;holder.host.remove();holder.reset.remove();
}
const expectedLifecycleListeners=["webglcontextlost","keydown","wheel","pointerdown","pointermove","pointerup","pointercancel","pointerleave","lostpointercapture","contextmenu","blur","visibilitychange","pagehide"];
const expectedInputCleanup={listenerAdds:Array.from({length:3},()=>expectedLifecycleListeners).flat(),listenerRemoves:Array.from({length:3},()=>expectedLifecycleListeners).flat(),reset:{adds:3,removes:3}};
presentation.pass=focusPass&&faceShadingPass&&presentation.webgl2Available&&presentation.actualContexts===5&&presentation.initialDraws===2&&presentation.repeatDraws===2&&presentation.resizeDraws===2&&JSON.stringify(presentation.focus.allocationUploads)===JSON.stringify([384,36,28,24,384,36,28,24])&&presentation.maximum.result.kind==="committed"&&presentation.maximum.groups===4000&&JSON.stringify(presentation.maximum.uploads)===JSON.stringify([384,36,112000,96000])&&presentation.maximum.draws===14&&JSON.stringify(presentation.maximum.passKinds)===JSON.stringify(Array.from({length:7},()=>[0,1]).flat())&&presentation.maximum.matrices===7&&presentation.maximum.matrixOracles.length===7&&presentation.maximum.matrixOracles.every((oracle)=>oracle.corners===8&&oracle.positiveW&&oracle.strictDepth)&&presentation.maximum.matrixOracles[0].lateralFit&&presentation.maximum.matrixOracles[6].lateralFit&&presentation.maximum.labels.length===7&&presentation.maximum.labels.every((labels)=>labels.dom===4000&&labels.counts.projected===4000&&labels.counts.visible>0&&labels.counts.visible+labels.counts.collision+labels.counts.offscreen+labels.counts.inspector===4000&&labels.exactPositions&&labels.exactVisibility&&labels.overlayMatchesCanvas&&labels.pointerEvents==="none")&&presentation.maximum.labels.slice(0,4).every((labels)=>labels.width==="104px")&&presentation.maximum.labels[4].width==="144px"&&presentation.maximum.labels.slice(5).every((labels)=>labels.width==="104px")&&presentation.maximum.selectedLabels.counts.inspector>0&&presentation.maximum.clearedLabels.counts.inspector===0&&presentation.maximum.clickThrough.buildingExpected===presentation.maximum.clickThrough.buildingObserved&&presentation.maximum.clickThrough.buildingInspectorVisible&&presentation.maximum.clickThrough.noHitObserved===null&&presentation.maximum.clickThrough.noHitInspectorCleared&&presentation.maximum.clickThrough.targetsCanvas&&presentation.maximum.cachedInspectorRelayout&&presentation.maximum.exactPlateUpload&&JSON.stringify(presentation.focus.camera)===JSON.stringify({draws:2,uniforms:[{name:"u_hoverIndex",value:-1},{name:"u_selectionIndex",value:-1}]})&&JSON.stringify(presentation.focus.reset)===JSON.stringify({draws:2,uniforms:[{name:"u_hoverIndex",value:-1},{name:"u_selectionIndex",value:-1}]})&&presentation.focus.immutableUploads&&presentation.focus.subUploads===0&&presentation.focus.shaderFocus&&presentation.focus.faceShading&&presentation.focus.polygonOffsetEnables===0&&JSON.stringify(presentation.focus.cleanup)===JSON.stringify({deleteShader:6,deleteProgram:3,deleteBuffer:12,deleteVertexArray:6})&&JSON.stringify(presentation.accessibility)===JSON.stringify({tabIndex:0,label:"Interactive code city",description:"city-navigation-instructions",listenerAdds:["webglcontextlost","keydown","wheel","pointerdown","pointermove","pointerup","pointercancel","pointerleave","lostpointercapture","contextmenu","blur","visibilitychange","pagehide"],resetText:"Reset view"})&&JSON.stringify(presentation.inputCleanup)===JSON.stringify(expectedInputCleanup)&&presentation.lossDefaultPrevented===false&&presentation.lossDraws===0&&JSON.stringify(presentation.lossFailures)===JSON.stringify([[3,"Presentation failed","M1-PRES-1"]])&&JSON.stringify(presentation.lossOrdering)===JSON.stringify({semanticPresentAtNotification:true,hostChildrenAtNotification:2,cleanupAtNotification:{deleteShader:2,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0},semanticPresentAfterControllerClear:false})&&JSON.stringify(presentation.lossCleanup)===JSON.stringify({deleteShader:2,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0})&&JSON.stringify(presentation.lossTerminalState)===JSON.stringify({retainedCallbacks:1,failures:1,drawsAfterTerminal:0,canvases:1,hostChildren:0,cleanupUnchanged:true})&&JSON.stringify(presentation.compileFailureResult)===JSON.stringify({kind:"failure",category:"Presentation failed",code:"M1-PRES-1"})&&presentation.compileFailureDraws===0&&JSON.stringify(presentation.compileFailures)===JSON.stringify([])&&JSON.stringify(presentation.compileCleanup)===JSON.stringify({deleteShader:1,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0})&&JSON.stringify(presentation.compileFailureTerminalState)===JSON.stringify({retainedCallbacks:1,failures:0,drawsAfterTerminal:0,canvases:1,hostChildren:0,cleanupUnchanged:true});
const assetRequests=ASSETS.map(({role,path,sha256})=>({role,path,sha256}));
const result={schemaVersion:1,assetRequests,cases:outputCases,matrixRuns,complexityMatrixRuns,presentation,browserExceptions:[],unexpectedNetworkRequests:[],overallPass:outputCases.every((entry)=>entry.pass)&&matrixRuns.every((entry)=>entry.pass)&&matrixRuns[0].runDigest===matrixRuns[1].runDigest&&complexityMatrixRuns.every((entry)=>entry.pass)&&complexityMatrixRuns[0].runDigest===complexityMatrixRuns[1].runDigest&&presentation.pass};
document.querySelector("#result").textContent=JSON.stringify(result);
`;
}
