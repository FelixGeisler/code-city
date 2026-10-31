import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(/^\.\.?\//u.test(specifier)&&!/\.[a-z]+$/iu.test(specifier)?specifier+'.ts':specifier,context);}});
const { createSourceColoring, SYNTAX_PALETTE } = await import('../src/edge/shiki-source-highlighting.ts');
async function spans(path, text) {
  const rows = (await createSourceColoring(path, text))(0, text.length);
  let end = 0;
  for (const row of rows) {
    assert.ok(Number.isInteger(row.color) && row.color >= 0 && row.color < SYNTAX_PALETTE.length);
    assert.ok(row.start >= end && row.end > row.start && row.end <= text.length);
    assert.ok(text.slice(row.start, row.end).isWellFormed());
    end = row.end;
  }
  return rows;
}
const colorAt = (rows, offset) => SYNTAX_PALETTE[rows.find(row => row.start <= offset && row.end > offset)?.color];

test('all admitted suffixes use real grammar coloring with a fixed dark palette', async () => {
  for (const suffix of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'CS']) {
    const text = '// return "not code"\nreturn 0xff + "if <img src=x>"; /* if */';
    const rows = await spans('file.' + suffix, text);
    assert.equal(colorAt(rows, 3), '#6A737D');
    assert.equal(colorAt(rows, text.indexOf('return 0x')), '#F97583');
    assert.equal(colorAt(rows, text.indexOf('0xff')), '#79B8FF');
    assert.equal(colorAt(rows, text.indexOf('if <img')), '#9ECBFF');
    assert.equal(colorAt(rows, text.lastIndexOf('if')), '#6A737D');
  }
});
test('JS regex, division and nested template expressions are grammar-backed', async () => {
  const text = 'const ratio = a / b; const re = /[\\/]if+/gu; const s = `literal ${(() => { return `nested ${value ?? 2}`; })()} tail`;';
  const rows = await spans('f.ts', text);
  assert.notEqual(colorAt(rows, text.indexOf('if+')), colorAt(rows, text.indexOf(' / ') + 1));
  assert.equal(colorAt(rows, text.indexOf('literal')), '#9ECBFF');
  assert.equal(colorAt(rows, text.indexOf('return')), '#F97583');
  assert.equal(colorAt(rows, text.indexOf('nested')), '#9ECBFF');
  assert.equal(colorAt(rows, text.indexOf('2}')), '#79B8FF');
});
test('C# verbatim, interpolated and raw strings preserve embedded expressions', async () => {
  const text = 'var @class = 2; var a = @"if ""return"""; var b = $"hello {flag ? 1 : 0}"; var c = $$"""raw {{flag ? 3 : 4}} tail""";';
  const rows = await spans('f.cs', text);
  for (const value of ['if ', 'hello', 'raw ', 'tail']) assert.equal(colorAt(rows, text.indexOf(value)), '#9ECBFF');
  for (const value of ['1 :', '3 :']) assert.equal(colorAt(rows, text.indexOf(value)), '#79B8FF');
  assert.notEqual(colorAt(rows, text.indexOf('@class')), '#F97583');
});
test('JSX/TSX tags and attributes differ from literal text and embedded expressions', async () => {
  for (const path of ['view.jsx', 'view.tsx']) {
    const text = 'const node = <Widget value={flag ? 1 : 2}><span title="if > x">return {text}</span></Widget>;';
    const rows = await spans(path, text);
    assert.equal(colorAt(rows, text.indexOf('Widget')), '#79B8FF');
    assert.equal(colorAt(rows, text.indexOf('span')), '#85E89D');
    assert.equal(colorAt(rows, text.indexOf('title')), '#B392F0');
    assert.equal(colorAt(rows, text.indexOf('if >')), '#9ECBFF');
    assert.equal(colorAt(rows, text.indexOf('1 :')), '#79B8FF');
    assert.notEqual(colorAt(rows, text.indexOf('return')), '#F97583');
  }
});
test('windows clip complete-file context, are scalar aligned, and never invent empty tokens', async () => {
  const text = '/* ' + '😀 x '.repeat(2000) + ' if */\nreturn "yes";';
  const read = await createSourceColoring('f.js', text), start = text.indexOf(' if */');
  assert.deepEqual(read(start, start + 3), [{ color: 1, start: 0, end: 3 }]);
  const yes = text.indexOf('yes');
  assert.deepEqual(read(yes, yes + 3), [{ color: 6, start: 0, end: 3 }]);
  assert.deepEqual(read(yes, yes), []);
  assert.throws(() => read(4, 5)); // interior of the first supplementary scalar
  assert.throws(() => read(-1, 2));
  assert.throws(() => read(0, text.length + 1));
});
test('incomplete, hostile, long and randomized source yields bounded inert scalar tokens', async () => {
  for (const [path, text] of [
    ['f.js', '`hello ${ "unterminated'], ['f.cs', '$"hello {flag ? "x"'],
    ['f.js', '"'.repeat(40000)], ['f.js', '/' + '\\/'.repeat(12000)],
    ['f.cs', '"'.repeat(20000) + 'x' + '"'.repeat(19999)],
    ['f.js', '"</span><script>alert(1)</script>"; // <img onerror=1>'],
    ['f.tsx', '/* ' + '😀'.repeat(20000) + ' */\nconst n = 42;'],
  ]) await spans(path, text);
  let seed = 17; const alphabet = Array.from(' abcdef0123/\\*{}[]()<>`\'"$@;?:😀');
  for (let sample = 0; sample < 40; sample++) {
    let text = '';
    for (let n = 0; n < 300; n++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += alphabet[seed % alphabet.length]; }
    await spans(sample % 2 ? 'f.tsx' : 'f.cs', text);
  }
});
test('unsupported languages reject explicitly; palette CSS matches every vetted foreground', async () => {
  await assert.rejects(createSourceColoring('f.html', '<script/>'), /Unsupported/);
  const css = await readFile(new URL('../src/edge/source-theme.css', import.meta.url), 'utf8');
  for (const [index, color] of SYNTAX_PALETTE.entries()) assert.ok(css.includes(`[data-syntax-color="${index}"] { color: ${color.toLowerCase()}; }`));
  assert.ok(!css.includes('text-decoration:'));
});
