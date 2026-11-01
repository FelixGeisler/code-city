import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
registerHooks({resolve(s,c,next){return next(/^\.\.?\//u.test(s)&&! /\.[a-z]+$/iu.test(s)?s+'.ts':s,c);}});
const {AUTOMATIC_EXCLUSION_RULES,automaticRule,recordExclusionPolicy,parseRecordedExclusionPolicy}=await import('../src/domain/exclusion-policy.ts');
const {prepareSourceInventory,compareUnsignedUtf8}=await import('../src/domain/source-admission.ts');
const {createLocalFolderGateway}=await import('../src/edge/local-folder-gateway.ts');
const {acquireLocalWorkingTree}=await import('../src/application/local-source.ts');
const {createGithubRawSourceGateway}=await import('../src/edge/github-source-gateway.ts');
const {acquireProjectSources}=await import('../src/application/source-retrieval.ts');
const signal=()=>new AbortController().signal;
function inventory(paths){const entries=new Map();for(const path of paths){const parts=path.split('/');for(let i=1;i<parts.length;i++)entries.set(parts.slice(0,i).join('/'),{path:parts.slice(0,i).join('/'),mode:'040000',type:'tree'});entries.set(path,{path,mode:'100644',type:'blob'});}return [...entries.values()];}
function native(paths,entered=[],reads=[]){
 const tree={};
 for(const path of paths){const parts=path.split('/');let dir=tree;for(const part of parts.slice(0,-1))dir=dir[part]??={};dir[parts.at(-1)]=null;}
 const directory=(name,tree,prefix='')=>({name,kind:'directory',async *values(){
  entered.push(prefix);
  for(const [name,value]of Object.entries(tree)){
   const path=prefix?prefix+'/'+name:name;
   yield value===null?{name,kind:'file',async getFile(){reads.push(path);const b=new Blob(['export const x=1;']);return {size:b.size,lastModified:1,stream:()=>b.stream()};}}:directory(name,value,path);
  }
 }});
 return directory('Synthetic',tree);
}

test('every pinned directory rule prunes at depth, with exact case/boundaries and narrow Yarn pairs',()=>{
 assert.deepEqual(AUTOMATIC_EXCLUSION_RULES.map(r=>r.id),['dependency:node_modules','dependency:bower_components','dependency:.pnpm-store','dependency:.yarn/cache','dependency:.yarn/unplugged','output:dist','output:build','output:bin','output:obj','output:coverage','output:.nyc_output','cache:.angular','cache:.next','cache:.nuxt','cache:.svelte-kit','cache:.parcel-cache','cache:.vite','cache:.turbo','cache:.nx']);
 for(const rule of AUTOMATIC_EXCLUSION_RULES){
  assert.equal(automaticRule('deep/'+rule.path)?.id,rule.id);
  const result=prepareSourceInventory(inventory(['keep.ts','deep/'+rule.path+'/x.ts']));assert.deepEqual(result.candidates.map(x=>x.canonicalPath),['keep.ts']);
  for(const name of [rule.path+'-other',rule.path.toUpperCase()])assert.equal(prepareSourceInventory(inventory([name+'/x.ts'])).kind,'candidates');
 }
 for(const name of ['vendor','packages','generated','.cache','.yarn/plugins','.yarn/config','.yarn/cache-other','mydist','Build'])assert.equal(prepareSourceInventory(inventory([name+'/x.ts'])).kind,'candidates');
 assert.equal(prepareSourceInventory([{path:'node_modules.ts',mode:'100644',type:'blob'}]).kind,'candidates');
});

test('local defaults prune before values/getFile; exact includes reveal source but not siblings/nested matches or .git',async()=>{
 const paths=['src/a.ts','a/node_modules/included.ts','a/node_modules/node_modules/hidden.ts','b/node_modules/sibling.ts','.GiT/node_modules/private.ts','.yarn/plugins/plugin.ts','Web/ClientApp/.angular/cache/22/app/vite/deps/dependency.js'];
 const entered=[],reads=[],reports=[];
 const settings={manual:[],included:['.GiT/node_modules','a/node_modules']};
 const result=await acquireLocalWorkingTree('Synthetic',settings,signal(),createLocalFolderGateway(native(paths,entered,reads)),undefined,(p,c)=>reports.push([p,c]));
 assert.equal(result.kind,'success');
 assert.deepEqual(result.acquired.modules.map(x=>x.canonicalPath),['.yarn/plugins/plugin.ts','a/node_modules/included.ts','src/a.ts']);
 for(const path of ['a/node_modules/node_modules','b/node_modules','.GiT','Web/ClientApp/.angular'])assert.ok(!entered.includes(path),path);
 const [policy,complete]=reports.at(-1);assert.equal(complete,true);assert.deepEqual(policy.included,settings.included);
 assert.deepEqual(policy.detected.map(x=>x[0]),['Web/ClientApp/.angular','a/node_modules','a/node_modules/node_modules','b/node_modules']);
 assert.deepEqual(policy.effective,['Web/ClientApp/.angular','a/node_modules/node_modules','b/node_modules']);assert.deepEqual(parseRecordedExclusionPolicy(policy),policy);
 assert.ok(reads.includes('a/node_modules/included.ts'));
 const manual=await acquireLocalWorkingTree('Synthetic',{manual:['a/node_modules'],included:['a/node_modules']},signal(),createLocalFolderGateway(native(paths)));
 assert.ok(!manual.acquired.modules.some(x=>x.canonicalPath.startsWith('a/')));
});

test('GitHub projector and second admission both retain overridden blob identity/read after full validation',async()=>{
 const revision='a'.repeat(40),root='b'.repeat(40),bytes=new TextEncoder().encode('export const x=1;');
 const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 const paths=['a/node_modules/yes.ts','a/node_modules/.vite/no.ts','b/node_modules/no.ts','.yarn/plugins/yes.ts'];
 const tree=inventory(paths).map(e=>({...e,sha:e.type==='blob'?sha:root}));const urls=[];
 const fetcher=async url=>{urls.push(url);const body=url.includes('/git/commits/')?JSON.stringify({sha:revision,tree:{sha:root}}):url.includes('/git/trees/')?JSON.stringify({sha:root,truncated:false,tree}):bytes;return {url,status:200,redirected:false,body:new Response(body).body};};
 const reports=[];const settings={manual:[],included:['a/node_modules']};
 const result=await acquireProjectSources({owner:'synthetic',repository:'fixture',branch:null},revision,signal(),createGithubRawSourceGateway(fetcher),undefined,settings,(p,c)=>reports.push([p,c]));
 assert.equal(result.kind,'acquired');assert.deepEqual(result.modules.map(x=>x.canonicalPath),['.yarn/plugins/yes.ts','a/node_modules/yes.ts']);
 assert.equal(urls.filter(x=>x.startsWith('https://raw.')).length,2);
 assert.deepEqual(reports.at(-1)[0].detected.map(x=>x[0]),['a/node_modules','a/node_modules/.vite','b/node_modules']);
 const invalid=[...tree,{path:'b/node_modules/../bad.ts',mode:'100644',type:'blob'}];let reported=false;
 assert.equal(prepareSourceInventory(invalid,settings,()=>reported=true).kind,'failure');assert.equal(reported,false);
});

test('all-excluded and partial failures retain honest detections without hidden descendants',async()=>{
 const reports=[];const gateway=createLocalFolderGateway(native(['.angular/cache/app.ts']));
 assert.equal((await gateway.loadInventory([],signal(),(p,c)=>reports.push([p,c]))).kind,'failure');
 assert.deepEqual(reports.at(-1),[recordExclusionPolicy([], [['.angular','cache:.angular']]),true]);
 const partial=createLocalFolderGateway({kind:'directory',async *values(){yield {name:'.next',kind:'directory',values(){throw Error('must prune');}};throw Error('enumeration denied');}});
 assert.equal((await partial.loadInventory([],signal(),(p,c)=>reports.push([p,c]))).kind,'failure');
 assert.equal(reports.at(-1)[1],false);assert.deepEqual(reports.at(-1)[0].detected,[['.next','cache:.next']]);
});

test('reporting failure cannot abandon a native iterator or leak a raw failure',async()=>{
 let closed=false;
 const root={kind:'directory',async *values(){try{yield {name:'.next',kind:'directory',values(){throw Error('Pruned');}};}finally{closed=true;}}};
 const result=await acquireLocalWorkingTree('Synthetic',[],signal(),createLocalFolderGateway(root),undefined,()=>{throw Error('Broken reporter');});
 assert.deepEqual(result,{kind:'failure',category:'Local working tree unavailable'});assert.equal(closed,true);
});

test('strict pinned policy rejects invalid shapes/order/IDs/hidden roots and inconsistent effective settings',()=>{
 const original=recordExclusionPolicy({manual:['z'],included:['a/node_modules']},[['a/node_modules','dependency:node_modules'],['a/node_modules/.vite','cache:.vite']]);
 assert.deepEqual(parseRecordedExclusionPolicy(original),original);
 for(const change of [p=>p.version='future',p=>p.extra=1,p=>p.detected.reverse(),p=>p.detected[0][1]='dependency:dist',p=>p.effective=[],p=>p.included=[],p=>p.manual=['z','a'],p=>p.included.push('vendor'),p=>p.detected.push(['z/.next','cache:.next']),p=>p.detected.push(['x/node_modules/.vite','cache:.vite'])]){
  const copy=structuredClone(original);change(copy);assert.throws(()=>parseRecordedExclusionPolicy(copy));
 }
 assert.deepEqual(recordExclusionPolicy({manual:[],included:['future/.next']}).included,['future/.next']);
 const sorted=['é','a','😀'].sort(compareUnsignedUtf8);assert.deepEqual(sorted,['a','é','😀']);
});
