export function createBrowserHarnessSource({ projectRootUrl, assets }) {
  return `
import { createTreeSitterAdapter } from ${JSON.stringify(`${projectRootUrl}src/edge/tree-sitter-adapter.ts`)};
import { processAdmittedBaseMetrics } from ${JSON.stringify(`${projectRootUrl}src/application/base-metric-processing.ts`)};
import { deriveBaseMetricAnalysis } from ${JSON.stringify(`${projectRootUrl}src/domain/base-metrics.ts`)};
import { buildCity } from ${JSON.stringify(`${projectRootUrl}src/domain/city-model.ts`)};
import { createCityPresenter } from ${JSON.stringify(`${projectRootUrl}src/edge/city-presenter.ts`)};

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
function presentationPlatform(state,compileFailure=false){
  return {createCanvas(){
    const canvas=document.createElement("canvas");
    const addListener=canvas.addEventListener.bind(canvas);
    Object.defineProperty(canvas,"addEventListener",{value(type,listener,options){if(type==="webglcontextlost")state.lossCallbacks.push(listener);return addListener(type,listener,options);}});
    const acquire=canvas.getContext.bind(canvas);
    Object.defineProperty(canvas,"getContext",{value(kind,attributes){
      const actual=acquire(kind,attributes);
      if(!actual)return null;
      state.actualContexts++;
      return new Proxy(actual,{get(target,property){
        if(property==="drawElementsInstanced")return (...args)=>{state.draws++;return target.drawElementsInstanced(...args);};
        if(property==="getShaderParameter")return (shader,pname)=>{const actualStatus=target.getShaderParameter(shader,pname);return compileFailure&&pname===0x8b81?false:actualStatus;};
        if(["deleteShader","deleteProgram","deleteBuffer","deleteVertexArray"].includes(property))return (...args)=>{state.deletes[property]++;return target[property](...args);};
        const value=Reflect.get(target,property,target);
        return typeof value==="function"?value.bind(target):value;
      }});
    }});
    state.canvases.push(canvas);
    return canvas;
  },createResizeObserver(callback){state.observerCallbacks.push(callback);return new ResizeObserver(callback);}};
}
function presentationHost(width,height){
  const host=document.createElement("div");
  const dimensions={width,height};
  Object.defineProperties(host,{clientWidth:{get:()=>dimensions.width},clientHeight:{get:()=>dimensions.height}});
  document.body.append(host);
  return {host,dimensions};
}
const presentationModel=buildCity([{canonicalPath:"browser.js",S:1,U:1,M:1}]).geometry;
const emptyEventSink={hoverIndex(){},activationIndex(){},selectionAction(){}};
function stageCommit(presenter,host,generation){
  const priorChildren=[...host.childNodes];
  const staged=presenter.stage(generation,presentationModel,emptyEventSink);
  if(staged.kind!=="staged")return staged;
  if(priorChildren.length!==host.childNodes.length||priorChildren.some((node,index)=>host.childNodes[index]!==node))throw new Error("Presenter stage was not detached");
  const committed=presenter.commit(staged.token);
  if(committed.kind!=="committed")return committed;
  host.replaceChildren(staged.canvas);
  if(presenter.setVisualState(generation,null,null).kind!=="applied")throw new Error("Initial visual state was not applied");
  return committed;
}
const presentation={webgl2Available:false,actualContexts:0,initialDraws:0,repeatDraws:0,resizeDraws:0,lossDefaultPrevented:null,lossDraws:0,lossFailures:[],lossOrdering:null,lossCleanup:null,lossTerminalState:null,compileFailureResult:null,compileFailureDraws:0,compileFailures:[],compileCleanup:null,compileFailureTerminalState:null,pass:false};
{
  const holder=presentationHost(320,180);
  const state={canvases:[],draws:0,actualContexts:0,observerCallbacks:[],lossCallbacks:[],deletes:{deleteShader:0,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0}};
  const failures=[];
  const presenter=createCityPresenter({host:holder.host,platform:presentationPlatform(state),isEligible:()=>true,failed:(...args)=>failures.push(args)});
  const first=stageCommit(presenter,holder.host,1);
  if(first.kind!=="committed")throw new Error("Installed Chrome WebGL2 is unavailable or rejected");
  presentation.webgl2Available=true;
  presentation.initialDraws=state.draws;
  const firstCanvas=state.canvases[0];
  if(firstCanvas.width!==320||firstCanvas.height!==180)throw new Error("Actual WebGL2 backing dimensions differ");
  const repeat=stageCommit(presenter,holder.host,2);
  presentation.repeatDraws=state.draws-presentation.initialDraws;
  holder.dimensions.width=400;holder.dimensions.height=240;
  const beforeResize=state.draws;
  state.observerCallbacks.at(-1)();
  presentation.resizeDraws=state.draws-beforeResize;
  if(repeat.kind!=="committed"||presentation.initialDraws!==1||presentation.repeatDraws!==1||presentation.resizeDraws!==1||failures.length!==0||holder.host.firstChild!==state.canvases.at(-1)||state.canvases.at(-1).width!==400||state.canvases.at(-1).height!==240)throw new Error("Actual WebGL2 present/repeat/resize evidence failed");
  presentation.actualContexts+=state.actualContexts;
  presenter.dispose();holder.host.remove();
}
{
  const holder=presentationHost(320,180);
  const state={canvases:[],draws:0,actualContexts:0,observerCallbacks:[],lossCallbacks:[],deletes:{deleteShader:0,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0}};
  const failures=[];
  let semantic;
  const presenter=createCityPresenter({host:holder.host,platform:presentationPlatform(state),isEligible:()=>true,failed:(...args)=>{
    const cleanupAtNotification={...state.deletes};
    const semanticPresentAtNotification=semantic?.isConnected===true;
    const hostChildrenAtNotification=holder.host.childNodes.length;
    semantic?.remove();
    presentation.lossOrdering={semanticPresentAtNotification,hostChildrenAtNotification,cleanupAtNotification,semanticPresentAfterControllerClear:semantic?.isConnected===true};
    failures.push(args);
  }});
  if(stageCommit(presenter,holder.host,3).kind!=="committed")throw new Error("Actual WebGL2 context-loss setup failed");
  semantic=document.createElement("section");
  semantic.dataset.inspector="";
  holder.host.append(semantic);
  const canvas=state.canvases[0];
  const before=state.draws;
  const event=new Event("webglcontextlost",{cancelable:true});
  canvas.dispatchEvent(event);
  presentation.lossDefaultPrevented=event.defaultPrevented;
  presentation.lossDraws=state.draws-before;
  presentation.lossFailures=failures;
  presentation.lossCleanup=state.deletes;
  const retainedLoss=state.lossCallbacks[0];
  const terminalLossDraws=state.draws;
  const terminalLossCleanup=JSON.stringify(state.deletes);
  if(event.defaultPrevented||presentation.lossDraws!==0||state.lossCallbacks.length!==1||typeof retainedLoss!=="function"||failures.length!==1||JSON.stringify(failures[0])!==JSON.stringify([3,"Presentation failed","M1-PRES-1"])||JSON.stringify(presentation.lossOrdering)!==JSON.stringify({semanticPresentAtNotification:true,hostChildrenAtNotification:2,cleanupAtNotification:{deleteShader:2,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0},semanticPresentAfterControllerClear:false})||terminalLossCleanup!==JSON.stringify({deleteShader:2,deleteProgram:1,deleteBuffer:3,deleteVertexArray:1})||holder.host.firstChild!==null)throw new Error("Actual WebGL2 context-loss evidence failed");
  retainedLoss(new Event("webglcontextlost",{cancelable:true}));
  canvas.dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
  state.observerCallbacks[0]();
  presentation.lossTerminalState={retainedCallbacks:state.lossCallbacks.length,failures:failures.length,drawsAfterTerminal:state.draws-terminalLossDraws,canvases:state.canvases.length,hostChildren:holder.host.childNodes.length,cleanupUnchanged:JSON.stringify(state.deletes)===terminalLossCleanup};
  if(JSON.stringify(presentation.lossTerminalState)!==JSON.stringify({retainedCallbacks:1,failures:1,drawsAfterTerminal:0,canvases:1,hostChildren:0,cleanupUnchanged:true}))throw new Error("Actual WebGL2 repeated context-loss callback was not inert");
  presentation.actualContexts+=state.actualContexts;
  holder.host.remove();
}
{
  const holder=presentationHost(320,180);
  const state={canvases:[],draws:0,actualContexts:0,observerCallbacks:[],lossCallbacks:[],deletes:{deleteShader:0,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0}};
  const failures=[];
  const presenter=createCityPresenter({host:holder.host,platform:presentationPlatform(state,true),isEligible:()=>true,failed:(...args)=>failures.push(args)});
  presentation.compileFailureResult=stageCommit(presenter,holder.host,4);
  presentation.compileFailureDraws=state.draws;
  presentation.compileFailures=failures;
  presentation.compileCleanup=state.deletes;
  const retainedCompileLoss=state.lossCallbacks[0];
  if(JSON.stringify(presentation.compileFailureResult)!==JSON.stringify({kind:"failure",category:"Presentation failed",code:"M1-PRES-1"})||state.draws!==0||state.lossCallbacks.length!==1||typeof retainedCompileLoss!=="function"||failures.length!==0||JSON.stringify(state.deletes)!==JSON.stringify({deleteShader:1,deleteProgram:0,deleteBuffer:0,deleteVertexArray:0})||state.canvases.length!==1||holder.host.firstChild!==null)throw new Error("Actual WebGL2 compile-failure evidence failed");
  const terminalCompileDraws=state.draws;
  const terminalCompileCleanup=JSON.stringify(state.deletes);
  retainedCompileLoss(new Event("webglcontextlost",{cancelable:true}));
  state.canvases[0].dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
  presentation.compileFailureTerminalState={retainedCallbacks:state.lossCallbacks.length,failures:failures.length,drawsAfterTerminal:state.draws-terminalCompileDraws,canvases:state.canvases.length,hostChildren:holder.host.childNodes.length,cleanupUnchanged:JSON.stringify(state.deletes)===terminalCompileCleanup};
  if(JSON.stringify(presentation.compileFailureTerminalState)!==JSON.stringify({retainedCallbacks:1,failures:0,drawsAfterTerminal:0,canvases:1,hostChildren:0,cleanupUnchanged:true}))throw new Error("Actual WebGL2 compile-failure retained callback was not inert");
  presentation.actualContexts+=state.actualContexts;
  holder.host.remove();
}
presentation.pass=presentation.webgl2Available&&presentation.actualContexts===4&&presentation.initialDraws===1&&presentation.repeatDraws===1&&presentation.resizeDraws===1&&presentation.lossDefaultPrevented===false&&presentation.lossDraws===0&&presentation.lossFailures.length===1&&presentation.lossOrdering.semanticPresentAtNotification&&presentation.lossOrdering.hostChildrenAtNotification===2&&presentation.lossOrdering.cleanupAtNotification.deleteProgram===0&&!presentation.lossOrdering.semanticPresentAfterControllerClear&&presentation.lossCleanup.deleteProgram===1&&presentation.lossCleanup.deleteBuffer===3&&presentation.lossCleanup.deleteVertexArray===1&&presentation.lossTerminalState.retainedCallbacks===1&&presentation.lossTerminalState.failures===1&&presentation.lossTerminalState.drawsAfterTerminal===0&&presentation.lossTerminalState.canvases===1&&presentation.lossTerminalState.hostChildren===0&&presentation.lossTerminalState.cleanupUnchanged&&presentation.compileFailureResult.kind==="failure"&&presentation.compileFailureDraws===0&&presentation.compileFailures.length===0&&presentation.compileCleanup.deleteShader===1&&presentation.compileFailureTerminalState.retainedCallbacks===1&&presentation.compileFailureTerminalState.failures===0&&presentation.compileFailureTerminalState.drawsAfterTerminal===0&&presentation.compileFailureTerminalState.canvases===1&&presentation.compileFailureTerminalState.hostChildren===0&&presentation.compileFailureTerminalState.cleanupUnchanged;
const assetRequests=ASSETS.map(({role,path,sha256})=>({role,path,sha256}));
const result={schemaVersion:1,assetRequests,cases:outputCases,matrixRuns,complexityMatrixRuns,presentation,browserExceptions:[],unexpectedNetworkRequests:[],overallPass:outputCases.every((entry)=>entry.pass)&&matrixRuns.every((entry)=>entry.pass)&&matrixRuns[0].runDigest===matrixRuns[1].runDigest&&complexityMatrixRuns.every((entry)=>entry.pass)&&complexityMatrixRuns[0].runDigest===complexityMatrixRuns[1].runDigest&&presentation.pass};
document.querySelector("#result").textContent=JSON.stringify(result);
`;
}
