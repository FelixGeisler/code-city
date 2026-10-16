import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const {
  FIXED_EXCLUDED_SEGMENTS,
  MAX_ADMITTED_MODULES,
  MAX_NORMALIZED_MODULE_BYTES,
  MAX_NORMALIZED_TOTAL_BYTES,
  createSourceAdmissionSession,
  parseAdditionalExclusions,
  prepareSourceInventory,
} = await import("../src/domain/source-admission.ts");

const SHA = "a".repeat(40);
const regular = (path, changes = {}) => ({ path, mode: "100644", type: "blob", sha: SHA, ...changes });
const tree = (path) => ({ path, mode: "040000", type: "tree" });

function withParents(entries) {
  const paths = new Set(entries.map(({ path }) => path));
  const parents = new Map();
  for (const { path } of entries) {
    let separator = path.lastIndexOf("/");
    while (separator >= 0) {
      const parent = path.slice(0, separator);
      if (!paths.has(parent)) parents.set(parent, tree(parent));
      separator = path.lastIndexOf("/", separator - 1);
    }
  }
  return [...parents.values(), ...entries];
}

function failure(entries, exclusions) {
  const result = prepareSourceInventory(entries, exclusions);
  assert.equal(result.kind, "failure");
  return result;
}

test("additional exclusion parsing preserves exact text and produces strict unsigned-UTF-8 canonical order", () => {
  assert.deepEqual(parseAdditionalExclusions(""), []);
  assert.deepEqual(parseAdditionalExclusions("\r\nz\r a \na\r\né"), [" a ", "a", "z", "é"]);
  assert.deepEqual(parseAdditionalExclusions("A\na"), ["A", "a"]);
  assert.deepEqual(parseAdditionalExclusions("literal[1]\n*.ts\nquestion?"), ["*.ts", "literal[1]", "question?"]);
  for (const invalid of [
    "a\na", "/a", "a/", "a//b", "a\\b", "./a", "a/../b", "C:a", "cafe\u0301", `a${String.fromCharCode(0)}b`, String.fromCharCode(0xd800),
  ]) assert.equal(parseAdditionalExclusions(invalid), undefined, JSON.stringify(invalid));
});

test("path admission rejects every forbidden form before kind classification", () => {
  const invalid = [
    "", "/a.ts", "C:a.ts", "c:/a.ts", "a\\b.ts", "a//b.ts", "a.ts/",
    "./a.ts", "a/../b.ts", "a/./b.ts", `a/${String.fromCharCode(0)}/b.ts`,
    `a/${String.fromCharCode(0x1f)}/b.ts`, `a/${String.fromCharCode(0xd800)}.ts`,
  ];
  for (const path of invalid) {
    assert.deepEqual(failure([{ path, mode: "unknown", type: "unknown" }]), {
      kind: "failure", category: "Source admission failed", code: "M1-ADM-1",
    }, JSON.stringify(path));
  }
});

test("complete inventory rejects duplicate raw and NFC identities while preserving case", () => {
  for (const entries of [
    [regular("a.ts"), regular("a.ts")],
    [regular("caf\u00e9.ts"), regular("cafe\u0301.ts")],
  ]) {
    assert.equal(failure(entries).code, "M1-ADM-1");
    assert.equal(failure([...entries].reverse()).code, "M1-ADM-1");
  }
  const result = prepareSourceInventory([regular("A.ts"), regular("a.ts")]);
  assert.equal(result.kind, "candidates");
  assert.deepEqual(result.candidates.map((candidate) => candidate.canonicalPath), ["A.ts", "a.ts"]);
});

test("every supported kind requires complete raw tree ancestry before filtering", () => {
  for (const mode of ["100644", "100755"]) assert.equal(prepareSourceInventory([regular("a.ts", { mode })]).kind, "candidates");
  assert.equal(failure([{ path: "a.ts", mode: "040000", type: "tree" }]).code, "ADM-07");
  assert.equal(failure([{ path: "a.ts", mode: "120000", type: "blob" }]).code, "ADM-07");
  assert.equal(failure([{ path: "a.ts", mode: "160000", type: "commit" }]).code, "ADM-06");

  for (const entry of [
    { path: "a.ts", mode: "040000", type: "blob" }, { path: "a.ts", mode: "100644", type: "tree" },
    { path: "a.ts", mode: "120000", type: "tree" }, { path: "a.ts", mode: "160000", type: "blob" },
    { path: "a.ts", mode: "999999", type: "blob" },
  ]) assert.equal(failure([entry]).code, "M1-ADM-3");

  for (const malformed of [
    [regular("missing/child.ts")],
    [{ path: "parent", mode: "100644", type: "blob" }, regular("parent/child.ts")],
    [{ path: "parent", mode: "120000", type: "blob" }, regular("parent/child.ts")],
    [{ path: "parent", mode: "160000", type: "commit" }, regular("parent/child.ts")],
    [{ path: "parent", mode: "040000", type: "tree" }, regular("parent/missing/child.ts")],
  ]) assert.equal(failure(malformed).code, "M1-ADM-3");

  const valid = prepareSourceInventory(withParents([regular("deep/nested/a.ts"), regular("ok.ts")]));
  assert.equal(valid.kind, "candidates");
  assert.deepEqual(valid.candidates.map(({ canonicalPath }) => canonicalPath), ["deep/nested/a.ts", "ok.ts"]);
});

test("fixed and additional exclusions are case-sensitive exact segment or exact-descendant matches", () => {
  assert.deepEqual(FIXED_EXCLUDED_SEGMENTS, ["node_modules", "dist", "build", "bin", "obj"]);
  const entries = withParents([
    regular("node_modules/a.ts"), regular("x/dist/b.ts"), regular("Build/c.ts"), regular("packages/d.ts"),
    regular("src/e.ts"), regular("src2/f.ts"), regular("single.ts"), regular("prefix/g.ts"), regular("prefix2/h.ts"),
  ]);
  const result = prepareSourceInventory(entries, ["prefix", "single.ts", "src"]);
  assert.equal(result.kind, "candidates");
  assert.deepEqual(result.candidates.map(({ canonicalPath }) => canonicalPath), ["Build/c.ts", "packages/d.ts", "prefix2/h.ts", "src2/f.ts"]);
  assert.equal(failure(withParents([regular("dist/a.ts")])).code, "ADM-06");
  assert.equal(failure(withParents([regular("src/a.ts")]), ["src"]).code, "ADM-06");
  assert.equal(failure([{ path: "visible.ts", mode: "120000", type: "blob" }], ["other"]).code, "ADM-07");
  assert.equal(failure([{ path: "excluded.ts", mode: "120000", type: "blob" }], ["excluded.ts"]).code, "ADM-06");
});

test("all nine final-segment suffixes are ASCII-case-insensitive and order is unsigned UTF-8", () => {
  const paths = [
    "z.JS", "vendor/a.JsX", "x.MJS", "x.CjS", "x.TS", "x.tSx", "x.MtS", "x.cTS", "vendor/generated/x.Cs",
    "unsupported.ts.txt", "directory.js/file.txt", "\u00e9.ts", "z/child.ts",
  ];
  const result = prepareSourceInventory(withParents(paths.map((path) => regular(path))));
  assert.equal(result.kind, "candidates");
  assert.deepEqual(result.candidates.map((candidate) => candidate.canonicalPath), [
    "vendor/a.JsX", "vendor/generated/x.Cs", "x.CjS", "x.MJS", "x.MtS", "x.TS", "x.cTS", "x.tSx", "z.JS", "z/child.ts", "\u00e9.ts",
  ]);
});

test("more than 4,000 directory records impose no directory limit", () => {
  const entries = [regular("eligible.ts"), ...Array.from({ length: 4_001 }, (_, index) => tree(`directory-${index}`))];
  const result = prepareSourceInventory(entries);
  assert.equal(result.kind, "candidates");
  assert.deepEqual(result.candidates.map(({ canonicalPath }) => canonicalPath), ["eligible.ts"]);
});

test("C# variants retain canonical identity, ordering, and content normalization", () => {
  const entries = withParents([
    regular("z/file.cS", { mode: "100755" }), regular("A.CS"), regular("cafe\u0301.Cs"),
    { path: "boundary.cs", mode: "120000", type: "blob" }, { path: "tree.CS", mode: "040000", type: "tree" },
    { path: "submodule.cs", mode: "160000", type: "commit" },
  ]);
  const result = prepareSourceInventory(entries);
  assert.equal(result.kind, "candidates");
  assert.deepEqual(result.candidates.map(({ canonicalPath, rawPath }) => ({ canonicalPath, rawPath })), [
    { canonicalPath: "A.CS", rawPath: "A.CS" }, { canonicalPath: "caf\u00e9.Cs", rawPath: "cafe\u0301.Cs" },
    { canonicalPath: "z/file.cS", rawPath: "z/file.cS" },
  ]);
  const session = createSourceAdmissionSession();
  assert.equal(session.add(result.candidates[0], "\uFEFFclass A {}\r\n// end\r"), undefined);
  assert.deepEqual(session.complete(), [{ canonicalPath: "A.CS", normalizedSource: "class A {}\n// end\n" }]);
});

test("content admission removes one BOM, normalizes newlines, permits empty text, and rejects NUL", () => {
  const candidates = prepareSourceInventory([regular("a.ts"), regular("b.ts"), regular("c.ts")]);
  assert.equal(candidates.kind, "candidates");
  const session = createSourceAdmissionSession();
  assert.equal(session.add(candidates.candidates[0], "\uFEFF\uFEFFa\r\nb\rc\n"), undefined);
  assert.equal(session.add(candidates.candidates[1], ""), undefined);
  assert.deepEqual(session.add(candidates.candidates[2], "a\0b"), {
    kind: "failure", category: "Source admission failed", code: "M1-ADM-4",
  });
  assert.deepEqual(session.complete(), [
    { canonicalPath: "a.ts", normalizedSource: "\uFEFFa\nb\nc\n" }, { canonicalPath: "b.ts", normalizedSource: "" },
  ]);
});

test("per-module normalized maximum is inclusive at 2 MiB and rejects the next byte", () => {
  assert.equal(MAX_NORMALIZED_MODULE_BYTES, 2_097_152);
  const [candidate] = prepareSourceInventory([regular("a.ts")]).candidates;
  const exact = createSourceAdmissionSession();
  assert.equal(exact.add(candidate, "a".repeat(MAX_NORMALIZED_MODULE_BYTES)), undefined);
  const over = createSourceAdmissionSession();
  assert.deepEqual(over.add(candidate, "a".repeat(MAX_NORMALIZED_MODULE_BYTES + 1)), {
    kind: "failure", category: "Repository exceeds Code City limits",
  });
});

test("aggregate normalized maximum is inclusive at 40 MiB and rejects the next byte", () => {
  assert.equal(MAX_NORMALIZED_TOTAL_BYTES, 40 * 1_048_576);
  const sharedTwoMiB = "a".repeat(MAX_NORMALIZED_MODULE_BYTES);
  const exact = createSourceAdmissionSession();
  for (let index = 0; index < 20; index += 1) assert.equal(exact.add({ canonicalPath: `${index}.ts`, rawPath: `${index}.ts`, expectedBlobId: SHA }, sharedTwoMiB), undefined);
  assert.equal(exact.complete().length, 20);
  assert.deepEqual(exact.add({ canonicalPath: "over.ts", rawPath: "over.ts", expectedBlobId: SHA }, "a"), {
    kind: "failure", category: "Repository exceeds Code City limits",
  });
});

test("module count maximum is inclusive and the valid 4,001st admission establishes the breach", () => {
  assert.equal(MAX_ADMITTED_MODULES, 4_000);
  const session = createSourceAdmissionSession();
  for (let index = 0; index < MAX_ADMITTED_MODULES; index += 1) assert.equal(session.add({ canonicalPath: `${index}.ts`, rawPath: `${index}.ts`, expectedBlobId: SHA }, ""), undefined);
  assert.equal(session.complete().length, 4_000);
  assert.deepEqual(session.add({ canonicalPath: "4000.ts", rawPath: "4000.ts", expectedBlobId: SHA }, ""), {
    kind: "failure", category: "Repository exceeds Code City limits",
  });
});
