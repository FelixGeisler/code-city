import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
const nodeParserUrl=new URL('../src/edge/node/parser-assets.ts',import.meta.url).href;
let forbidParser=false;
const hooks=registerHooks({resolve(s,c,next){
 if(c.parentURL?.includes('browser-analysis-worker.ts')&&s==='./tree-sitter-adapter')return {url:'data:text/javascript,'+encodeURIComponent(`import {createNodeTreeSitterAdapter} from ${JSON.stringify(nodeParserUrl)}; export function createTreeSitterAdapter(){if(globalThis.__forbidPolicyParser)throw Error('No restore parser');return createNodeTreeSitterAdapter();}`),shortCircuit:true};
 return next(/^\.\.?\//u.test(s)&&! /\.[a-z]+$/iu.test(s)?s+'.ts':s,c);
}});
const {decodeSnapshot}=await import('../src/application/saved-investigation.ts');
let serial=0;
async function worker(fetcher){
 const originals=new Map();for(const [key,value]of Object.entries({self:undefined,fetch:fetcher,__CODE_CITY_ANALYZER__:'f'.repeat(64),__forbidPolicyParser:forbidParser}))originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 const scope=new EventTarget();scope.location={origin:'http://localhost'};scope.frames=[];scope.closed=false;scope.close=()=>scope.closed=true;
 const waiters=[];scope.postMessage=frame=>{scope.frames.push(frame);for(const waiter of [...waiters])if(waiter.type===frame.type){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(frame);}};
 Object.assign(globalThis,{self:scope,fetch:fetcher,__CODE_CITY_ANALYZER__:'f'.repeat(64),__forbidPolicyParser:forbidParser});
 await import(`../src/edge/browser-analysis-worker.ts?policy=${++serial}`);
 return {scope,send(frame){scope.dispatchEvent(new MessageEvent('message',{data:frame}));},wait(type){const frame=scope.frames.find(x=>x.type===type);return frame?Promise.resolve(frame):new Promise(resolve=>waiters.push({type,resolve}));},close(){for(const [key,d]of originals){if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}}};
}
const identity={sessionId:'A'.repeat(43),generation:1};
const file=name=>({kind:'file',name,async getFile(){const b=new Blob(['export function f(x) { return x ? 1 : 0; }\n']);return {size:b.size,lastModified:1,stream:()=>b.stream()};}});
const dir=(name,entries)=>({kind:'directory',name,async *values(){yield*entries;}});

test('actual browser worker applies exact policy, publishes before terminal, saves applied settings, and restores without parser/folder/provider',async()=>{
 let upload,receipt;const calls=[];
 const fetcher=async(url,options)=>{
  calls.push([String(url),options?.method??'GET']);assert.equal(options.method,'POST');upload=new Uint8Array(await options.body.arrayBuffer());
  receipt={id:'S'.repeat(43),kind:'working-tree',repository:'Synthetic',ref:'working tree',revision:(await decodeSnapshot(upload)).header.origin.captureId,savedAt:new Date().toISOString(),bytes:upload.length,sha256:createHash('sha256').update(upload).digest('hex')};
  return new Response(JSON.stringify(receipt),{status:201});
 };
 const w=await worker(fetcher);
 try {
  const root=dir('Synthetic',[dir('.angular',[file('included.ts'),dir('.vite',[file('hidden.ts')])]),dir('node_modules',[file('hidden.ts')])]);
  const command={type:'START',...identity,inputKind:'working-tree',root,name:'Synthetic',additionalExclusions:'manual',included:['.angular']};
  w.send(command);await w.wait('ANALYSIS_SUCCEEDED');assert.equal(calls.length,0,'no request before Save');
  const policyFrame=w.scope.frames.filter(x=>x.type==='EXCLUSION_POLICY').at(-1);assert.equal(policyFrame.complete,true);
  assert.deepEqual(policyFrame.policy.detected,[['.angular','cache:.angular'],['.angular/.vite','cache:.vite'],['node_modules','dependency:node_modules']]);
  assert.ok(w.scope.frames.indexOf(policyFrame)<w.scope.frames.findIndex(x=>x.type==='ANALYSIS_SUCCEEDED'));
  command.additionalExclusions='pending';command.included=[]; // UI/caller edits cannot mutate applied worker state
  w.send({type:'SAVE',...identity,requestId:1});assert.equal((await w.wait('SAVE_RESULT')).ok,true);
  const saved=await decodeSnapshot(upload);assert.deepEqual(saved.header.exclusionPolicy,policyFrame.policy);assert.deepEqual(saved.header.files.map(x=>x.path),['.angular/included.ts']);
 } finally {w.close();}
 forbidParser=true;const restoreCalls=[];
 const r=await worker(async url=>{restoreCalls.push(String(url));if(String(url).endsWith('/record'))return new Response(JSON.stringify(receipt));if(String(url).endsWith(receipt.id))return new Response(upload);throw Error('Unexpected restore access');});
 try {
  r.send({type:'START',...identity,repositoryUrl:'',additionalExclusions:'',included:[],savedId:receipt.id});await r.wait('ANALYSIS_SUCCEEDED');
  assert.equal(restoreCalls.length,2);assert.deepEqual(r.scope.frames.find(x=>x.type==='RESTORED').exclusionPolicy,(await decodeSnapshot(upload)).header.exclusionPolicy);
  r.send({type:'INSPECT',...identity,requestId:2,query:{type:'units',path:'.angular/included.ts',offset:0}});assert.equal((await r.wait('INSPECTION_RESULT')).ok,true);assert.equal(restoreCalls.length,2);
 } finally {r.close();forbidParser=false;}
});

test('partial enumeration failure publishes incomplete policy before closing the actual worker',async()=>{
 const w=await worker(()=>{throw Error('No network');});
 try {
  const root={kind:'directory',async *values(){yield dir('.next',[file('pruned.ts')]);throw Error('Unavailable enumeration');}};
  w.send({type:'START',...identity,inputKind:'working-tree',root,name:'Synthetic',additionalExclusions:'',included:[]});
  const failed=await w.wait('WORKING_TREE_FAILED');assert.equal(failed.category,'Local working tree unavailable');
  const report=w.scope.frames.filter(x=>x.type==='EXCLUSION_POLICY').at(-1);assert.equal(report.complete,false);assert.deepEqual(report.policy.detected,[['.next','cache:.next']]);assert.ok(w.scope.frames.indexOf(report)<w.scope.frames.indexOf(failed));
 } finally {w.close();}
});

test('all-excluded worker reports editable complete detections before terminal close',async()=>{
 const w=await worker(()=>{throw Error('No network');});
 try {
  w.send({type:'START',...identity,inputKind:'working-tree',root:dir('Synthetic',[dir('.angular',[file('hidden.ts')])]),name:'Synthetic',additionalExclusions:'',included:[]});
  const failed=await w.wait('WORKING_TREE_FAILED');assert.equal(failed.category,'No supported modules');assert.equal(w.scope.closed,true);
  const report=w.scope.frames.filter(x=>x.type==='EXCLUSION_POLICY').at(-1);assert.equal(report.complete,true);assert.deepEqual(report.policy.detected,[['.angular','cache:.angular']]);
  assert.ok(w.scope.frames.indexOf(report)<w.scope.frames.indexOf(failed));
 } finally {w.close();}
});
