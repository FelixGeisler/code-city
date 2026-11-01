import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,rm,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {watch} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import test,{after} from 'node:test';
import {buildStandaloneArtifact} from '../tools/build-standalone.mjs';
import {launchStandalone,readyOrigin,writeSignalPreload,sendGracefulSignal,expectCleanExit,terminateForCleanup,request} from '../tools/standalone-check-support.mjs';
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(context.parentURL?.endsWith('.ts')&&/^\.\.?\//u.test(specifier)&&!/\.[a-z]+$/iu.test(specifier)?`${specifier}.ts`:specifier,context);}});
const {createInvestigationCapture}=await import('../src/application/investigation-capture.ts');
const {acquireProjectSources}=await import('../src/application/source-retrieval.ts');
const {analyzeProjectSources}=await import('../src/application/project-analysis.ts');
const {createNodeTreeSitterAdapter}=await import('../src/edge/node/parser-assets.ts');
const {decodeSnapshot,validateSavedHeader,snapshotPrefix,SAVE_LIMITS,hasSaveCapacity,snapshotIdentity,parseSavedRecord}=await import('../src/application/saved-investigation.ts');
const {parseRepositoryReference}=await import('../src/domain/repository-reference.ts');
const {recordExclusionPolicy}=await import('../src/domain/exclusion-policy.ts');
const {createGithubRevisionGateway}=await import('../src/edge/github-revision-gateway.ts');
const SHA='a'.repeat(40);
const temporary=await mkdtemp(path.join(os.tmpdir(),'code-city-saved-tests-'));
const artifactRoot=path.join(temporary,'artifact');
await buildStandaloneArtifact(artifactRoot);
after(()=>rm(temporary,{recursive:true,force:true}));
async function snapshot(url='https://github.com/owner/one/tree/main',revision=SHA,allFailed=false){
 const rows=new Map([['src/a.js',Buffer.from('\ufeffexport function f(x) { return x ? 1 : 0; }\r\n')],['src/empty.js',Buffer.alloc(0)],['invalid.js',Buffer.from([0xc3,0x28])]]);
 if(allFailed){rows.delete('src/a.js');rows.delete('src/empty.js');rows.set('nul.js',Buffer.from([0]));}
 const capture=createInvestigationCapture();
 const gateway={async loadInventory(){return {kind:'inventory',entries:[{path:'src',mode:'040000',type:'tree'},...[...rows].map(([name,bytes])=>({path:name,mode:'100644',type:'blob',sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}))]};},async readRawSource(_repo,_sha,candidate){return {kind:'source',rawBytes:new Uint8Array(rows.get(candidate.rawPath))};}};
 const acquired=await acquireProjectSources(parseRepositoryReference(url),revision,new AbortController().signal,gateway);
 assert.equal(acquired.kind,'acquired');
 const analyzed=await analyzeProjectSources(acquired,createNodeTreeSitterAdapter(),undefined,capture);
 assert.equal(analyzed.kind,'analyzed');
 const blob=await capture.snapshot({kind:'github',repositoryUrl:url,revision},recordExclusionPolicy(['excluded']),analyzed.result,'f'.repeat(64));
 return {bytes:Buffer.from(await blob.arrayBuffer()),result:analyzed.result,capture};
}
async function host(data){const preload=await writeSignalPreload(temporary);const server=launchStandalone({artifactRoot,preload,serverArguments:['--port','0','--data-dir',data]});return {server,origin:await readyOrigin(server)};}
async function stop(server){sendGracefulSignal(server,'SIGTERM');await expectCleanExit(server);}
const post=(origin,bytes)=>request(origin,'/api/investigations',{method:'POST',headers:{Origin:origin,'Content-Type':'application/octet-stream'},body:bytes});

test('v4 snapshots retain exactly one normalized copy, outcomes, hierarchy, unit identities and owned contributions',async()=>{
 const saved=await snapshot(),decoded=await decodeSnapshot(saved.bytes);
 assert.equal(decoded.header.files.length,3);assert.equal(decoded.header.analyzer,'f'.repeat(64));
 assert.deepEqual(decoded.header.hierarchy,['src']);
 assert.deepEqual(decoded.header.exclusionPolicy,recordExclusionPolicy(['excluded']));
 assert.equal(decoded.header.files[0].outcome,'Source text is not supported');
 assert.equal(decoded.header.version,4);assert.equal(saved.bytes.subarray(0,8).toString(),'CCSAVE4\0');
 assert.equal(decoded.header.files[0].normalized,null);assert.equal(decoded.sourceBytes.length,2);
 assert.equal(new TextDecoder().decode(decoded.sourceBytes[0]),'export function f(x) { return x ? 1 : 0; }\n');
 assert.equal(decoded.sourceBytes[1].length,0);
 for(const file of decoded.header.files)assert.deepEqual(Object.keys(file),['path','normalized','outcome','fact','units','contributions']);
 const headerLength=saved.bytes.readUInt32BE(8);assert.equal(saved.bytes.length,12+headerLength+decoded.sourceBytes.reduce((sum,bytes)=>sum+bytes.length,0));
 const file=decoded.header.files.find(file=>file.path==='src/a.js');
 assert.equal(file.fact.U,2);assert.equal(file.fact.M,2);
 assert.equal(file.units.length,2);assert.equal(file.contributions.length,1);
 assert.equal(file.units[file.contributions[0][0]][0],'function');
 assert.equal(file.contributions[0][1],'ternary');
 assert.equal(file.units[0][0],'top-level');assert.equal(file.units[0][2],file.normalized.length);
 assert.deepEqual(saved.result.city.inspection,decoded.header.city.inspection);
});

function encode(header,sections){const bytes=Buffer.from(JSON.stringify(header));return Buffer.concat([snapshotPrefix(bytes),bytes,...sections]);}
const descriptor=bytes=>({length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});

test('v4 recorded overrides survive native restart; unknown policy/rules and v3 reject',async(t)=>{
 const root='SyntheticWeb/ClientApp/.angular',filePath=root+'/cache/22.2.2/app/vite/deps/dependency.js';
 const source=new TextEncoder().encode('const synthetic = ;\n'),capture=createInvestigationCapture();
 const result={city:null,sources:[{canonicalPath:filePath,normalizedUtf8:source}],notAnalyzedFiles:[{canonicalPath:filePath,category:'Syntax could not be analyzed'}]};
 const policy=recordExclusionPolicy({manual:['other'],included:[root]},[[root,'cache:.angular']]);
 const original=await decodeSnapshot(new Uint8Array(await(await capture.snapshot({kind:'working-tree',name:'Synthetic capture',captureId:'b'.repeat(64)},policy,result,'f'.repeat(64))).arrayBuffer()));
 const data=path.join(temporary,'v4-policies');let running=await host(data);t.after(()=>terminateForCleanup(running.server));
 const body=encode(original.header,original.sourceBytes);
 const response=await post(running.origin,body);assert.equal(response.status,201,response.body.toString());const id=JSON.parse(response.body).id;
 for(const mutate of [p=>p.version='unknown',p=>p.extra=true,p=>p.detected[0][1]='unknown',p=>p.effective.push(root),p=>p.included=[],p=>p.manual=['z','a'],p=>p.detected.push(p.detected[0]),p=>p.included.push('../bad'),p=>p.detected=[],p=>{p.detected.unshift(['.git/node_modules','dependency:node_modules']);p.effective.unshift('.git/node_modules');}]){
  const header=structuredClone(original.header);mutate(header.exclusionPolicy);
  const invalid=encode(header,original.sourceBytes);await assert.rejects(()=>decodeSnapshot(invalid));assert.equal((await post(running.origin,invalid)).status,422);
 }
 for(const version of [2,3]){
  const header=structuredClone(original.header);header.version=version;const invalid=encode(header,original.sourceBytes);invalid[6]=48+version;
  await assert.rejects(()=>decodeSnapshot(invalid),/Unsupported saved investigation version/u);assert.equal((await post(running.origin,invalid)).status,422);
 }
 await stop(running.server);running=await host(data);
 const reopened=await request(running.origin,'/api/investigations/'+id);assert.equal(reopened.status,200);assert.deepEqual(reopened.body,body);
 const decoded=await decodeSnapshot(reopened.body);assert.deepEqual(decoded.header.exclusionPolicy,policy);assert.equal(decoded.header.files[0].path,filePath);assert.deepEqual(decoded.sourceBytes,[source]);await stop(running.server);
});

test('syntax and metric failures retain normalized source with local identity and no raw capture API',async(t)=>{
 const capture=createInvestigationCapture();assert.equal('wrap' in capture,false);
 const origin={kind:'working-tree',name:'Edited project',captureId:'c'.repeat(64)};
 const sources=['syntax.js','metrics.js'].map(canonicalPath=>({canonicalPath,normalizedUtf8:new TextEncoder().encode('const x = ;\n')}));
 const result={city:null,sources,notAnalyzedFiles:[{canonicalPath:'syntax.js',category:'Syntax could not be analyzed'},{canonicalPath:'metrics.js',category:'Metrics could not be computed'},{canonicalPath:'unsupported.js',category:'Source text is not supported'}]};
 const body=Buffer.from(await(await capture.snapshot(origin,recordExclusionPolicy([]),result,'f'.repeat(64))).arrayBuffer()),decoded=await decodeSnapshot(body);
 assert.deepEqual(decoded.header.origin,origin);assert.equal(decoded.sourceBytes.length,2);
 assert.deepEqual(decoded.header.files.map(file=>[file.path,file.normalized!==null]),[['metrics.js',true],['syntax.js',true],['unsupported.js',false]]);
 assert.deepEqual(snapshotIdentity(decoded.header),{kind:'working-tree',repository:origin.name,ref:'working tree',revision:origin.captureId});
 for(const broken of [{...result,sources:[]},{...result,sources:[...sources,sources[0]]},{...result,sources:[...sources,{canonicalPath:'unsupported.js',normalizedUtf8:new Uint8Array()}]}])await assert.rejects(()=>capture.snapshot(origin,recordExclusionPolicy([]),broken,'f'.repeat(64)),/source evidence/u);
 const running=await host(path.join(temporary,'failed-text'));t.after(()=>terminateForCleanup(running.server));
 const response=await post(running.origin,body);assert.equal(response.status,201,response.body.toString());
 assert.deepEqual((await request(running.origin,'/api/investigations/'+JSON.parse(response.body).id)).body,body);await stop(running.server);
});

test('normalized section and aggregate limits retain exact existing boundaries',async()=>{
 const {header}=await decodeSnapshot((await snapshot()).bytes);
 header.city=null;header.hierarchy=[];
 const file=index=>({path:`f${String(index).padStart(2,'0')}.js`,normalized:{length:2*1048576,sha256:'f'.repeat(64)},outcome:'Syntax could not be analyzed',fact:null,units:[],contributions:[]});
 header.files=Array.from({length:20},(_,index)=>file(index));assert.equal(validateSavedHeader(header).payloadBytes,40*1048576);
 header.files.push(file(20));assert.throws(()=>validateSavedHeader(header));header.files.pop();
 header.files[0].normalized.length++;assert.throws(()=>validateSavedHeader(header));
});

test('all-files-failed investigations remain complete and saveable without invented metrics',async()=>{
 const {bytes,result}=await snapshot('https://github.com/owner/one',SHA,true),decoded=await decodeSnapshot(bytes);
 assert.equal(result.city,null);assert.equal(decoded.header.city,null);assert.equal(decoded.header.files.length,2);
 assert.ok(decoded.header.files.every(file=>file.outcome==='Source text is not supported'&&file.fact===null&&file.normalized===null));
});

test('capture budget exhaustion disables Save without changing completed metrics or retained normalized source',async()=>{
 const {capture,result}=await snapshot();const city=result.city,sources=result.sources,inspection=capture.inspection('src/a.js');
 assert.ok(inspection);const contributions=[...inspection.contributions()];
 capture.contribution('unpublished.js',0,'x'.repeat(12*1048576),0,1);
 await assert.rejects(()=>capture.snapshot({kind:'github',repositoryUrl:'https://github.com/owner/one',revision:SHA},recordExclusionPolicy([]),result,'f'.repeat(64)),/Save limits/u);
 assert.equal(result.city,city);assert.equal(result.sources,sources);assert.equal(result.city.inspection[0].M,2);
 assert.equal(capture.inspection('src/a.js'),inspection);assert.deepEqual([...inspection.contributions()],contributions);
 capture.contribution('later.js',0,'if',0,1);
 capture.module('later.js',{units:[{kind:'top-level'}],observations:[{kind:'decision',decisionKind:'if',startByte:0,endByte:1}]},new Float64Array([2]));
 const later=capture.inspection('later.js');assert.ok(later);assert.equal(later.units.at(0).complexity,2);assert.equal(later.contributionCount,1);assert.deepEqual([...later.contributions()],[[0,'if',0,1]]);
});

test('snapshot format rejects damaged source, truncation, unknown versions, extra fields and invalid source/unit references',async()=>{
 const {bytes}=await snapshot();
 const damaged=Buffer.from(bytes);damaged[damaged.length-1]^=1;await assert.rejects(()=>decodeSnapshot(damaged));
 await assert.rejects(()=>decodeSnapshot(bytes.subarray(0,-1)));
 const decoded=await decodeSnapshot(bytes);
 for(const change of [header=>{header.version=1;},header=>{header.version=999;},header=>{header.extra=true;},header=>{header.files[0].path='../invalid.js';},header=>{header.files[1].contributions[0][0]=999;},header=>{header.hierarchy=[];},header=>{header.fixedExcludedSegments=[];}]){
  const header=structuredClone(decoded.header);change(header);assert.throws(()=>validateSavedHeader(header));
 }
 assert.throws(()=>snapshotPrefix(new Uint8Array(SAVE_LIMITS.header+1)));
});

test('deep supported hierarchy saves and reopens within existing byte budgets without a lower path-length cap',async(t)=>{
 const directory='d/'.repeat(2049),filePath=directory+'leaf.ts',raw=Buffer.from('export const x=1;\n'),capture=createInvestigationCapture();
 const gateway={async loadInventory(){return{kind:'inventory',entries:[...Array.from({length:2049},(_,i)=>({path:directory.slice(0,(i+1)*2-1),mode:'040000',type:'tree'})),{path:filePath,mode:'100644',type:'blob',sha:createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')}]};},async readRawSource(){return{kind:'source',rawBytes:Uint8Array.from(raw)};}};
 const url='https://github.com/owner/deep',acquired=await acquireProjectSources(parseRepositoryReference(url),SHA,new AbortController().signal,gateway);assert.equal(acquired.kind,'acquired');
 const analyzed=await analyzeProjectSources(acquired,createNodeTreeSitterAdapter(),undefined,capture);assert.equal(analyzed.kind,'analyzed');
 const body=Buffer.from(await(await capture.snapshot({kind:'github',repositoryUrl:url,revision:SHA},recordExclusionPolicy([]),analyzed.result,'f'.repeat(64))).arrayBuffer());
 const decoded=await decodeSnapshot(body);assert.equal(decoded.header.version,4);assert.equal(decoded.header.hierarchy.length,2049);assert.ok(decoded.header.hierarchy.at(-1).length>4096);assert.equal(decoded.header.files[0].path,filePath);assert.ok(new TextEncoder().encode(JSON.stringify(decoded.header)).length<SAVE_LIMITS.header);
 const data=path.join(temporary,'deep-store');let running=await host(data);t.after(()=>terminateForCleanup(running.server));const response=await post(running.origin,body);assert.equal(response.status,201,response.body.toString());const record=JSON.parse(response.body);
 await stop(running.server);running=await host(data);const reopened=await request(running.origin,'/api/investigations/'+record.id);assert.equal(reopened.status,200);assert.deepEqual(reopened.body,body);assert.equal((await decodeSnapshot(reopened.body)).header.files[0].path,filePath);
});

test('native validator checks normalized hashes, UTF-8, scalar spans and shape without certifying metrics',async(t)=>{
 const running=await host(path.join(temporary,'normalized-validation'));t.after(()=>terminateForCleanup(running.server));
 const original=await decodeSnapshot((await snapshot()).bytes);
 const cases=[
  value=>{value.sections[0][0]^=1;},
  value=>{value.sections[0][0]=0;},
  value=>{value.sections[0][0]=13;},
  value=>{value.sections[0][0]=0xff;},
  value=>{value.sections[0].set([0xef,0xbb,0xbf]);},
  value=>{value.sections[0].set([0xc3,0xa9]);value.header.files[1].units[1][1]=1;},
  value=>{value.header.files[0].normalized={length:0,sha256:descriptor(Buffer.alloc(0)).sha256};},
  value=>{value.header.files[1].normalized=null;},
  value=>{value.header.files[1].raw={length:0,sha256:'f'.repeat(64)};},
  value=>{value.header.origin.captureId='fake';},
 ];
 for(const [index,mutate]of cases.entries()){
  const value={header:structuredClone(original.header),sections:original.sourceBytes.map(bytes=>Buffer.from(bytes))};mutate(value);
  if(index>0&&index<6)value.header.files[1].normalized=descriptor(value.sections[0]);
  const bytes=encode(value.header,value.sections);await assert.rejects(()=>decodeSnapshot(bytes),`case ${index}`);
  assert.equal((await post(running.origin,bytes)).status,422,`case ${index}`);
 }
 const changed=original.sourceBytes.map(bytes=>Buffer.from(bytes));changed[0][0]='z'.charCodeAt(0);
 original.header.files[1].normalized=descriptor(changed[0]);
 assert.equal((await post(running.origin,encode(original.header,changed))).status,201,'saved metrics are not recomputed');
 await stop(running.server);
});

test('old seven-field receipts coexist with new local saves; unsupported old payload stays untouched',async(t)=>{
 const data=path.join(temporary,'legacy-store'),id='L'.repeat(43),directory=path.join(data,'snapshots',id);
 await mkdir(directory,{recursive:true});
 const old=Buffer.alloc(20);old.set([67,67,83,65,86,69,2,0]);
 const receipt={id,savedAt:new Date().toISOString(),repository:'owner/legacy',ref:'main',revision:SHA,bytes:old.length,sha256:descriptor(old).sha256};
 const receiptBytes=JSON.stringify(receipt)+'\n';await writeFile(path.join(directory,'record.json'),receiptBytes);await writeFile(path.join(directory,'snapshot.ccs'),old);
 assert.deepEqual(parseSavedRecord(receipt),receipt);
 assert.throws(()=>parseSavedRecord({...receipt,kind:'private'}));
 const running=await host(data);t.after(()=>terminateForCleanup(running.server));
 assert.deepEqual(JSON.parse((await request(running.origin,'/api/investigations')).body),[receipt]);
 const oldOpen=await request(running.origin,'/api/investigations/'+id);assert.equal(oldOpen.status,200);await assert.rejects(()=>decodeSnapshot(oldOpen.body),/Unsupported saved investigation version/u);
 const {result,capture}=await snapshot(),origin={kind:'working-tree',name:'Local edits',captureId:'d'.repeat(64)};
 const bytes=Buffer.from(await(await capture.snapshot(origin,recordExclusionPolicy([]),result,'f'.repeat(64))).arrayBuffer());
 const response=await post(running.origin,bytes);assert.equal(response.status,201,response.body.toString());
 const saved=JSON.parse(response.body);assert.deepEqual(snapshotIdentity({origin}),{kind:saved.kind,repository:saved.repository,ref:saved.ref,revision:saved.revision});
 assert.equal(JSON.parse((await request(running.origin,'/api/investigations')).body).length,2);
 await stop(running.server);
 assert.deepEqual(await readFile(path.join(directory,'snapshot.ccs')),old);assert.equal(await readFile(path.join(directory,'record.json'),'utf8'),receiptBytes);
});

test('multiple projects, branches, releases and commits save independently and survive an actual host process restart',async(t)=>{
 const data=path.join(temporary,'multi-store');let running=await host(data);t.after(()=>terminateForCleanup(running.server));
 const entries=[];
 for(const [url,revision]of [['https://github.com/owner/one/tree/main',SHA],['https://github.com/owner/one/tree/main','c'.repeat(40)],['https://github.com/owner/one/tree/feature/a','d'.repeat(40)],['https://github.com/owner/one/releases/tag/v1.0','e'.repeat(40)],['https://github.com/owner/two',SHA]]){
  const body=(await snapshot(url,revision)).bytes;
  const response=await post(running.origin,body);assert.equal(response.status,201,response.body.toString());
  const record=JSON.parse(response.body);assert.equal(record.kind,'github');entries.push({record,body});
 }
 assert.equal(new Set(entries.map(item=>item.record.id)).size,5);
 assert.equal((JSON.parse((await request(running.origin,'/api/investigations')).body)).length,5);
 await stop(running.server);running=await host(data);
 for(const {record,body}of entries){
  const reopened=await request(running.origin,`/api/investigations/${record.id}`);assert.equal(reopened.status,200);assert.ok(reopened.body.equals(body));
  assert.equal((await request(running.origin,`/saved/${record.id}`)).status,200);
  const receipt=JSON.parse((await request(running.origin,`/api/investigations/${record.id}/record`)).body);assert.equal(receipt.revision,record.revision);
 }
 await stop(running.server);
});

test('invalid uploads never publish, write lock affects neither saved reads nor static assets, and data paths are not URL paths',async(t)=>{
 const data=path.join(temporary,'failure-store'),running=await host(data);t.after(()=>terminateForCleanup(running.server));
 const body=(await snapshot()).bytes;
 assert.equal((await post(running.origin,body)).status,201);
 const catalog=JSON.parse((await request(running.origin,'/api/investigations')).body);
 const invalid=Buffer.from(body);invalid[0]^=1;
 assert.equal((await post(running.origin,invalid)).status,422);
 assert.equal(JSON.parse((await request(running.origin,'/api/investigations')).body).length,1);
 assert.equal((await readdir(data)).some(name=>name.startsWith('staging-')),false);
 await mkdir(path.join(data,'write-lock'));
 assert.equal((await post(running.origin,body)).status,503);
 assert.equal((await request(running.origin,`/api/investigations/${catalog[0].id}`)).status,200);
 assert.equal((await request(running.origin,'/')).status,200);
 assert.equal((await request(running.origin,'/api/investigations/..')).status,400);
 const foreign=await request(running.origin,'/api/investigations',{method:'POST',headers:{Origin:'https://evil.invalid','Content-Type':'application/octet-stream'},body});assert.equal(foreign.status,403);
 await stop(running.server);
 assert.ok((await readFile(path.join(data,'snapshots',catalog[0].id,'snapshot.ccs'))).equals(body));
});

test('a slow admitted upload excludes another writer but not static serving, then shutdown cleans owned partial work',async(t)=>{
 const data=path.join(temporary,'slow-store'),running=await host(data);t.after(()=>terminateForCleanup(running.server));
 const body=(await snapshot()).bytes;
 const acquired=new Promise(resolve=>{const watcher=watch(data,(_event,name)=>{if(name==='write-lock'){watcher.close();resolve();}});t.after(()=>watcher.close());});
 const pending=http.request(running.origin+'/api/investigations',{method:'POST',headers:{Origin:running.origin,'Content-Type':'application/octet-stream','Content-Length':body.length}});
 pending.on('error',()=>{});t.after(()=>pending.destroy());pending.write(body.subarray(0,16));
 await acquired;
 assert.equal((await post(running.origin,body)).status,503);
 assert.equal((await request(running.origin,'/')).status,200);
 assert.deepEqual(JSON.parse((await request(running.origin,'/api/investigations')).body),[]);
 await stop(running.server);pending.destroy();
 assert.deepEqual(await readdir(data),['snapshots']);
});

test('declared upload overflow is rejected before reading and an interrupted lock preserves existing reads across restart',async(t)=>{
 const data=path.join(temporary,'recovery-store');let running=await host(data);t.after(()=>terminateForCleanup(running.server));
 const body=(await snapshot()).bytes,record=JSON.parse((await post(running.origin,body)).body);
 const oversized=await request(running.origin,'/api/investigations',{method:'POST',headers:{Origin:running.origin,'Content-Type':'application/octet-stream','Content-Length':SAVE_LIMITS.snapshot+1}});assert.equal(oversized.status,413);
 await stop(running.server);await mkdir(path.join(data,'write-lock'));await mkdir(path.join(data,'staging-abandoned'));await writeFile(path.join(data,'staging-abandoned','partial'),Buffer.from('owned test partial'));
 running=await host(data);
 assert.equal((await post(running.origin,body)).status,503);assert.equal((await request(running.origin,`/api/investigations/${record.id}`)).status,200);
 assert.equal(JSON.parse((await request(running.origin,'/api/investigations')).body).length,1);
 await stop(running.server);assert.equal(await readFile(path.join(data,'staging-abandoned','partial'),'utf8'),'owned test partial');
});

test('save count, total charged storage and upload ceilings have exact inclusive boundaries',()=>{
 assert.equal(hasSaveCapacity(1023,0,192*1024*1024),true);
 assert.equal(hasSaveCapacity(1024,0,1),false);
 assert.equal(hasSaveCapacity(0,SAVE_LIMITS.storage-16385,1),true);
 assert.equal(hasSaveCapacity(0,SAVE_LIMITS.storage-16384,1),false);
 assert.equal(hasSaveCapacity(0,0,SAVE_LIMITS.snapshot+1),false);
 assert.equal(hasSaveCapacity(-1,0,1),false);
});

test('annotated tag depth accepts exactly sixteen objects and rejects a seventeenth without fetching it',async()=>{
 const ref=parseRepositoryReference('https://github.com/owner/one/releases/tag/v1');
 for(const depth of [16,17]){
  let calls=0;const sha=index=>index.toString(16).padStart(40,'0');
  const gateway=createGithubRevisionGateway(async url=>{calls++;const index=calls-1;const value=index===0?{ref:'refs/tags/v1',object:{type:'tag',sha:sha(1)}}:{sha:sha(index),object:index===depth?{type:'commit',sha:SHA}:{type:'tag',sha:sha(index+1)}};return {ok:true,url,status:200,redirected:false,body:new Response(JSON.stringify(value)).body};});
  const result=await gateway(ref,new AbortController().signal);
  assert.equal(calls,17);assert.equal(result.kind,depth===16?'revision':'invalid-evidence');
 }
});

test('a missing explicit release is revision-unavailable rather than repository-unavailable',async()=>{
 const {resolveRevision}=await import('../src/application/resolution.ts');
 const ref=parseRepositoryReference('https://github.com/owner/one/releases/tag/missing');
 assert.deepEqual(await resolveRevision(ref,new AbortController().signal,async()=>({kind:'http',status:404})),{kind:'failure',category:'Revision unavailable'});
});

test('release URLs distinguish tags from branches and peel annotated tags without provider fallback',async()=>{
 const ref=parseRepositoryReference('https://github.com/owner/one/releases/tag/v1%2Fstable');
 assert.deepEqual(ref,{owner:'owner',repository:'one',branch:null,tag:'v1/stable'});
 const urls=[];const gateway=createGithubRevisionGateway(async(url,options)=>{
  urls.push(url);assert.equal(options.credentials,'omit');
  const value=urls.length===1?{ref:'refs/tags/v1/stable',object:{type:'tag',sha:'b'.repeat(40)}}:{sha:'b'.repeat(40),object:{type:'commit',sha:SHA}};
  return {ok:true,url,status:200,redirected:false,body:new Response(JSON.stringify(value)).body};
 });
 assert.deepEqual(await gateway(ref,new AbortController().signal),{kind:'revision',revision:SHA});
 assert.ok(urls[0].endsWith('/git/ref/tags/v1%2Fstable'));assert.ok(urls[1].endsWith('/git/tags/'+'b'.repeat(40)));
});
