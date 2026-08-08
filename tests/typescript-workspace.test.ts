import { describe, expect, it } from "vitest";

import { TypeScriptWorkspace } from "../packages/analyzer/src/typescript-workspace.js";

const root = "/code-city/example";

describe("TypeScript 7 native workspace", () => {
  it("uses admitted config aliases without exposing unadmitted files", () => {
    using workspace = new TypeScriptWorkspace([
      {
        path: `${root}/tsconfig.json`,
        text: JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@target": ["target.ts"] },
          },
        }),
      },
      {
        path: `${root}/main.ts`,
        text: 'import { target } from "@target";',
      },
      {
        path: `${root}/target.ts`,
        text: "export const target = true;",
      },
    ]);

    expect(workspace.sourceFile(`${root}/main.ts`)?.text).toContain(
      'from "@target"',
    );
    expect(workspace.resolveImport(`${root}/main.ts`, "@target")).toBe(
      `${root}/target.ts`,
    );
    expect(workspace.sourceFile(`${root}/not-admitted.ts`)).toBeUndefined();
  });

  it("reports syntax failures and closes its native session deterministically", () => {
    const workspace = new TypeScriptWorkspace([
      { path: `${root}/broken.ts`, text: "export const = ;" },
    ]);

    expect(workspace.hasSyntacticErrors(`${root}/broken.ts`)).toBe(true);
    workspace.dispose();
    workspace.dispose();
    expect(() => workspace.sourceFile(`${root}/broken.ts`)).toThrow(
      "TypeScript workspace has been disposed.",
    );
  });
});
