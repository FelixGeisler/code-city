import assert from 'node:assert/strict';import test from 'node:test';import{registerHooks}from'node:module';import{createHash}from'node:crypto';
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(/^\.\.?\//u.test(specifier)&&!/\.[a-z]+$/iu.test(specifier)?specifier+'.ts':specifier,context);}});
const{createFileInspection,parseInspectionResult,validateInspectionQuery,SOURCE_PAGE_BYTES}=await import('../src/application/unit-inspection.ts');
const{createInvestigationCapture}=await import('../src/application/investigation-capture.ts');
const{analyzeProjectSources}=await import('../src/application/project-analysis.ts');
const{createNodeTreeSitterAdapter}=await import('../src/edge/node/parser-assets.ts');
const{decodeSnapshot}=await import('../src/application/saved-investigation.ts');
const encoder=new TextEncoder(),decoder=new TextDecoder();
async function analyze(path,source){
 const bytes=encoder.encode(source),capture=createInvestigationCapture();let calls=0;const real=createNodeTreeSitterAdapter();
 const parser={initialize:()=>real.initialize(),project(...args){calls++;return real.project(...args);}};
 const raw=encoder.encode('\ufeff'+source.replaceAll('\n','\r\n'));const blob=createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
 await capture.wrap({async readRawSource(){return{kind:'source',rawBytes:raw};},async loadInventory(){throw Error('unused');}}).readRawSource({},'a'.repeat(40),{canonicalPath:path,rawPath:path,expectedBlobId:blob});
 const result=await analyzeProjectSources({kind:'acquired',selected:'a'.repeat(40),modules:[{canonicalPath:path,normalizedSource:source,normalizedUtf8:bytes}],notAnalyzedFiles:[]},parser,undefined,capture);
 assert.equal(result.kind,'analyzed');assert.equal(result.result.notAnalyzedFiles.length,0);
 return{capture,result:result.result,read:createFileInspection(path,bytes,capture.inspection(path)),calls:()=>calls,source};
}
const nested=`const label = '😀';\nfunction outer(x) {\n  if (x) { const inner = y => y ? 1 : 0; }\n  return x && 1;\n}\n`;
test('real retained units sort by complexity and expose only recorded owners without parsing again',async()=>{
 const f=await analyze('nested.js',nested),list=f.read({type:'units',path:'nested.js',offset:0});
 assert.deepEqual(list.rows.map(row=>[row.kind,row.complexity]),[['function',3],['arrow',2],['top-level',1]]);
 const outer=list.rows[0],inner=list.rows[1];
 assert.deepEqual(f.read({type:'contributions',path:'nested.js',unit:outer.id,offset:0}).rows.map(row=>row.kind),['if','logical-and']);
 assert.deepEqual(f.read({type:'contributions',path:'nested.js',unit:inner.id,offset:0}).rows.map(row=>row.kind),['ternary']);
 const excerpt=f.read({type:'source',path:'nested.js',unit:inner.id,cursor:null});assert.equal(excerpt.text,'y => y ? 1 : 0');
 assert.equal(excerpt.start.line,3);assert.equal(excerpt.start.column,26);assert.equal(excerpt.highlights.length,1);
 const top=list.rows[2],whole=f.read({type:'source',path:'nested.js',unit:top.id,cursor:null});assert.equal(whole.text,nested);assert.equal(whole.highlights.length,0);assert.equal(f.calls(),1);
});
test('UTF-8 byte spans map to one-based Unicode scalar columns rather than UTF-16 or byte columns',async()=>{
 const f=await analyze('unicode.ts',`const emoji = '😀'; const choose = (v: number) => v ? 'é' : 'no';\n`);
 const list=f.read({type:'units',path:'unicode.ts',offset:0});const arrow=list.rows.find(row=>row.kind==='arrow');
 assert.equal(arrow.start.column,35);
 const source=f.read({type:'source',path:'unicode.ts',unit:arrow.id,cursor:null});assert.equal(source.text,`(v: number) => v ? 'é' : 'no'`);
 for(const mark of source.highlights)assert.ok(source.text.slice(mark.start,mark.end).includes('é'));
});
test('JSX, TSX and C# callable evidence survives parser release',async()=>{
 for(const[path,source]of[['view.jsx','const view = x => x ? <A/> : <B/>;'],['view.tsx','const view = (x: boolean) => x ? <A/> : <B/>;'],['view.cs','class C { int M(int x) { if(x>0) return 1; return 0; } }']]){
  const f=await analyze(path,source),list=f.read({type:'units',path,offset:0});const unit=list.rows.find(row=>row.kind!=='top-level');assert.equal(unit.complexity,2);
  assert.equal(f.read({type:'contributions',path,unit:unit.id,offset:0}).rows.length,1);assert.equal(f.calls(),1);
 }
});
test('a version-1 saved snapshot restores identical unit/source/contribution views without analysis',async()=>{
 const f=await analyze('nested.js',nested);const blob=await f.capture.snapshot('https://github.com/fixture/repository','a'.repeat(40),[],f.result,'f'.repeat(64));const restored=await decodeSnapshot(new Uint8Array(await blob.arrayBuffer()));
 const file=restored.header.files[0];const read=createFileInspection(file.path,restored.sourceBytes[1],{units:{length:file.units.length,at(index){const row=file.units[index];return{kind:row[0],startByte:row[1],endByte:row[2],complexity:row[4]};}},contributionCount:file.contributions.length,contributions:()=>file.contributions});
 for(const query of [{type:'units',path:file.path,offset:0},{type:'source',path:file.path,unit:1,cursor:null},{type:'contributions',path:file.path,unit:1,offset:0}])assert.deepEqual(read(query),f.read(query));assert.equal(f.calls(),1);
});
test('Save capture budget exhaustion does not remove unit inspection evidence',async()=>{
 const f=await analyze('nested.js',nested);f.capture.contribution('unpublished.js',0,'x'.repeat(12*1048576),0,1);
 const read=createFileInspection('nested.js',f.result.sources[0].normalizedUtf8,f.capture.inspection('nested.js'));assert.equal(read({type:'units',path:'nested.js',offset:0}).total,3);
 await assert.rejects(()=>f.capture.snapshot('https://github.com/fixture/repository','a'.repeat(40),[],f.result,'f'.repeat(64)),/Save limits/u);
});
test('source and contribution pages are bounded but cover a dense long line completely',()=>{
 const source='a&&b;'.repeat(10000),path='dense.js',bytes=encoder.encode(source);
 const read=createFileInspection(path,bytes,{units:{length:1,at(){return{kind:'top-level',startByte:0,endByte:bytes.length,complexity:10001};}},contributionCount:10000,*contributions(){for(let i=0;i<10000;i++)yield[0,'logical-and',i*5,i*5+4];}});
 let cursor=null,text='',pages=0;do{const query={type:'source',path,unit:0,cursor};const result=read(query);assert.deepEqual(parseInspectionResult(result,query),result);assert.ok(encoder.encode(result.text).length<=SOURCE_PAGE_BYTES);text+=result.text;cursor=result.next;pages++;}while(cursor!==null);
 assert.equal(text,source);assert.ok(pages>1);
 const page=read({type:'contributions',path,unit:0,offset:32});assert.equal(page.rows.length,32);assert.equal(page.rows[0].start.column,161);
});
test('unit paging uses stable complexity/start/end/kind order and exposes zero-unit files honestly',()=>{
 const units=Array.from({length:40},(_,id)=>({kind:id%2?'method':'arrow',startByte:id,endByte:100,complexity:1}));
 const read=createFileInspection('units.js',encoder.encode('x'.repeat(100)),{units:{length:units.length,at:id=>units[id]},contributionCount:0,contributions:()=>[]});
 assert.equal(read({type:'units',path:'units.js',offset:0}).rows.length,32);assert.equal(read({type:'units',path:'units.js',offset:32}).rows.length,8);
 const empty=createFileInspection('empty.js',new Uint8Array(),{units:{length:0,at:()=>undefined},contributionCount:0,contributions:()=>[]});assert.deepEqual(empty({type:'units',path:'empty.js',offset:0}).rows,[]);
 assert.throws(()=>empty({type:'source',path:'empty.js',unit:0,cursor:null}));
});
test('inspection boundaries reject foreign paths, malformed metadata, out-of-range and split-scalar spans',()=>{
 assert.throws(()=>validateInspectionQuery({type:'units',path:'../bad.js',offset:0}));assert.throws(()=>validateInspectionQuery({type:'units',path:'ok.js',offset:0,extra:true}));
 assert.throws(()=>createFileInspection('bad.js',encoder.encode('é'),{units:{length:1,at:()=>({kind:'arrow',startByte:1,endByte:2,complexity:1})},contributionCount:0,contributions:()=>[]}));
 const query={type:'source',path:'ok.js',unit:0,cursor:null};const result={type:'source',path:'ok.js',unit:0,kind:'top-level',complexity:1,start:{line:1,column:1},end:{line:1,column:2},cursor:0,next:null,text:'😀',highlights:[{start:0,end:1}]};assert.throws(()=>parseInspectionResult(result,query));
 assert.throws(()=>parseInspectionResult({...result,highlights:[],path:'other.js'},query));
});
