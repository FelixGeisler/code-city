import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const {
  MAX_ADMITTED_MODULES,
  MAX_NORMALIZED_MODULE_BYTES,
  MAX_NORMALIZED_TOTAL_BYTES,
  createSourceAdmissionSession,
  prepareSourceInventory,
} = await import("../src/domain/source-admission.ts");

const SHA = "a".repeat(40);
const regular = (path, changes = {}) => ({ path, mode: "100644", type: "blob", sha: SHA, ...changes });

function failure(entries) {
  const result = prepareSourceInventory(entries);
  assert.equal(result.kind, "failure");
  return result;
}

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

test("kind table admits only regular blobs and handles boundary descendants before contradictions", () => {
  for (const mode of ["100644", "100755"]) {
    assert.equal(prepareSourceInventory([regular("a.ts", { mode })]).kind, "candidates");
  }
  assert.deepEqual(failure([{ path: "a.ts", mode: "040000", type: "tree" }]), {
    kind: "failure", category: "No supported modules", code: "ADM-07",
  });
  assert.deepEqual(failure([{ path: "a.ts", mode: "120000", type: "blob" }]), {
    kind: "failure", category: "No supported modules", code: "ADM-07",
  });
  assert.deepEqual(failure([{ path: "a.ts", mode: "160000", type: "commit" }]), {
    kind: "failure", category: "No supported modules", code: "ADM-06",
  });

  for (const entry of [
    { path: "a.ts", mode: "040000", type: "blob" },
    { path: "a.ts", mode: "100644", type: "tree" },
    { path: "a.ts", mode: "120000", type: "tree" },
    { path: "a.ts", mode: "160000", type: "blob" },
    { path: "a.ts", mode: "999999", type: "blob" },
  ]) {
    assert.equal(failure([entry]).code, "M1-ADM-3");
  }

  for (const boundary of [
    { path: "boundary", mode: "120000", type: "blob" },
    { path: "boundary", mode: "160000", type: "commit" },
  ]) {
    const result = prepareSourceInventory([
      { path: "container", mode: "040000", type: "tree" },
      boundary,
      { path: "boundary/a.ts", mode: "nonsense", type: "nonsense", sha: { hostile: true }, size: Number.MAX_VALUE },
      regular("ok.ts"),
    ]);
    assert.equal(result.kind, "candidates");
    assert.deepEqual(result.candidates.map((candidate) => candidate.canonicalPath), ["ok.ts"]);
  }

  for (const entries of [
    [regular("a"), regular("a/b.ts")],
    [regular("a"), { path: "a/b", mode: "120000", type: "blob" }],
  ]) {
    assert.equal(failure(entries).code, "M1-ADM-3");
    assert.equal(failure([...entries].reverse()).code, "M1-ADM-3");
  }
});

test("all eight final-segment suffixes are ASCII-case-insensitive, vendor paths are ordinary, and order is unsigned UTF-8", () => {
  const paths = [
    "z.JS", "vendor/a.JsX", "x.MJS", "x.CjS", "x.TS", "x.tSx", "x.MtS", "x.cTS",
    "unsupported.ts.txt", "directory.js/file.txt", "\u00e9.ts", "z/child.ts",
  ];
  const result = prepareSourceInventory(paths.map((path) => regular(path)));
  assert.equal(result.kind, "candidates");
  assert.deepEqual(result.candidates.map((candidate) => candidate.canonicalPath), [
    "vendor/a.JsX", "x.CjS", "x.MJS", "x.MtS", "x.TS", "x.cTS", "x.tSx", "z.JS", "z/child.ts", "\u00e9.ts",
  ]);
});

test("ADM-06 and ADM-07 are mutually exclusive across mixed skipped inventories", () => {
  const unsupported = regular("README.md");
  const submodule = { path: "vendor.ts", mode: "160000", type: "commit" };
  const submoduleChild = { path: "vendor.ts/a.ts", mode: "unknown", type: "unknown" };
  const link = { path: "link.ts", mode: "120000", type: "blob" };
  const linkChild = { path: "link.ts/a.ts", mode: "unknown", type: "unknown" };
  const unsupportedLink = { path: "link", mode: "120000", type: "blob" };
  const unsupportedLinkChild = { path: "link/a.ts", mode: "unknown", type: "unknown" };
  const directory = { path: "types.ts", mode: "040000", type: "tree" };

  for (const entries of [[], [unsupported], [submodule], [submodule, submoduleChild], [unsupportedLink, unsupportedLinkChild]]) {
    assert.equal(failure(entries).code, "ADM-06");
  }
  for (const entries of [[directory], [link], [directory, submodule], [link, submodule, submoduleChild], [link, linkChild]]) {
    assert.equal(failure(entries).code, "ADM-07");
  }
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
    { canonicalPath: "a.ts", normalizedSource: "\uFEFFa\nb\nc\n" },
    { canonicalPath: "b.ts", normalizedSource: "" },
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

test("aggregate normalized maximum is inclusive at 40 MiB and rejects the next byte with bounded shared text", () => {
  assert.equal(MAX_NORMALIZED_TOTAL_BYTES, 40 * 1_048_576);
  const sharedTwoMiB = "a".repeat(MAX_NORMALIZED_MODULE_BYTES);
  const exact = createSourceAdmissionSession();
  for (let index = 0; index < 20; index += 1) {
    assert.equal(exact.add({ canonicalPath: `${index}.ts`, rawPath: `${index}.ts`, expectedBlobId: SHA }, sharedTwoMiB), undefined);
  }
  assert.equal(exact.complete().length, 20);
  assert.deepEqual(exact.add({ canonicalPath: "over.ts", rawPath: "over.ts", expectedBlobId: SHA }, "a"), {
    kind: "failure", category: "Repository exceeds Code City limits",
  });
});

test("module count maximum is inclusive and the valid 4,001st admission establishes the breach", () => {
  assert.equal(MAX_ADMITTED_MODULES, 4_000);
  const session = createSourceAdmissionSession();
  for (let index = 0; index < MAX_ADMITTED_MODULES; index += 1) {
    assert.equal(session.add({ canonicalPath: `${index}.ts`, rawPath: `${index}.ts`, expectedBlobId: SHA }, ""), undefined);
  }
  assert.equal(session.complete().length, 4_000);
  assert.deepEqual(session.add({ canonicalPath: "4000.ts", rawPath: "4000.ts", expectedBlobId: SHA }, ""), {
    kind: "failure", category: "Repository exceeds Code City limits",
  });
});
