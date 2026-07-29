import { describe, expect, it } from "vitest";

import { analyzeRepositorySnapshotFacts } from "../packages/analyzer/src/discovery.js";
import type { RepositorySnapshot } from "../packages/analyzer/src/snapshot.js";

function repositorySnapshot(
  files: Readonly<Record<string, string>>,
): RepositorySnapshot {
  return {
    name: "Mixed",
    files: Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, text]) => ({
        path,
        text,
        byteLength: new TextEncoder().encode(text).byteLength,
      })),
    diagnostics: [],
  };
}

describe("static .slnx discovery", () => {
  it("discovers nested projects, collapses duplicates, and coexists with .sln", async () => {
    const facts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot({
        "Legacy.sln": `
Project("{FAKE}") = "App", "src/App/App.csproj", "{APP}"
`,
        "Modern.slnx": `<?xml version="1.0" encoding="utf-8"?>
<Solution>
  <Project Path="src/App/App.csproj" />
  <Folder Name="/src/">
    <Project Path="src/Shared/Shared.csproj" />
    <Project Path="src\\App\\App.csproj" />
  </Folder>
  <Project Path="C:\\private\\Secret.csproj" />
</Solution>`,
        "Broken.slnx": "<Solution><Project Path=\"private/Secret.csproj\" />",
        "src/App/App.csproj": `<Project>
  <ItemGroup>
    <ProjectReference Include="../Shared/Shared.csproj" />
    <ProjectReference Include="..\\Shared\\Shared.csproj" />
  </ItemGroup>
</Project>`,
        "src/Shared/Shared.csproj": "<Project />",
      }),
    ]);

    expect(facts.solutions.map(({ path }) => path).sort()).toEqual([
      "Legacy.sln",
      "Modern.slnx",
    ]);
    const app = facts.modules.find(({ name }) => name === "App");
    const shared = facts.modules.find(({ name }) => name === "Shared");
    expect(app?.solutionIds).toHaveLength(2);
    expect(shared?.solutionIds).toHaveLength(1);
    expect(
      facts.solutions.find(({ path }) => path === "Modern.slnx")?.moduleIds,
    ).toHaveLength(2);
    expect(
      facts.dependencies.filter(
        ({ kind, sourceId, targetId }) =>
          kind === "project-reference" &&
          sourceId === app?.id &&
          targetId === shared?.id,
      ),
    ).toEqual([
      expect.objectContaining({
        resolution: "internal",
        weight: 2,
      }),
    ]);
    expect(facts.warnings).toEqual([
      expect.stringMatching(/^broken\.slnx: malformed \.slnx file skipped$/u),
    ]);
    expect(JSON.stringify(facts)).not.toContain("C:\\private");
  });

  it("treats tag-shaped CDATA as text in csproj and slnx files", async () => {
    const facts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot({
        "CDATA.slnx": `<Solution>
  <![CDATA[
    <Project Path="Hidden/Hidden.csproj" />
  ]]>
</Solution>`,
        "App/App.csproj": `<Project>
  <![CDATA[
    <AssemblyName>Hidden.Module</AssemblyName>
    <PackageId>Hidden.Package</PackageId>
    <ProjectReference Include="../Hidden/Hidden.csproj" />
    <PackageReference Include="Hidden.Dependency" Version="9.9.9" />
  ]]>
</Project>`,
        "App/App.cs": "public sealed class App {}",
      }),
    ]);

    expect(
      facts.modules.filter(({ kind }) => kind === "dotnet-project"),
    ).toEqual([
      expect.objectContaining({
        name: "App",
        packageId: "App",
        path: "App/App.csproj",
      }),
    ]);
    expect(
      facts.solutions.find(({ path }) => path === "CDATA.slnx")?.moduleIds,
    ).toEqual([]);
    expect(facts.dependencies).toEqual([]);
    expect(JSON.stringify(facts)).not.toContain("Hidden.Module");
    expect(JSON.stringify(facts)).not.toContain("Hidden.Package");
    expect(JSON.stringify(facts)).not.toContain("Hidden.Dependency");
  });
});
