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
const {decodeSnapshot,validateSavedHeader,snapshotPrefix,SAVE_LIMITS,hasSaveCapacity}=await import('../src/application/saved-investigation.ts');
const {parseRepositoryReference}=await import('../src/domain/repository-reference.ts');
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
 const gateway=capture.wrap({async loadInventory(){return {kind:'inventory',entries:[{path:'src',mode:'040000',type:'tree'},...[...rows].map(([name,bytes])=>({path:name,mode:'100644',type:'blob',sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}))]};},async readRawSource(_repo,_sha,candidate){return {kind:'source',rawBytes:new Uint8Array(rows.get(candidate.rawPath))};}});
 const acquired=await acquireProjectSources(parseRepositoryReference(url),revision,new AbortController().signal,gateway);
 assert.equal(acquired.kind,'acquired');
 const analyzed=await analyzeProjectSources(acquired,createNodeTreeSitterAdapter(),undefined,capture);
 assert.equal(analyzed.kind,'analyzed');
 const blob=await capture.snapshot(url,revision,['excluded'],analyzed.result,'f'.repeat(64));
 return {bytes:Buffer.from(await blob.arrayBuffer()),result:analyzed.result,capture};
}
async function host(data){const preload=await writeSignalPreload(temporary);const server=launchStandalone({artifactRoot,preload,serverArguments:['--port','0','--data-dir',data]});return {server,origin:await readyOrigin(server)};}
async function stop(server){sendGracefulSignal(server,'SIGTERM');await expectCleanExit(server);}
const post=(origin,bytes)=>request(origin,'/api/investigations',{method:'POST',headers:{Origin:origin,'Content-Type':'application/octet-stream'},body:bytes});

test('complete snapshots retain original bytes, normalized bytes, outcomes, hierarchy, unit identities and owned contributions',async()=>{
 const saved=await snapshot(),decoded=await decodeSnapshot(saved.bytes);
 assert.equal(decoded.header.files.length,3);assert.equal(decoded.header.analyzer,'f'.repeat(64));
 assert.deepEqual(decoded.header.hierarchy,['src']);
 assert.deepEqual(decoded.header.exclusions,['excluded']);
 assert.equal(decoded.header.files[0].outcome,'Source text is not supported');
 assert.deepEqual([...decoded.sourceBytes[0]],[0xc3,0x28]);
 const file=decoded.header.files.find(file=>file.path==='src/a.js');
 assert.equal(file.fact.U,2);assert.equal(file.fact.M,2);
 assert.equal(file.units.length,2);assert.equal(file.contributions.length,1);
 assert.equal(file.units[file.contributions[0][0]][0],'function');
 assert.equal(file.contributions[0][1],'ternary');
 assert.equal(file.units[0][0],'top-level');assert.equal(file.units[0][2],file.normalized.length);
 assert.deepEqual(saved.result.city.inspection,decoded.header.city.inspection);
});

test('all-files-failed investigations remain complete and saveable without invented metrics',async()=>{
 const {bytes,result}=await snapshot('https://github.com/owner/one',SHA,true),decoded=await decodeSnapshot(bytes);
 assert.equal(result.city,null);assert.equal(decoded.header.city,null);assert.equal(decoded.header.files.length,2);
 assert.ok(decoded.header.files.every(file=>file.outcome==='Source text is not supported'&&file.fact===null&&file.normalized===null));
});

test('capture budget exhaustion disables Save without changing completed metrics or retained normalized source',async()=>{
 const {capture,result}=await snapshot();const city=result.city,sources=result.sources;
 capture.contribution('unpublished.js',0,'x'.repeat(12*1048576),0,1);
 await assert.rejects(()=>capture.snapshot('https://github.com/owner/one',SHA,[],result,'f'.repeat(64)),/Save limits/u);
 assert.equal(result.city,city);assert.equal(result.sources,sources);assert.equal(result.city.inspection[0].M,2);
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
 const gateway=capture.wrap({async loadInventory(){return{kind:'inventory',entries:[...Array.from({length:2049},(_,i)=>({path:directory.slice(0,(i+1)*2-1),mode:'040000',type:'tree'})),{path:filePath,mode:'100644',type:'blob',sha:createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')}]};},async readRawSource(){return{kind:'source',rawBytes:Uint8Array.from(raw)};}});
 const url='https://github.com/owner/deep',acquired=await acquireProjectSources(parseRepositoryReference(url),SHA,new AbortController().signal,gateway);assert.equal(acquired.kind,'acquired');
 const analyzed=await analyzeProjectSources(acquired,createNodeTreeSitterAdapter(),undefined,capture);assert.equal(analyzed.kind,'analyzed');
 const body=Buffer.from(await(await capture.snapshot(url,SHA,[],analyzed.result,'f'.repeat(64))).arrayBuffer());
 const decoded=await decodeSnapshot(body);assert.equal(decoded.header.version,2);assert.equal(decoded.header.hierarchy.length,2049);assert.ok(decoded.header.hierarchy.at(-1).length>4096);assert.equal(decoded.header.files[0].path,filePath);assert.ok(new TextEncoder().encode(JSON.stringify(decoded.header)).length<SAVE_LIMITS.header);
 const data=path.join(temporary,'deep-store');let running=await host(data);t.after(()=>terminateForCleanup(running.server));const response=await post(running.origin,body);assert.equal(response.status,201,response.body.toString());const record=JSON.parse(response.body);
 await stop(running.server);running=await host(data);const reopened=await request(running.origin,'/api/investigations/'+record.id);assert.equal(reopened.status,200);assert.deepEqual(reopened.body,body);assert.equal((await decodeSnapshot(reopened.body)).header.files[0].path,filePath);
});

test('multiple projects, branches, releases and commits save independently and survive an actual host process restart',async(t)=>{
 const data=path.join(temporary,'multi-store');let running=await host(data);t.after(()=>terminateForCleanup(running.server));
 const entries=[];
 for(const [url,revision]of [['https://github.com/owner/one/tree/main',SHA],['https://github.com/owner/one/tree/main','c'.repeat(40)],['https://github.com/owner/one/tree/feature/a','d'.repeat(40)],['https://github.com/owner/one/releases/tag/v1.0','e'.repeat(40)],['https://github.com/owner/two',SHA]]){
  const body=(await snapshot(url,revision)).bytes;
  const response=await post(running.origin,body);assert.equal(response.status,201,response.body.toString());
  const record=JSON.parse(response.body);entries.push({record,body});
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
