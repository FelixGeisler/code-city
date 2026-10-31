import assert from 'node:assert/strict';import test from 'node:test';import{registerHooks}from'node:module';
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(/^\.\.?\//u.test(specifier)&&!/\.[a-z]+$/iu.test(specifier)?specifier+'.ts':specifier,context);}});
const{attachUnitInspection}=await import('../src/edge/unit-inspection-view.ts');const{createFileInspection}=await import('../src/application/unit-inspection.ts');
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
 const release=attachUnitInspection(documentTarget,host,'file.js',async query=>{calls.push(query);return read(query);});await flush();
 assert.deepEqual(calls.map(row=>row.type),['units']);assert.equal(data(host,'unitSource').open,false);
 const open=all(host,node=>Object.hasOwn(node.dataset,'unit'))[0];open.click();await flush();
 assert.equal(data(host,'unitSource').open,true);assert.ok(data(host,'sourceCode').textContent.includes('<img src=x onerror=alert(1)>'));
 assert.equal(all(host,node=>node.tagName==='IMG'||node.tagName==='SCRIPT').length,0);assert.equal(all(data(host,'sourceCode'),node=>node.tagName==='MARK').length,1);
 data(host,'unitSource').dispatchEvent(new Event('close'));assert.ok(data(host,'sourceCode').children.length>0,'a queued prior close event must not clear a reopened dialog');
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
