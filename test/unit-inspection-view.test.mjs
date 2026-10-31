import assert from 'node:assert/strict';import test from 'node:test';import{registerHooks}from'node:module';
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(/^\.\.?\//u.test(specifier)&&!/\.[a-z]+$/iu.test(specifier)?specifier+'.ts':specifier,context);}});
const{attachUnitInspection,unitKindLabel}=await import('../src/edge/unit-inspection-view.ts');const{createFileInspection:makeInspection}=await import('../src/application/unit-inspection.ts');
const{createSourceColoring}=await import('../src/edge/shiki-source-highlighting.ts');
const createFileInspection=(path,bytes,evidence,color=createSourceColoring)=>makeInspection(path,bytes,evidence,color);
class Element extends EventTarget{
 constructor(tag){super();this.tagName=tag.toUpperCase();this.dataset={};this.children=[];this.attributes={};this.open=false;this.hidden=false;this.ownText='';}
 set textContent(value){this.ownText=value;this.children=[];}get textContent(){return this.ownText+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
 set innerHTML(_value){throw Error('Unsafe HTML sink');}
 append(...children){this.children.push(...children);}replaceChildren(...children){this.children=[];this.ownText='';this.append(...children);}setAttribute(name,value){this.attributes[name]=value;}
 click(){this.dispatchEvent(new Event('click'));}showModal(){this.open=true;}close(){this.open=false;this.dispatchEvent(new Event('close'));}
}
const documentTarget={createElement:tag=>new Element(tag)};
function all(node,predicate){return[predicate(node)?node:null,...node.children.filter(child=>typeof child!=='string').flatMap(child=>all(child,predicate))].filter(Boolean);}
const data=(root,key)=>all(root,node=>Object.hasOwn(node.dataset,key))[0];const button=(root,text)=>all(root,node=>node.tagName==='BUTTON'&&node.textContent===text)[0];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function reader(source,units,contributions=[]){return createFileInspection('file.js',new TextEncoder().encode(source),{units:{length:units.length,at:index=>units[index]},contributionCount:contributions.length,contributions:()=>contributions});}

test('file selection lists units without opening source, then renders inert read-only source and textual owned locations',async()=>{
 const source=`if (x) '<img src=x onerror=alert(1)>';\n`,host=new Element('section'),calls=[];
 const read=reader(source,[{kind:'top-level',startByte:0,endByte:source.length,complexity:2}],[[0,'if',0,source.length-1]]);
 const sourceReply=Promise.withResolvers();
 const release=attachUnitInspection(documentTarget,host,'file.js',async query=>{calls.push(query);const result=await read(query);if(query.type==='source')sourceReply.resolve();return result;});await flush();
 assert.deepEqual(calls.map(row=>row.type),['units']);assert.equal(data(host,'unitSource').open,false);
 const open=all(host,node=>Object.hasOwn(node.dataset,'unit'))[0];open.click();await sourceReply.promise;await flush();
 assert.equal(data(host,'unitSource').open,true);assert.ok(data(host,'sourceCode').textContent.includes('<img src=x onerror=alert(1)>'));
 assert.equal(all(host,node=>node.tagName==='IMG'||node.tagName==='SCRIPT').length,0);assert.equal(all(data(host,'sourceCode'),node=>node.tagName==='MARK').length,0);
 all(host,node=>Object.hasOwn(node.dataset,'contribution'))[0].click();await flush();assert.equal(all(data(host,'sourceCode'),node=>node.tagName==='MARK').length,1);
 data(host,'unitSource').dispatchEvent(new Event('close'));assert.ok(data(host,'sourceCode').children.length>0,'a queued prior close event must not clear a reopened dialog');
 const colored=all(data(host,'sourceCode'),node=>Object.hasOwn(node.dataset,'syntaxColor'));
 assert.ok(colored.some(node=>node.dataset.syntaxColor==='5'&&node.textContent==='if'));
 assert.ok(colored.some(node=>node.dataset.syntaxColor==='6'&&node.textContent.includes('<img')));
 assert.equal(all(data(host,'sourceCode'),node=>node.tagName==='CODE').map(node=>node.textContent).join('\n'),source);
 assert.match(data(host,'contributionRows').textContent,/if · 1:1–1:/u);assert.match(data(host,'unitDetails').textContent,/Complexity 2/u);
 button(host,'Close source').click();assert.equal(data(host,'unitSource').open,false);release();
});
test('bounded unit pages preserve all entries and source is still explicit',async()=>{
 const source='x'.repeat(80),units=Array.from({length:35},(_,index)=>({kind:'arrow',startByte:index,endByte:80,complexity:1}));const host=new Element('section');
 let reads=0;const release=attachUnitInspection(documentTarget,host,'file.js',async query=>{reads++;return reader(source,units)(query);});await flush();
 assert.equal(data(host,'unitRows').children.length,32);button(host,'Next units').click();await flush();assert.equal(data(host,'unitRows').children.length,3);assert.equal(data(host,'unitSource').open,false);
 button(host,'Previous units').click();await flush();assert.equal(data(host,'unitRows').children.length,32);const stale=button(host,'Next units'),before=reads;release();stale.click();await flush();assert.equal(reads,before);
});
test('closing or replacing a view makes late source and list callbacks inert without erasing file metrics',async()=>{
 const host=new Element('section'),metric=new Element('dl');metric.textContent='metrics retained';host.append(metric);
 const read=reader('value;',[{kind:'top-level',startByte:0,endByte:6,complexity:1}]),pending=Promise.withResolvers();
 const release=attachUnitInspection(documentTarget,host,'file.js',query=>query.type==='source'?pending.promise:Promise.resolve(read(query)));await flush();
 all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();button(host,'Close source').click();pending.resolve(read({type:'source',path:'file.js',unit:0,cursor:null}));await flush();
 assert.equal(data(host,'sourceCode').children.length,0);assert.equal(metric.textContent,'metrics retained');release();
 const delayed=Promise.withResolvers(),newHost=new Element('section');const dispose=attachUnitInspection(documentTarget,newHost,'file.js',()=>delayed.promise);const rows=data(newHost,'unitRows');dispose();delayed.resolve(read({type:'units',path:'file.js',offset:0}));await flush();assert.equal(rows.children.length,0);
});
test('unit controls and source headings use readable language-specific labels, not storage vocabulary',async()=>{
 assert.equal(unitKindLabel('file.ts','arrow'),'Arrow function');assert.equal(unitKindLabel('File.CS','arrow'),'Lambda expression');assert.equal(unitKindLabel('file.js','top-level'),'Top-level code');assert.equal(unitKindLabel('file.js','static-block'),'Static initializer');assert.equal(unitKindLabel('file.js','__proto__'),'Executable unit');
 const host=new Element('section'),source='x => x + 1',read=reader(source,[{kind:'arrow',startByte:0,endByte:source.length,complexity:1}]);
 const release=attachUnitInspection(documentTarget,host,'file.js',async query=>read(query));await flush();assert.match(data(host,'unitRows').textContent,/Arrow function/u);
 all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();await flush();assert.match(data(host,'unitDetails').textContent,/^Arrow function · Complexity 1/u);release();
});
test('coloring failure renders exact inert plain source and ownership with a local message',async()=>{
 const source='if (x) "</span><script>globalThis.executed=true</script>😀";\n',bytes=new TextEncoder().encode(source),host=new Element('section');
 const read=createFileInspection('file.js',bytes,{units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:bytes.length,complexity:2})},contributionCount:1,contributions:()=>[[0,'if',0,bytes.length-1]]},async()=>{throw Error('grammar failed');});
 const release=attachUnitInspection(documentTarget,host,'file.js',read);await flush();all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();await flush();
 const code=data(host,'sourceCode');assert.equal(all(code,node=>node.tagName==='CODE').map(node=>node.textContent).join('\n'),source);
 assert.equal(all(code,node=>Object.hasOwn(node.dataset,'syntaxColor')).length,0);assert.equal(all(code,node=>node.tagName==='MARK').length,0);assert.equal(all(code,node=>node.tagName==='SCRIPT').length,0);
 all(host,node=>Object.hasOwn(node.dataset,'contribution'))[0].click();await flush();assert.equal(all(code,node=>node.tagName==='MARK').length,1);
 assert.match(data(host,'sourceBody').textContent,/Syntax coloring unavailable\. Underlined: selected/u);assert.equal(data(host,'unitSource').open,true);release();
});
test('a source reply delayed by initialization cannot repaint a replaced file view',async()=>{
 const host=new Element('section'),read=reader('return 1;',[{kind:'top-level',startByte:0,endByte:9,complexity:1}]),pending=Promise.withResolvers();
 const release=attachUnitInspection(documentTarget,host,'file.js',query=>query.type==='source'?pending.promise:read(query));await flush();all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();const oldCode=data(host,'sourceCode');release();
 const replacement=attachUnitInspection(documentTarget,host,'other.js',async()=>({type:'units',path:'other.js',offset:0,total:0,rows:[]}));
 pending.resolve(await read({type:'source',path:'file.js',unit:0,cursor:null}));await flush();assert.equal(oldCode.children.length,0);assert.equal(data(host,'unitSource').open,false);replacement();
});
test('a long unit defaults to shown-source contributions and whole-unit entries jump back into matching code',async()=>{
 const lines=Array(1371).fill('');lines[659]='function long(x) {';for(let i=0;i<27;i++)lines[974+i*14]=' if(x) x--;';lines[1370]='}';const source=lines.join('\n'),bytes=new TextEncoder().encode(source),records=[];let from=0;
 for(let i=0;i<27;i++){const start=source.indexOf('if(x)',from);records.push([0,'if',start,start+10]);from=start+1;}
 const read=makeInspection('file.js',bytes,{units:{length:1,at:()=>({kind:'function',startByte:659,endByte:bytes.length,complexity:28})},contributionCount:records.length,contributions:()=>records},async()=>()=>[]);
 const host=new Element('section'),calls=[];let waiting;
 const release=attachUnitInspection(documentTarget,host,'file.js',async query=>{calls.push(query);const result=await read(query);if(query.type==='contributions')waiting?.resolve(result);return result;});await flush();
 const action=async callback=>{waiting=Promise.withResolvers();callback();const result=await waiting.promise;await flush();return result;};
 await action(()=>all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click());
 assert.equal(data(host,'contributionRows').children.length,0);assert.match(data(host,'contributionStatus').textContent,/0 of 27/u);assert.match(data(host,'sourceRange').textContent,/Shown source: 660:1/u);assert.match(data(host,'unitDetails').textContent,/Complexity 28 \(whole unit\).*660:1–1371:2/u);
 const scope=data(host,'contributionScope');await action(()=>{scope.value='unit';scope.dispatchEvent(new Event('change'));});
 assert.equal(data(host,'contributionRows').children.length,27);const target=all(host,node=>Object.hasOwn(node.dataset,'contribution'))[0];assert.match(target.textContent,/975:2/u);
 data(host,'unitSource').scrollTop=500;
 await action(()=>target.click());assert.equal(data(host,'unitSource').scrollTop,0);assert.equal(scope.value,'shown');assert.equal(data(host,'sourceCode').children[0].children[0].textContent,'975');assert.match(data(host,'sourceRange').textContent,/Shown source: 975:2/u);assert.ok(data(host,'contributionRows').children.length>0&&data(host,'contributionRows').children.length<27);
 const before=calls.length;target.click();await flush();assert.equal(calls.length,before,'detached whole-unit row must not issue a stale jump');
 await action(()=>button(host,'Previous source').click());assert.match(data(host,'sourceRange').textContent,/Shown source: 660:1/u);assert.equal(data(host,'contributionRows').children.length,0);release();
});
test('late contribution replies cannot populate a different source page',async()=>{
 const lines=Array(200).fill('x;');lines[0]='if(x) x;';lines[99]='if(y) y;';const source=lines.join('\n'),bytes=new TextEncoder().encode(source),second=source.indexOf('if(y)'),old=Promise.withResolvers(),ready=Promise.withResolvers();
 const read=makeInspection('file.js',bytes,{units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:bytes.length,complexity:3})},contributionCount:2,contributions:()=>[[0,'if',0,8],[0,'if',second,second+8]]},async()=>()=>[]);
 const host=new Element('section'),release=attachUnitInspection(documentTarget,host,'file.js',async query=>{if(query.type==='contributions'&&query.cursor===0)return old.promise;const result=await read(query);if(query.type==='contributions')ready.resolve();return result;});await flush();all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();await flush();
 assert.equal(data(host,'contributionRows').children.length,0);button(host,'Next source').click();await ready.promise;await flush();assert.match(data(host,'sourceRange').textContent,/Shown source: 81:1/u);assert.match(data(host,'contributionRows').textContent,/100:1/u);
 old.resolve(await read({type:'contributions',path:'file.js',unit:0,offset:0,cursor:0}));await flush();assert.match(data(host,'contributionRows').textContent,/100:1/u);assert.doesNotMatch(data(host,'contributionRows').textContent,/if · 1:1/u);release();
});
test('only the selected overlapping contribution is marked using scalar columns; same-start replacement needs no source read',async()=>{
 const source='\t😀a&&b&&c;\nif(x) y;\n'+'x;\n'.repeat(100),bytes=new TextEncoder().encode(source),byte=index=>new TextEncoder().encode(source.slice(0,index)).length,branch=source.indexOf('if('),host=new Element('section'),calls=[];
 const read=makeInspection('file.js',bytes,{units:{length:2,at:id=>({kind:id?'function':'top-level',startByte:id?byte(branch):0,endByte:id?byte(branch+8):bytes.length,complexity:id?1:4})},contributionCount:3,contributions:()=>[[0,'logical-and',byte(1),byte(10)],[0,'logical-and',byte(1),byte(7)],[0,'if',byte(branch),byte(branch+8)]]},async()=>()=>[]);
 const release=attachUnitInspection(documentTarget,host,'file.js',async query=>{calls.push(query);return read(query);});await flush();all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();await flush();
 const marks=()=>all(data(host,'sourceCode'),node=>node.tagName==='MARK').map(node=>node.textContent).join('\n'),entry=id=>all(host,node=>node.dataset.contribution===String(id))[0];
 assert.equal(marks(),'');entry(0).click();await flush();assert.equal(marks(),'😀a&&b&&c');assert.equal(entry(0).attributes['aria-current'],'true');
 const sourceReads=calls.filter(query=>query.type==='source').length;entry(1).click();await flush();assert.equal(marks(),'😀a&&b');assert.equal(calls.filter(query=>query.type==='source').length,sourceReads);assert.equal(entry(0).attributes['aria-current'],'false');assert.equal(entry(1).attributes['aria-current'],'true');assert.equal(entry(2).attributes['aria-current'],'false');assert.match(data(host,'sourceBody').textContent,/selected logical-and · 1:2–1:7/u);
 button(host,'Next source').click();await flush();assert.equal(marks(),'');assert.equal(all(host,node=>node.attributes['aria-current']==='true').length,0);
 button(host,'Previous source').click();await flush();assert.equal(marks(),'');button(host,'Close source').click();all(host,node=>node.dataset.unit==='1')[0].click();await flush();assert.equal(marks(),'');release();
});
test('selected spans clip to a scalar-aligned bounded source window, not the union of overlapping owners',async()=>{
 const source='😀'.repeat(3000)+';',bytes=new TextEncoder().encode(source),host=new Element('section');
 const read=makeInspection('file.js',bytes,{units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:bytes.length,complexity:3})},contributionCount:2,contributions:()=>[[0,'logical-and',0,bytes.length],[0,'logical-and',0,4]]},async()=>()=>[]);
 const release=attachUnitInspection(documentTarget,host,'file.js',read);await flush();all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();await flush();const mark=()=>all(data(host,'sourceCode'),node=>node.tagName==='MARK').map(node=>node.textContent).join('');
 assert.equal(mark(),'');all(host,node=>node.dataset.contribution==='0')[0].click();await flush();assert.equal(mark(),'😀'.repeat(2048));
 all(host,node=>node.dataset.contribution==='1')[0].click();await flush();assert.equal(mark(),'😀');button(host,'Next source').click();await flush();assert.equal(mark(),'');release();
});
test('a late selected-contribution source reply cannot restore a highlight after the dialog reopens',async()=>{
 const source='a&&b;\nc&&d;',bytes=new TextEncoder().encode(source),host=new Element('section'),pending=Promise.withResolvers();
 const read=makeInspection('file.js',bytes,{units:{length:1,at:()=>({kind:'top-level',startByte:0,endByte:bytes.length,complexity:3})},contributionCount:2,contributions:()=>[[0,'logical-and',0,4],[0,'logical-and',6,10]]},async()=>()=>[]);
 const release=attachUnitInspection(documentTarget,host,'file.js',query=>query.type==='source'&&query.cursor===6?pending.promise:read(query));await flush();all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();await flush();all(host,node=>node.dataset.contribution==='1')[0].click();
 button(host,'Close source').click();all(host,node=>Object.hasOwn(node.dataset,'unit'))[0].click();await flush();pending.resolve(await read({type:'source',path:'file.js',unit:0,cursor:6}));await flush();
 assert.equal(all(data(host,'sourceCode'),node=>node.tagName==='MARK').length,0);assert.equal(all(host,node=>node.attributes['aria-current']==='true').length,0);assert.match(data(host,'sourceRange').textContent,/Shown source: 1:1/u);release();
});
