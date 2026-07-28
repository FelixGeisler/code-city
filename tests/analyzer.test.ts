import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeCSharpLexically,
  analyzeLocalFacts,
  analyzeLocalRepositories,
  analyzeTypeScriptSource,
} from "../packages/analyzer/src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-analyzer-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function fixtureFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("language metric front ends", () => {
  it("measures TypeScript executable units independently", () => {
    const result = analyzeTypeScriptSource(
      "example.ts",
      `const initial = input ?? 0;
function choose(a: boolean, b: boolean) {
  if (a && b) return a ? 1 : 2;
  const nested = () => a || b;
  return nested();
}
`,
    );

    expect(result.executableUnitCount).toBe(3);
    expect(result.decisionLoad).toBe(5);
    expect(result.maximumComplexity).toBe(4);
    expect(result.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "<top-level>", complexity: 2 }),
        expect.objectContaining({ name: "choose", complexity: 4 }),
        expect.objectContaining({ name: "nested", complexity: 2 }),
      ]),
    );
  });

  it("labels the safe C# scanner as lexical and ignores comments and strings", () => {
    const result = analyzeCSharpLexically(`
// if (notCode) {}
class Sample {
  string Text = "while (alsoNotCode)";
  int Choose(bool value) {
    if (value && Other()) return 1;
    return 0;
  }
}`);

    expect(result.decisionLoad).toBe(2);
    expect(result.maximumComplexity).toBe(3);
    expect(result.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Choose", complexity: 3 }),
      ]),
    );
  });

  it("counts logical assignments as decisions in both front ends", () => {
    const typeScript = analyzeTypeScriptSource(
      "logical.ts",
      "function assign() { left &&= right; fallback ??= right; }\n",
    );
    const csharp = analyzeCSharpLexically(
      "void Assign() { fallback ??= right; }\n",
    );

    expect(typeScript.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "assign", complexity: 3 }),
      ]),
    );
    expect(csharp.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Assign", complexity: 2 }),
      ]),
    );
  });

  it("captures literal dynamic imports", () => {
    const result = analyzeTypeScriptSource(
      "dynamic.ts",
      `const module = import("./feature"); import(variable);`,
    );

    expect(result.imports).toEqual([{ specifier: "./feature", count: 1 }]);
  });

  it("separates nullable annotations from ternaries and measures modern callables", () => {
    const result = analyzeCSharpLexically(`
class Sample {
  string? Choose<T>(bool condition, string? fallback) =>
    condition ? fallback : "none";

  int Map(int value) => value switch {
    0 => 1,
    1 when Enabled => 2,
    _ => 3
  };
}`);

    expect(result.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Choose", complexity: 2 }),
        expect.objectContaining({ name: "Map", complexity: 4 }),
      ]),
    );
  });
});

describe("offline repository discovery", () => {
  async function createFixture(): Promise<{
    readonly hub: string;
    readonly client: string;
  }> {
    const parent = await temporaryDirectory();
    const hub = path.join(parent, "FLOW.Hub");
    const client = path.join(parent, "FLOW.Client");

    await fixtureFile(
      hub,
      "Hub.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAKE}") = "App", "App/App.csproj", "{APP}"
EndProject
Project("{FAKE}") = "Shared", "Shared/Shared.csproj", "{SHARED}"
EndProject
`,
    );
    await fixtureFile(
      hub,
      "Secondary.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAKE}") = "App", "App/App.csproj", "{APP}"
EndProject
`,
    );
    await fixtureFile(
      hub,
      "App/App.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Shared/Shared.csproj" />
    <PackageReference Include="FLOW.Client" Version="2.4.0" />
  </ItemGroup>
</Project>`,
    );
    await fixtureFile(
      hub,
      "Shared/Shared.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net10.0;net9.0</TargetFrameworks>
    <PackageId>FLOW.Shared</PackageId>
  </PropertyGroup>
</Project>`,
    );
    await fixtureFile(
      hub,
      "App/Program.cs",
      `class Program { int Pick(bool value) { if (value) return 1; return 0; } }`,
    );
    await fixtureFile(
      hub,
      "App/Ignored.g.cs",
      `class Generated { void Bad() { if (true) {} } }`,
    );
    await fixtureFile(
      hub,
      "App/Ignored.g.i.cs",
      `class GeneratedIntermediate { void Bad() { if (true) {} } }`,
    );
    await fixtureFile(
      hub,
      "angular.json",
      JSON.stringify({
        version: 1,
        projects: {
          web: { projectType: "application", root: "ClientApp" },
        },
      }),
    );
    await fixtureFile(
      hub,
      "ClientApp/main.ts",
      `import { helper } from "./helper"; import { map } from "rxjs"; helper();`,
    );
    await fixtureFile(
      hub,
      "ClientApp/helper.ts",
      `export function helper() { return true; }`,
    );
    await fixtureFile(hub, "loose.js", `export const loose = true;`);
    await fixtureFile(hub, ".git/ignored-git.ts", `if (true) {}`);
    await fixtureFile(
      hub,
      ".angular/cache/vite/deps/chart__js.js",
      `if (true) {}`,
    );
    await fixtureFile(
      hub,
      ".AnGuLaR/cache/ignored-angular-case.ts",
      `if (true) {}`,
    );
    await fixtureFile(
      hub,
      "node_modules/ignored-node-modules.ts",
      `if (true) {}`,
    );
    await fixtureFile(hub, "bin/ignored-bin.cs", `if (true) {}`);
    await fixtureFile(hub, "obj/ignored-obj.cs", `if (true) {}`);
    await fixtureFile(hub, "dist/ignored-dist.js", `if (true) {}`);
    await fixtureFile(hub, "build/ignored-build.ts", `if (true) {}`);
    await fixtureFile(
      hub,
      "coverage/ignored-coverage.js",
      `if (true) {}`,
    );
    await fixtureFile(
      hub,
      "src/building/LegitimateBuilding.ts",
      `export const building = true;`,
    );
    await fixtureFile(
      hub,
      "DTO/TestResults/LegitimateResult.cs",
      `public sealed class LegitimateResult {}`,
    );

    await fixtureFile(
      client,
      "FLOW.Client.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PackageId>FLOW.Client</PackageId>
  </PropertyGroup>
</Project>`,
    );
    await fixtureFile(client, "Client.cs", `public sealed class Client {}`);
    return { hub, client };
  }

  it("discovers multiple roots deterministically without duplicate projects", async () => {
    const { hub, client } = await createFixture();
    const first = await analyzeLocalRepositories([hub, client], {
      title: "FLOW",
      version: "test",
      logo: "assets/flow.svg",
    });
    const second = await analyzeLocalRepositories([client, hub], {
      title: "FLOW",
      version: "test",
      logo: "assets/flow.svg",
    });

    expect(second).toEqual(first);
    expect(first.repositories).toHaveLength(2);
    expect(first.solutions).toHaveLength(2);
    expect(
      first.modules.filter((module) => module.kind === "dotnet-project"),
    ).toHaveLength(3);
    expect(
      first.modules.filter((module) => module.kind === "angular-project"),
    ).toHaveLength(1);
    expect(
      first.modules.filter((module) => module.kind === "unassigned"),
    ).toHaveLength(1);
    expect(first.buildings.some(({ name }) => name === "Ignored.g.cs")).toBe(
      false,
    );
    const buildingNames = new Set(
      first.buildings.map(({ name }) => name),
    );
    for (const excludedName of [
      "Ignored.g.i.cs",
      "ignored-git.ts",
      "chart__js.js",
      "ignored-angular-case.ts",
      "ignored-node-modules.ts",
      "ignored-bin.cs",
      "ignored-obj.cs",
      "ignored-dist.js",
      "ignored-build.ts",
      "ignored-coverage.js",
    ]) {
      expect(buildingNames.has(excludedName), excludedName).toBe(false);
    }
    expect(first.buildings.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "Program.cs",
        "main.ts",
        "helper.ts",
        "loose.js",
        "LegitimateBuilding.ts",
        "LegitimateResult.cs",
      ]),
    );
    expect(first.buildings.find(({ name }) => name === "Program.cs")).toEqual(
      expect.objectContaining({
        metricMethod: "csharp-lexical-v1",
        units: expect.arrayContaining([
          expect.objectContaining({ name: "Pick", complexity: 2 }),
        ]),
      }),
    );
    expect(first.analysis).toEqual({ warnings: [] });

    const app = first.modules.find(({ name }) => name === "App");
    expect(app?.solutionIds).toHaveLength(2);
    const projectRoad = first.dependencies.find(
      ({ kind }) => kind === "project-reference",
    );
    expect(projectRoad?.targetId).toBe(
      first.modules.find(({ name }) => name === "Shared")?.id,
    );
    const packageBridge = first.dependencies.find(
      ({ kind, version }) =>
        kind === "package-reference" && version === "2.4.0",
    );
    expect(packageBridge?.targetId).toBe(
      first.modules.find(({ packageId }) => packageId === "FLOW.Client")?.id,
    );
    expect(
      first.dependencies.find(
        ({ kind, externalTarget }) =>
          kind === "typescript-import" && externalTarget === "rxjs",
      ),
    ).toBeDefined();

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(path.resolve(hub));
    expect(serialized).not.toContain(path.resolve(client));
    expect(first.identity).toMatchObject({
      title: "FLOW",
      version: "test",
      logo: { relativePath: "assets/flow.svg", format: "svg" },
    });
  });

  it("keeps detailed metric methodology in facts without leaking roots", async () => {
    const { hub } = await createFixture();
    const facts = await analyzeLocalFacts([hub]);

    expect(
      facts.sources.find(({ name }) => name === "Program.cs")?.metricMethod,
    ).toBe("csharp-lexical-v1");
    expect(
      facts.sources.find(({ name }) => name === "main.ts")?.metricMethod,
    ).toBe("typescript-compiler-api-v1");
    expect(facts.identity).toBeUndefined();
    expect(JSON.stringify(facts.sources)).not.toContain(path.resolve(hub));
  });

  it("resolves imports across authorized roots with the nearest contained tsconfig", async () => {
    const parent = await temporaryDirectory();
    const app = path.join(parent, "App");
    const shared = path.join(parent, "Shared");
    await fixtureFile(
      app,
      "tsconfig.this-root-config-name-is-intentionally-long.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@bridge": ["./missing.ts"] },
        },
      }),
    );
    await fixtureFile(
      app,
      "src/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@bridge": ["../../Shared/target.ts"] },
        },
      }),
    );
    await fixtureFile(
      app,
      "src/main.ts",
      `export const bridge = import("@bridge");`,
    );
    await fixtureFile(shared, "target.ts", "export const target = true;");

    const model = await analyzeLocalRepositories([app, shared]);
    const source = model.buildings.find(({ name }) => name === "main.ts");
    const target = model.buildings.find(({ name }) => name === "target.ts");
    expect(
      model.dependencies.find(
        ({ kind, sourceId }) =>
          kind === "typescript-import" && sourceId === source?.id,
      )?.targetId,
    ).toBe(target?.id);
  });

  it("ignores MSBuild elements hidden in XML comments", async () => {
    const root = await temporaryDirectory();
    await fixtureFile(
      root,
      "Real.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <!--
    <AssemblyName>Commented.Name</AssemblyName>
    <TargetFramework>net1.0</TargetFramework>
    <ProjectReference Include="../Outside/Outside.csproj" />
    <PackageReference Include="Commented.Package" Version="9.9.9" />
  -->
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>`,
    );
    await fixtureFile(root, "Real.cs", "public sealed class Real {}");

    const facts = await analyzeLocalFacts([root]);
    expect(facts.modules[0]).toMatchObject({
      name: "Real",
      targetFrameworks: ["net10.0"],
    });
    expect(facts.dependencies).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "keeps differently cased roots distinct on case-sensitive hosts",
    async () => {
      const parent = await temporaryDirectory();
      const upper = path.join(parent, "Repo");
      const lower = path.join(parent, "repo");
      await fixtureFile(upper, "upper.ts", "export const upper = true;");
      await fixtureFile(lower, "lower.ts", "export const lower = true;");

      const facts = await analyzeLocalFacts([upper, lower]);
      expect(facts.repositories).toHaveLength(2);
      expect(facts.repositories.map(({ name }) => name)).toEqual([
        "Repo",
        "repo",
      ]);
    },
  );
});
