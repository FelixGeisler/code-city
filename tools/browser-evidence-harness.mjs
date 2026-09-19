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
function exactClip(matrix,corner,column){const a=Math.fround(Math.fround(matrix[column])*Math.fround(corner[0]));const b=Math.fround(Math.fround(matrix[column+4])*Math.fround(corner[1]));const c=Math.fround(Math.fround(matrix[column+8])*Math.fround(corner[2]));const d=Math.fround(matrix[column+12]);return Math.fround(Math.fround(Math.fround(a+b)+c)+d);}
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
  return {sourceBounds,sceneBounds,centre,cells:cells.length};
}
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
function stageCommit(presenter,host,generation,city=presentationCity,semantic=false){
  const priorChildren=[...host.childNodes];
  const revision=document.createElement("output");
  const publication=semantic?stageSemanticPublication(document,host,revision,"a".repeat(40),city.inspection,city.districts):undefined;
  const eventSink=semantic?{...emptyEventSink,districtProjection(_generation,snapshot){publication.districtProjection(snapshot);}}:emptyEventSink;
  const staged=presenter.stage(generation,city.geometry,city.presentation,eventSink);
  if(staged.kind!=="staged")return staged;
  if(priorChildren.length!==host.childNodes.length||priorChildren.some((node,index)=>host.childNodes[index]!==node))throw new Error("Presenter stage was not detached");
  const committed=presenter.commit(staged.token);
  if(committed.kind!=="committed")return committed;
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
  const maximumUploadStart=state.uploads.length;const maximumDrawStart=state.draws;const maximumPassStart=state.uniforms.filter(({name})=>name==="u_passKind").length;const maximumMatrixStart=state.matrices.length;
  const maximumResult=stageCommit(presenter,holder.host,4000,maximumCity,true);
  const maximumLabelState=()=>{const overlay=holder.host.querySelector("[data-district-labels]");const labels=[...overlay.children];const overlayRect=overlay.getBoundingClientRect();const canvasRect=state.canvases.at(-1).getBoundingClientRect();return {dom:labels.length,visible:labels.filter(label=>!label.hidden).length,hidden:labels.filter(label=>label.hidden).length,widths:[...new Set(labels.map(label=>label.style.width))],transformsFinite:labels.every(label=>/^translate\\(-?\\d+(?:\\.\\d+)?px, -?\\d+(?:\\.\\d+)?px\\)$/.test(label.style.transform)),overlayMatchesCanvas:overlayRect.left===canvasRect.left&&overlayRect.top===canvasRect.top&&overlayRect.width===canvasRect.width&&overlayRect.height===canvasRect.height,pointerEvents:getComputedStyle(overlay).pointerEvents};};
  const maximumCanvas=state.canvases.at(-1);const maximumPhases=[{lateralFit:true,matrix:state.matrices.at(-1),labels:maximumLabelState()}];
  maximumCanvas.dispatchEvent(new KeyboardEvent("keydown",{key:"d",cancelable:true}));maximumPhases.push({lateralFit:false,matrix:state.matrices.at(-1),labels:maximumLabelState()});
  maximumCanvas.dispatchEvent(new KeyboardEvent("keydown",{key:"D",shiftKey:true,cancelable:true}));maximumPhases.push({lateralFit:false,matrix:state.matrices.at(-1),labels:maximumLabelState()});
  maximumCanvas.dispatchEvent(new WheelEvent("wheel",{deltaY:-120,cancelable:true}));maximumPhases.push({lateralFit:false,matrix:state.matrices.at(-1),labels:maximumLabelState()});
  holder.dimensions.width=480;holder.dimensions.height=300;state.observerCallbacks.at(-1)();maximumPhases.push({lateralFit:false,matrix:state.matrices.at(-1),labels:maximumLabelState()});
  holder.dimensions.width=479;state.observerCallbacks.at(-1)();maximumPhases.push({lateralFit:false,matrix:state.matrices.at(-1),labels:maximumLabelState()});
  holder.reset.click();maximumPhases.push({lateralFit:true,matrix:state.matrices.at(-1),labels:maximumLabelState()});
  const matricesBeforeInspector=state.matrices.length;holder.host.__districtPublication.setSelection(0);const selectedLabels=maximumLabelState();holder.host.__districtPublication.setSelection(null);const clearedLabels=maximumLabelState();const cachedInspectorRelayout=state.matrices.length===matricesBeforeInspector;
  const maximumUploads=state.uploads.slice(maximumUploadStart);const maximumGeometry=maximumGeometryOracle(maximumCity,maximumUploads[2],maximumUploads[3]);
  const matrixOracles=maximumPhases.map(({matrix,lateralFit})=>matrixOracle(matrix,maximumGeometry.sceneBounds,maximumGeometry.centre,lateralFit));
  presentation.maximum={result:maximumResult,groups:maximumGeometry.cells,uploads:maximumUploads.map((bytes)=>bytes.length),draws:state.draws-maximumDrawStart,passKinds:state.uniforms.filter(({name})=>name==="u_passKind").slice(maximumPassStart).map(({value})=>value),matrices:state.matrices.length-maximumMatrixStart,sourceBounds:maximumGeometry.sourceBounds,sceneBounds:maximumGeometry.sceneBounds,centre:maximumGeometry.centre,matrixOracles,labels:maximumPhases.map(({labels})=>labels),selectedLabels,clearedLabels,cachedInspectorRelayout,exactPlateUpload:true};
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
presentation.pass=focusPass&&faceShadingPass&&presentation.webgl2Available&&presentation.actualContexts===5&&presentation.initialDraws===2&&presentation.repeatDraws===2&&presentation.resizeDraws===2&&JSON.stringify(presentation.focus.allocationUploads)===JSON.stringify([384,36,28,24,384,36,28,24])&&presentation.maximum.result.kind==="committed"&&presentation.maximum.groups===4000&&JSON.stringify(presentation.maximum.uploads)===JSON.stringify([384,36,112000,96000])&&presentation.maximum.draws===14&&JSON.stringify(presentation.maximum.passKinds)===JSON.stringify(Array.from({length:7},()=>[0,1]).flat())&&presentation.maximum.matrices===7&&presentation.maximum.matrixOracles.length===7&&presentation.maximum.matrixOracles.every((oracle)=>oracle.corners===8&&oracle.positiveW&&oracle.strictDepth)&&presentation.maximum.matrixOracles[0].lateralFit&&presentation.maximum.matrixOracles[6].lateralFit&&presentation.maximum.labels.length===7&&presentation.maximum.labels.every((labels)=>labels.dom===4000&&labels.visible>0&&labels.visible+labels.hidden===4000&&labels.transformsFinite&&labels.overlayMatchesCanvas&&labels.pointerEvents==="none")&&presentation.maximum.labels.slice(0,4).every((labels)=>JSON.stringify(labels.widths)===JSON.stringify(["104px"]))&&JSON.stringify(presentation.maximum.labels[4].widths)===JSON.stringify(["144px"])&&presentation.maximum.labels.slice(5).every((labels)=>JSON.stringify(labels.widths)===JSON.stringify(["104px"]))&&presentation.maximum.selectedLabels.visible<=presentation.maximum.clearedLabels.visible&&presentation.maximum.cachedInspectorRelayout&&presentation.maximum.exactPlateUpload&&JSON.stringify(presentation.focus.camera)===JSON.stringify({draws:2,uniforms:[{name:"u_hoverIndex",value:-1},{name:"u_selectionIndex",value:-1}]})&&JSON.stringify(presentation.focus.reset)===JSON.stringify({draws:2,uniforms:[{name:"u_hoverIndex",value:-1},{name:"u_selectionIndex",value:-1}]})&&presentation.focus.immutableUploads&&presentation.focus.subUploads===0&&presentation.focus.shaderFocus&&presentation.focus.faceShading&&presentation.focus.polygonOffsetEnables===0&&JSON.stringify(presentation.focus.cleanup)===JSON.stringify({deleteShader:6,deleteProgram:3,deleteBuffer:12,deleteVertexArray:6})&&JSON.stringify(presentation.accessibility)===JSON.stringify({tabIndex:0,label:"Interactive code city",description:"city-navigation-instructions",listenerAdds:["webglcontextlost","keydown","wheel","pointerdown","pointermove","pointerup","pointercancel","pointerleave","lostpointercapture","contextmenu","blur","visibilitychange","pagehide"],resetText:"Reset view"})&&JSON.stringify(presentation.inputCleanup)===JSON.stringify(expectedInputCleanup)&&presentation.lossDefaultPrevented===false&&presentation.lossDraws===0&&JSON.stringify(presentation.lossFailures)===JSON.stringify([[3,"Presentation failed","M1-PRES-1"]])&&JSON.stringify(presentation.lossOrdering)===JSON.stringify({semanticPresentAtNotification:true,hostChildrenAtNotification:2,cleanupAtNotification:{deleteShader:2,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0},semanticPresentAfterControllerClear:false})&&JSON.stringify(presentation.lossCleanup)===JSON.stringify({deleteShader:2,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0})&&JSON.stringify(presentation.lossTerminalState)===JSON.stringify({retainedCallbacks:1,failures:1,drawsAfterTerminal:0,canvases:1,hostChildren:0,cleanupUnchanged:true})&&JSON.stringify(presentation.compileFailureResult)===JSON.stringify({kind:"failure",category:"Presentation failed",code:"M1-PRES-1"})&&presentation.compileFailureDraws===0&&JSON.stringify(presentation.compileFailures)===JSON.stringify([])&&JSON.stringify(presentation.compileCleanup)===JSON.stringify({deleteShader:1,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0})&&JSON.stringify(presentation.compileFailureTerminalState)===JSON.stringify({retainedCallbacks:1,failures:0,drawsAfterTerminal:0,canvases:1,hostChildren:0,cleanupUnchanged:true});
const assetRequests=ASSETS.map(({role,path,sha256})=>({role,path,sha256}));
const result={schemaVersion:1,assetRequests,cases:outputCases,matrixRuns,complexityMatrixRuns,presentation,browserExceptions:[],unexpectedNetworkRequests:[],overallPass:outputCases.every((entry)=>entry.pass)&&matrixRuns.every((entry)=>entry.pass)&&matrixRuns[0].runDigest===matrixRuns[1].runDigest&&complexityMatrixRuns.every((entry)=>entry.pass)&&complexityMatrixRuns[0].runDigest===complexityMatrixRuns[1].runDigest&&presentation.pass};
document.querySelector("#result").textContent=JSON.stringify(result);
`;
}
