import assert from 'node:assert/strict';import test from 'node:test';import{registerHooks}from'node:module';
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(/^\.\.?\//u.test(specifier)&&! /\.[a-z]+$/iu.test(specifier)?specifier+'.ts':specifier,context);}});
const{createSourceColoring,SYNTAX_KINDS}=await import('../src/application/source-highlighting.ts');
function spans(path,text){const rows=createSourceColoring(path,text)(0,text.length);let end=0;for(const row of rows){assert.ok(SYNTAX_KINDS.includes(row.kind));assert.ok(row.start>=end&&row.end>row.start&&row.end<=text.length);assert.ok(text.slice(row.start,row.end).isWellFormed());end=row.end;}return rows.map(row=>({...row,text:text.slice(row.start,row.end)}));}
const has=(rows,kind,text)=>rows.some(row=>row.kind===kind&&row.text===text);

test('all supported suffixes color lexical source without confusing strings and comments with keywords',()=>{
 for(const suffix of ['js','mjs','cjs','jsx','ts','mts','cts','tsx','CS']){
  const source='// return "not code"\nconst text = "if <img src=x>"; /* if */\nreturn 0xff + 2.5e-3;',rows=spans('file.'+suffix,source);
  assert.ok(has(rows,'comment','// return "not code"'));assert.ok(has(rows,'string','"if <img src=x>"'));assert.ok(has(rows,'comment','/* if */'));
  assert.ok(has(rows,'keyword','return'));assert.ok(has(rows,'number','0xff'));assert.ok(has(rows,'number','2.5e-3'));
 }
 const types=spans('file.ts','const value: string = true;');assert.ok(has(types,'type','string'));assert.ok(has(types,'keyword','true'));
});
test('JavaScript regex literals, escaped character classes, division, and templates retain lexical context',()=>{
 const source=String.raw`const ratio = amount / divisor; const pattern = /[\/]if+/gu; if (ok) /test/.exec(text); const text = `+'`literal ${(() => { return `nested ${value ?? 2}`; })()} tail`;',rows=spans('file.ts',source);
 assert.ok(has(rows,'operator','/'));assert.ok(has(rows,'regex',String.raw`/[\/]if+/gu`));assert.ok(has(rows,'regex','/test/'));
 assert.ok(has(rows,'keyword','return'));assert.ok(has(rows,'string','`literal '));assert.ok(has(rows,'string','`nested '));assert.ok(has(rows,'number','2'));assert.ok(has(rows,'string',' tail`'));
});
test('C# escaped identifiers, verbatim, interpolated and raw strings do not hide interpolation code',()=>{
 const source=String.raw`var @class = 2; var quoted = @"if ""return"""; var value = $"hello {flag ? @"yes" : "no"}"; var raw = $$"""text {{condition ? 1 : 0}} more "quoted" """;`,rows=spans('file.cs',source);
 assert.ok(!rows.some(row=>row.kind==='keyword'&&row.text.includes('@class')));assert.ok(has(rows,'string',String.raw`@"if ""return"""`));
 assert.ok(has(spans('raw.cs','var s = """"""\nif (x) return 1;\n"""""";'), 'string', '""""""\nif (x) return 1;\n""""""'));
 assert.ok(has(rows,'string','$"hello '));assert.ok(has(rows,'string','@"yes"'));assert.ok(has(rows,'number','1'));assert.ok(has(rows,'number','0'));assert.ok(has(rows,'string',' more "quoted" """'));
});
test('JSX and TSX distinguish tags and attributes from text while highlighting embedded expressions',()=>{
 for(const path of ['view.jsx','view.tsx']){
  const source='const view = <Widget value={flag ? 1 : 2}><span title="if > x">return {text}</span></Widget>;',rows=spans(path,source);
  assert.ok(has(rows,'tag','Widget'));assert.ok(has(rows,'tag','span'));assert.ok(has(rows,'attribute','value'));assert.ok(has(rows,'attribute','title'));assert.ok(has(rows,'string','"if > x"'));assert.ok(has(rows,'number','1'));assert.ok(!has(rows,'keyword','return'));
 }
 assert.ok(!spans('view.ts','const value = first < other;').some(row=>row.kind==='tag'));
 for(const source of ['const f = <T,>(x: T) => x;', 'const f = <T extends {}>(x: T) => x;'])assert.ok(!spans('view.tsx',source).some(row=>row.kind==='tag'));
 assert.ok(has(spans('view.tsx','const node = <Äpfel größe="eins"/>;'),'tag','Äpfel'));
 assert.ok(has(spans('view.jsx',String.raw`const node = <A title="C:\" value={42}/>;`),'number','42'));
});
test('token windows clip whole-file context rather than treating a page or unit start as new code',()=>{
 const source='/* '+ '😀 x '.repeat(2000)+' if */\nreturn "yes";',read=createSourceColoring('file.js',source),start=source.indexOf(' if */');
 assert.deepEqual(read(start,start+3),[{kind:'comment',start:0,end:3}]);assert.deepEqual(read(source.indexOf('yes'),source.indexOf('yes')+3),[{kind:'string',start:0,end:3}]);
 assert.deepEqual(read(0,0),[]);
});
test('incomplete or hostile lexical input remains ordered and inert, including long delimiter and escape runs',()=>{
 for(const[path,source]of[
  ['file.js','`hello ${ "unterminated'],['file.js','`hello ${ if (x) {'],['file.cs','$"hello {flag ? "x"'],
  ['file.js','"'.repeat(40000)],['file.js','/'.concat('\\/'.repeat(12000))],
  ['file.cs','"'.repeat(20000)+'x'+'"'.repeat(19999)],
  ['file.cs','$'.repeat(12000)+'"""'+'{'.repeat(11999)+'x'],
  ['file.cs','$"'+'{{'.repeat(12000)+'"'],
  ['file.js','"</span><script>alert(1)</script>"; // <img onerror=1>'],
 ])spans(path,source);
 let seed=17;const alphabet=' abcdef0123/\\*{}[]()<>`\'"$@;?:😀';
 for(let sample=0;sample<150;sample++){let source='';for(let n=0;n<300;n++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const chars=Array.from(alphabet);source+=chars[seed%chars.length];}spans(sample%2?'f.tsx':'f.cs',source);}
});
