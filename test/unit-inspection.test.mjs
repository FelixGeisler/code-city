import assert from 'node:assert/strict';import test from 'node:test';import{registerHooks}from'node:module';import{createHash}from'node:crypto';
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(/^\.\.?\//u.test(specifier)&&!/\.[a-z]+$/iu.test(specifier)?specifier+'.ts':specifier,context);}});
const{createFileInspection:makeInspection,parseInspectionResult,validateInspectionQuery,SOURCE_PAGE_BYTES}=await import('../src/application/unit-inspection.ts');
const{createSourceColoring}=await import('../src/edge/shiki-source-highlighting.ts');
const createFileInspection=(path,bytes,evidence,color=createSourceColoring)=>makeInspection(path,bytes,evidence,color);
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
 const f=await analyze('nested.js',nested),list=await f.read({type:'units',path:'nested.js',offset:0});
 assert.deepEqual(list.rows.map(row=>[row.kind,row.complexity]),[['function',3],['arrow',2],['top-level',1]]);
 const outer=list.rows[0],inner=list.rows[1];
 assert.deepEqual((await f.read({type:'contributions',path:'nested.js',unit:outer.id,offset:0,cursor:null})).rows.map(row=>row.kind),['if','logical-and']);
 assert.deepEqual((await f.read({type:'contributions',path:'nested.js',unit:inner.id,offset:0,cursor:null})).rows.map(row=>row.kind),['ternary']);
 const excerpt=await f.read({type:'source',path:'nested.js',unit:inner.id,cursor:null});assert.equal(excerpt.text,'y => y ? 1 : 0');
 assert.equal(excerpt.start.line,3);assert.equal(excerpt.start.column,26);assert.equal(excerpt.highlights.length,1);
 const top=list.rows[2],whole=await f.read({type:'source',path:'nested.js',unit:top.id,cursor:null});assert.equal(whole.text,nested);assert.equal(whole.highlights.length,0);assert.equal(f.calls(),1);
});
test('UTF-8 byte spans map to one-based Unicode scalar columns rather than UTF-16 or byte columns',async()=>{
 const f=await analyze('unicode.ts',`const emoji = '😀'; const choose = (v: number) => v ? 'é' : 'no';\n`);
 const list=await f.read({type:'units',path:'unicode.ts',offset:0});const arrow=list.rows.find(row=>row.kind==='arrow');
 assert.equal(arrow.start.column,35);
 const source=await f.read({type:'source',path:'unicode.ts',unit:arrow.id,cursor:null});assert.equal(source.text,`(v: number) => v ? 'é' : 'no'`);
 for(const mark of source.highlights)assert.ok(source.text.slice(mark.start,mark.end).includes('é'));
});
test('JSX, TSX and C# callable evidence survives parser release',async()=>{
 for(const[path,source]of[['view.jsx','const view = x => x ? <A/> : <B/>;'],['view.tsx','const view = (x: boolean) => x ? <A/> : <B/>;'],['view.cs','class C { int M(int x) { if(x>0) return 1; return 0; } }']]){
  const f=await analyze(path,source),list=await f.read({type:'units',path,offset:0});const unit=list.rows.find(row=>row.kind!=='top-level');assert.equal(unit.complexity,2);
  assert.equal((await f.read({type:'contributions',path,unit:unit.id,offset:0,cursor:null})).rows.length,1);assert.equal(f.calls(),1);
 }
});
test('a version-2 saved snapshot restores identical unit/source/contribution views without analysis',async()=>{
 const f=await analyze('nested.js',nested);const blob=await f.capture.snapshot('https://github.com/fixture/repository','a'.repeat(40),[],f.result,'f'.repeat(64));const restored=await decodeSnapshot(new Uint8Array(await blob.arrayBuffer()));
 const file=restored.header.files[0];const read=createFileInspection(file.path,restored.sourceBytes[1],{units:{length:file.units.length,at(index){const row=file.units[index];return{kind:row[0],startByte:row[1],endByte:row[2],complexity:row[4]};}},contributionCount:file.contributions.length,contributions:()=>file.contributions});
 for(const query of [{type:'units',path:file.path,offset:0},{type:'source',path:file.path,unit:1,cursor:null},{type:'contributions',path:file.path,unit:1,offset:0,cursor:null},{type:'contributions',path:file.path,unit:1,offset:0,cursor:(await read({type:'source',path:file.path,unit:1,cursor:null})).cursor}])assert.deepEqual(await read(query),await f.read(query));assert.equal(f.calls(),1);
});
test('Save capture budget exhaustion does not remove unit inspection evidence',async()=>{
 const f=await analyze('nested.js',nested);f.capture.contribution('unpublished.js',0,'x'.repeat(12*1048576),0,1);
 const read=createFileInspection('nested.js',f.result.sources[0].normalizedUtf8,f.capture.inspection('nested.js'));assert.equal((await read({type:'units',path:'nested.js',offset:0})).total,3);
 await assert.rejects(()=>f.capture.snapshot('https://github.com/fixture/repository','a'.repeat(40),[],f.result,'f'.repeat(64)),/Save limits/u);
});
test('source and contribution pages are bounded but cover a dense long line completely',async()=>{
 const source='a&&b;'.repeat(10000),path='dense.js',bytes=encoder.encode(source);
 const read=createFileInspection(path,bytes,{units:{length:1,at(){return{kind:'top-level',startByte:0,endByte:bytes.length,complexity:10001};}},contributionCount:10000,*contributions(){for(let i=0;i<10000;i++)yield[0,'logical-and',i*5,i*5+4];}});
 let cursor=null,text='',pages=0;do{const query={type:'source',path,unit:0,cursor};const result=await read(query);assert.deepEqual(parseInspectionResult(result,query),result);assert.ok(encoder.encode(result.text).length<=SOURCE_PAGE_BYTES);text+=result.text;cursor=result.next;pages++;}while(cursor!==null);
 assert.equal(text,source);assert.ok(pages>1);
 const page=await read({type:'contributions',path,unit:0,offset:32,cursor:null});assert.equal(page.rows.length,32);assert.equal(page.rows[0].start.column,161);
});
test('unit paging uses stable complexity/start/end/kind order and exposes zero-unit files honestly',async()=>{
 const units=Array.from({length:40},(_,id)=>({kind:id%2?'method':'arrow',startByte:id,endByte:100,complexity:1}));
 const read=createFileInspection('units.js',encoder.encode('x'.repeat(100)),{units:{length:units.length,at:id=>units[id]},contributionCount:0,contributions:()=>[]});
 assert.equal((await read({type:'units',path:'units.js',offset:0})).rows.length,32);assert.equal((await read({type:'units',path:'units.js',offset:32})).rows.length,8);
 const empty=createFileInspection('empty.js',new Uint8Array(),{units:{length:0,at:()=>undefined},contributionCount:0,contributions:()=>[]});assert.deepEqual((await empty({type:'units',path:'empty.js',offset:0})).rows,[]);
 await assert.rejects(()=>empty({type:'source',path:'empty.js',unit:0,cursor:null}));
});
test('inspection boundaries reject foreign paths, malformed metadata, out-of-range and split-scalar spans',()=>{
 assert.throws(()=>validateInspectionQuery({type:'units',path:'../bad.js',offset:0}));assert.throws(()=>validateInspectionQuery({type:'units',path:'ok.js',offset:0,extra:true}));
 assert.throws(()=>createFileInspection('bad.js',encoder.encode('é'),{units:{length:1,at:()=>({kind:'arrow',startByte:1,endByte:2,complexity:1})},contributionCount:0,contributions:()=>[]}));
 const query={type:'source',path:'ok.js',unit:0,cursor:null};const result={type:'source',path:'ok.js',unit:0,kind:'top-level',complexity:1,start:{line:1,column:1},end:{line:1,column:2},cursor:0,next:null,text:'😀',syntax:[],syntaxUnavailable:false,highlights:[{start:0,end:1}]};assert.throws(()=>parseInspectionResult(result,query));
 assert.throws(()=>parseInspectionResult({...result,highlights:[],path:'other.js'},query));
 assert.throws(()=>parseInspectionResult({...result,highlights:[],syntax:[{color:6,start:0,end:1}]},query));
 assert.throws(()=>parseInspectionResult({...result,highlights:[],syntax:[{color:'url(javascript:alert(1))',start:0,end:2}]},query));
 assert.throws(()=>parseInspectionResult({...result,highlights:[],syntax:[{color:6,start:0,end:2},{color:1,start:0,end:2}]},query));
 assert.deepEqual(parseInspectionResult({...result,highlights:[],syntax:[{color:6,start:0,end:2}]},query).syntax,[{color:6,start:0,end:2}]);
 for(const color of [-1,13,0.5,NaN])assert.throws(()=>parseInspectionResult({...result,highlights:[],syntax:[{color,start:0,end:2}]},query));
 assert.throws(()=>parseInspectionResult({...result,highlights:[],syntaxUnavailable:true,syntax:[{color:6,start:0,end:2}]},query));
});
test('paged Unicode source keeps whole-file comment context and bounded validated syntax spans',async()=>{
 const source='/* '+ '😀 x '.repeat(2000)+' if */\nconst text = "yes";',path='context.ts',bytes=encoder.encode(source);
 const read=createFileInspection(path,bytes,{units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:bytes.length,complexity:1})},contributionCount:0,contributions:()=>[]});
 let cursor=null,whole='',pages=0;do{const query={type:'source',path,unit:0,cursor},page=await read(query);parseInspectionResult(page,query);assert.equal(page.syntax[0].color,1);assert.equal(page.syntax[0].start,0);assert.ok(page.syntax.length<=SOURCE_PAGE_BYTES);whole+=page.text;cursor=page.next;pages++;}while(cursor!==null);
 assert.equal(whole,source);assert.ok(pages>1);
});
test('explicit spans and 80-LF pages preserve full-file grammar context',async()=>{
 const source='/* before\n'+'continued 😀\n'.repeat(170)+'after */\nreturn 1;',path='context.js',bytes=encoder.encode(source);
 const start=encoder.encode(source.slice(0,source.indexOf('continued'))).length,end=bytes.length;
 const read=createFileInspection(path,bytes,{units:{length:1,at:()=>({kind:'function',startByte:start,endByte:end,complexity:1})},contributionCount:0,contributions:()=>[]});
 let cursor=null,whole='',pages=0;
 do{const query={type:'source',path,unit:0,cursor},page=await read(query);parseInspectionResult(page,query);assert.equal(page.syntax[0].color,1);assert.ok(page.text.split('\n').length-1<=80);whole+=page.text;cursor=page.next;pages++;}while(cursor!==null);
 assert.equal(whole,decoder.decode(bytes.subarray(start)));assert.equal(pages,3);
});
test('initialization and tokenization failures keep exact source and ownership without retry',async()=>{
 const source='if (😀) x;\n'.repeat(100),path='failure.js',bytes=encoder.encode(source);
 const evidence={units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:bytes.length,complexity:2})},contributionCount:1,contributions:()=>[[0,'if',0,bytes.length]]};
 for(const stage of ['init','tokenize']){
  let calls=0,tokens=0;
  const read=createFileInspection(path,bytes,evidence,async()=>{calls++;if(stage==='init')throw Error('grammar unavailable');return()=>{tokens++;throw Error('tokenization unavailable');};});
  await read({type:'units',path,offset:0});await read({type:'contributions',path,unit:0,offset:0,cursor:null});assert.equal(calls,0);
  let cursor=null,whole='';do{const query={type:'source',path,unit:0,cursor},page=await read(query);parseInspectionResult(page,query);assert.equal(page.syntaxUnavailable,true);assert.deepEqual(page.syntax,[]);assert.deepEqual(page.highlights,[{start:0,end:page.text.length}]);whole+=page.text;cursor=page.next;}while(cursor!==null);
  assert.equal(whole,source);await read({type:'source',path,unit:0,cursor:null});assert.equal(calls,1);assert.equal(tokens,stage==='init'?0:1);
 }
});
test('concurrent source reads share initialization and retain separate source identities',async()=>{
 const source='/* comment */\nreturn 1;',path='concurrent.js',bytes=encoder.encode(source),pending=Promise.withResolvers();let calls=0;
 const read=createFileInspection(path,bytes,{units:{length:2,at:id=>({kind:id?'function':'top-level',startByte:id?3:0,endByte:bytes.length,complexity:1})},contributionCount:0,contributions:()=>[]},()=>{calls++;return pending.promise;});
 const first=read({type:'source',path,unit:0,cursor:null}),second=read({type:'source',path,unit:1,cursor:null});
 await Promise.resolve();assert.equal(calls,1);
 pending.resolve(await createSourceColoring(path,source));
 const[a,b]=await Promise.all([first,second]);assert.equal(a.unit,0);assert.equal(b.unit,1);assert.equal(a.text,source);assert.equal(b.text,source.slice(3));assert.equal(b.syntax[0].color,1);
});
test('a long complexity-28 unit separates its whole range from its first source page and jumps to retained decisions',async()=>{
 const lines=Array(1371).fill('');lines[659]='function long(x) {';for(let i=0;i<27;i++)lines[974+i*14]=' if(x) x--;';lines[1370]='}';
 const f=await analyze('long.js',lines.join('\n')),list=await f.read({type:'units',path:'long.js',offset:0}),unit=list.rows[0];
 assert.equal(unit.kind,'function');assert.equal(unit.complexity,28);assert.deepEqual(unit.start,{line:660,column:1});assert.deepEqual(unit.end,{line:1371,column:2});
 const initial=await f.read({type:'source',path:'long.js',unit:unit.id,cursor:null});assert.equal(initial.start.line,660);assert.equal(initial.end.line,740);
 const scoped=await f.read({type:'contributions',path:'long.js',unit:unit.id,offset:0,cursor:initial.cursor});assert.equal(scoped.total,0);assert.equal(scoped.unitTotal,27);assert.deepEqual(scoped.rows,[]);
 const allQuery={type:'contributions',path:'long.js',unit:unit.id,offset:0,cursor:null},all=await f.read(allQuery);parseInspectionResult(all,allQuery);assert.equal(all.rows.length,27);assert.equal(all.rows[0].start.line,975);
 const jumped=await f.read({type:'source',path:'long.js',unit:unit.id,cursor:all.rows[0].cursor});assert.equal(jumped.start.line,975);assert.ok(jumped.text.startsWith('if(x)'));assert.ok(jumped.highlights.length>0);
 const query={type:'contributions',path:'long.js',unit:unit.id,offset:0,cursor:jumped.cursor},matching=await f.read(query);parseInspectionResult(matching,query);assert.ok(matching.total>0&&matching.total<27);assert.equal(matching.unitTotal,27);
 assert.ok(matching.rows.every(row=>row.start.line>=jumped.start.line&&row.start.line<jumped.end.line));assert.equal(f.calls(),1);
});
test('visible contribution membership uses half-open byte spans, retains crossing owners and excludes adjacent spans',async()=>{
 const path='edges.js',bytes=encoder.encode('x'.repeat(17000)),evidence={units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:bytes.length,complexity:4})},contributionCount:3,contributions:()=>[[0,'if',0,8192],[0,'loop',8191,8193],[0,'logical-or',8192,16384]]};
 const read=createFileInspection(path,bytes,evidence);const page=cursor=>read({type:'contributions',path,unit:0,offset:0,cursor});
 const a=await page(0),b=await page(8192),c=await page(16384);assert.deepEqual(a.rows.map(row=>row.kind),['if','loop']);assert.deepEqual(b.rows.map(row=>row.kind),['loop','logical-or']);assert.equal(c.total,0);assert.equal(c.unitTotal,3);
 const all=await page(null);assert.equal(all.total,3);assert.equal(all.rows[1].cursor,8191);
 const query={type:'contributions',path,unit:0,offset:0,cursor:0};assert.throws(()=>parseInspectionResult({...a,cursor:8192},query));assert.throws(()=>parseInspectionResult({...a,unitTotal:0},query));assert.throws(()=>parseInspectionResult({...a,rows:a.rows.map(row=>({...row,cursor:-1}))},query));
 await assert.rejects(()=>read({...query,offset:3}));await assert.rejects(()=>read({...query,cursor:17001}));
 const unicode=createFileInspection('unicode.js',encoder.encode('😀'),{units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:4,complexity:1})},contributionCount:0,contributions:()=>[]});await assert.rejects(()=>unicode({type:'contributions',path:'unicode.js',unit:0,offset:0,cursor:1}));
});
test('equal one-point contributions use global source-position ties before bounded paging, not capture order',async()=>{
 const path='order.js',bytes=encoder.encode('x'.repeat(100)),records=Array.from({length:70},(_,index)=>[0,'if',69-index,70-index]);
 const read=createFileInspection(path,bytes,{units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:100,complexity:71})},contributionCount:70,contributions:()=>records});
 const rows=[];for(const offset of[0,32,64]){const page=await read({type:'contributions',path,unit:0,offset,cursor:null});assert.equal(page.unitTotal,70);rows.push(...page.rows);}
 assert.deepEqual(rows.map(row=>row.cursor),Array.from({length:70},(_,index)=>index));assert.deepEqual(rows.map(row=>row.id),Array.from({length:70},(_,index)=>index));assert.equal((await read({type:'units',path,offset:0})).rows[0].complexity,1+rows.length);
});
