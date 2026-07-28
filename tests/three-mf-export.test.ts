import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";

import {
  serializeThreeMf,
} from "../packages/exporter/src/three-mf.js";
import type {
  PrintMesh,
  PrintPart,
  PrintableCity,
} from "../packages/exporter/src/geometry.js";

const decoder = new TextDecoder();

const CUBE_MESH: PrintMesh = {
  vertices: [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 1 },
    { x: 1, y: 1, z: 1 },
    { x: 0, y: 1, z: 1 },
  ],
  triangles: [
    { a: 0, b: 2, c: 1 },
    { a: 0, b: 3, c: 2 },
    { a: 4, b: 5, c: 6 },
    { a: 4, b: 6, c: 7 },
    { a: 0, b: 1, c: 5 },
    { a: 0, b: 5, c: 4 },
    { a: 1, b: 2, c: 6 },
    { a: 1, b: 6, c: 5 },
    { a: 2, b: 3, c: 7 },
    { a: 2, b: 7, c: 6 },
    { a: 3, b: 0, c: 4 },
    { a: 3, b: 4, c: 7 },
  ],
};

function boxMesh(
  minimum: { readonly x: number; readonly y: number; readonly z: number },
  maximum: { readonly x: number; readonly y: number; readonly z: number },
): PrintMesh {
  return {
    vertices: CUBE_MESH.vertices.map((vertex) => ({
      x: minimum.x + vertex.x * (maximum.x - minimum.x),
      y: minimum.y + vertex.y * (maximum.y - minimum.y),
      z: minimum.z + vertex.z * (maximum.z - minimum.z),
    })),
    triangles: CUBE_MESH.triangles,
  };
}

function part(index: number): PrintPart {
  const channelNumber = index + 1;
  return {
    id: `part:tool-${channelNumber}`,
    channelId: `tool-${channelNumber}`,
    name: `Tool ${channelNumber}`,
    displayColor: channelNumber % 2 === 0 ? "#78d6c6" : "#6b7280",
    semanticGroupIds: [`group:${channelNumber}`],
    primitives: [
      {
        id: `primitive:${channelNumber}`,
        kind: "building",
        semanticGroupId: `group:${channelNumber}`,
        channelId: `tool-${channelNumber}`,
        mesh: CUBE_MESH,
        bounds: {
          minimum: { x: 0, y: 0, z: 0 },
          maximum: { x: 1, y: 1, z: 1 },
          size: { x: 1, y: 1, z: 1 },
        },
      },
    ],
    mesh: CUBE_MESH,
  };
}

function city(parts: readonly PrintPart[] = [part(0)]): PrintableCity {
  return {
    application: {
      name: "Code City",
      version: "0.1.0-test",
    },
    profileId: "prusa-xl-5t",
    title: "Demo City",
    version: "Demo 0.1",
    unit: "millimeter",
    scale: 2,
    bounds: {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: 2, y: 2, z: 2 },
      size: { x: 2, y: 2, z: 2 },
    },
    measurements: {
      baseThickness: 1,
      wallThickness: 1,
      minimumFeatureSize: 1,
      minimumGap: null,
    },
    parts,
  };
}

function archive(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

function packageText(bytes: Uint8Array, path: string): string {
  const contents = archive(bytes)[path];
  if (contents === undefined) {
    throw new Error(`3MF archive has no '${path}' part.`);
  }
  return decoder.decode(contents);
}

function model(bytes: Uint8Array): string {
  return packageText(bytes, "3D/3dmodel.model");
}

function prusaConfig(bytes: Uint8Array): string {
  return packageText(bytes, "Metadata/Slic3r_PE_model.config");
}

describe("deterministic 3MF package serialization", () => {
  it("writes the required OPC parts and one material-indexed mesh", () => {
    const contents = archive(serializeThreeMf(city()));

    expect(Object.keys(contents).sort()).toEqual([
      "3D/3dmodel.model",
      "Metadata/Slic3r_PE_model.config",
      "[Content_Types].xml",
      "_rels/.rels",
    ]);
    const contentTypes = decoder.decode(contents["[Content_Types].xml"]);
    expect(contentTypes).toContain(
      "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
    );
    expect(contentTypes).toContain(
      'PartName="/Metadata/Slic3r_PE_model.config" ContentType="application/xml"',
    );
    expect(decoder.decode(contents["_rels/.rels"])).toContain(
      'Target="/3D/3dmodel.model"',
    );

    const xml = decoder.decode(contents["3D/3dmodel.model"]);
    expect(xml).toContain('<model unit="millimeter"');
    expect(xml).toContain('xml:lang="und"');
    expect(xml).toContain(
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"',
    );
    expect(xml).toContain(
      'xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"',
    );
    expect(xml).toContain(
      '<metadata name="slic3rpe:Version3mf">1</metadata>',
    );
    expect(xml).toContain("<basematerials");
    expect(xml.match(/<mesh>/gu)).toHaveLength(1);
    expect(xml).toContain(
      '<triangle v1="0" v2="2" v3="1" pid="1" p1="0" p2="0" p3="0"/>',
    );
    expect(xml).not.toContain("<components>");
    expect(xml.match(/<object id="/gu)).toHaveLength(1);
    expect(xml.match(/<build>/gu)).toHaveLength(1);
    expect(xml).toContain('<item objectid="2"/>');

    const config = decoder.decode(
      contents["Metadata/Slic3r_PE_model.config"],
    );
    expect(config).toContain('<object id="2" instances_count="1">');
    expect(config).toContain('<volume firstid="0" lastid="11">');
    expect(config).toContain(
      'key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"',
    );
    expect(config).not.toContain("source_file");
  });

  it("is byte-identical across calls and input part ordering", () => {
    const parts = [part(2), part(0), part(1)];
    const first = serializeThreeMf(city(parts));
    const second = serializeThreeMf(city([...parts].reverse()));

    expect([...second]).toEqual([...first]);
    expect(serializeThreeMf(city(parts))).toEqual(first);
  });

  it.each([1, 3, 7])(
    "supports %i used print channel(s) without a hardware cap",
    (channelCount) => {
      const bytes = serializeThreeMf(
        city(
          Array.from(
            { length: channelCount },
            (_, index) => part(index),
          ),
        ),
      );
      const xml = model(bytes);
      const config = prusaConfig(bytes);

      expect(xml.match(/<base name="/gu)).toHaveLength(channelCount);
      expect(xml.match(/<mesh>/gu)).toHaveLength(1);
      expect(xml.match(/<triangle /gu)).toHaveLength(channelCount * 12);
      expect(xml.match(/<object id="/gu)).toHaveLength(1);
      expect(xml.match(/<item objectid="/gu)).toHaveLength(1);
      expect(config.match(/<volume firstid="/gu)).toHaveLength(channelCount);
      expect(config).toContain(
        `<volume firstid="${(channelCount - 1) * 12}" lastid="${channelCount * 12 - 1}">`,
      );
    },
  );

  it("keeps all channel geometry in one absolute 93 × 48 × 33 mm frame", () => {
    const basePart: PrintPart = {
      ...part(0),
      mesh: boxMesh(
        { x: 0, y: 0, z: 0 },
        { x: 93, y: 48, z: 3 },
      ),
    };
    const elevatedPart: PrintPart = {
      ...part(1),
      mesh: boxMesh(
        { x: 10, y: 8, z: 3 },
        { x: 30, y: 28, z: 33 },
      ),
    };
    const printable: PrintableCity = {
      ...city([basePart, elevatedPart]),
      bounds: {
        minimum: { x: 0, y: 0, z: 0 },
        maximum: { x: 93, y: 48, z: 33 },
        size: { x: 93, y: 48, z: 33 },
      },
    };
    const bytes = serializeThreeMf(printable);
    const xml = model(bytes);
    const vertices = [...xml.matchAll(
      /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/gu,
    )].map((match) => match.slice(1).map(Number));
    const minimum = [0, 1, 2].map((axis) =>
      Math.min(...vertices.map((vertex) => vertex[axis]!)),
    );
    const maximum = [0, 1, 2].map((axis) =>
      Math.max(...vertices.map((vertex) => vertex[axis]!)),
    );

    expect(minimum).toEqual([0, 0, 0]);
    expect(maximum).toEqual([93, 48, 33]);
    expect(prusaConfig(bytes)).toContain(
      '<volume firstid="12" lastid="23">',
    );
  });

  it("writes escaped metadata, standard materials, profile, and scale", () => {
    const value: PrintableCity = {
      ...city(),
      title: 'Demo & <City> "XL"',
      version: "v1 < v2 & ready",
      profileId: "profile<&>",
      application: {
        name: "Code & City",
        version: '1.0 "test"',
      },
    };
    const bytes = serializeThreeMf(value);
    const xml = model(bytes);

    expect(xml).toContain(
      "<metadata name=\"Title\">Demo &amp; &lt;City&gt; &quot;XL&quot;</metadata>",
    );
    expect(xml).toContain(
      "<metadata name=\"Application\">Code &amp; City 1.0 &quot;test&quot;</metadata>",
    );
    expect(xml).toContain(
      '<metadata name="codecity:Version" preserve="1">v1 &lt; v2 &amp; ready</metadata>',
    );
    expect(xml).toContain(
      '<metadata name="codecity:Profile" preserve="1">profile&lt;&amp;&gt;</metadata>',
    );
    expect(xml).toContain(
      '<metadata name="codecity:Scale" preserve="1">2</metadata>',
    );
    expect(xml).toContain(
      '<base name="Tool 1" displaycolor="#6B7280"/>',
    );
    expect(prusaConfig(bytes)).toContain(
      'key="name" value="Demo &amp; &lt;City&gt; &quot;XL&quot;"',
    );
  });

  it("does not serialize primitive identities or local source paths", () => {
    const unsafePart: PrintPart = {
      ...part(0),
      id: "F:/Projects/private/part",
      semanticGroupIds: ["C:\\Users\\geisl\\private"],
      primitives: [
        {
          ...part(0).primitives[0]!,
          id: "F:/Projects/private/source.ts",
          semanticGroupId: "C:\\Users\\geisl\\private",
        },
      ],
    };
    const bytes = serializeThreeMf(city([unsafePart]));
    const serialized = `${model(bytes)}${prusaConfig(bytes)}`;

    expect(serialized).not.toContain("F:/Projects");
    expect(serialized).not.toContain("C:\\Users");
    expect(serialized).not.toContain("private");
  });

  it("canonicalizes negative zero and rejects non-finite coordinates", () => {
    const negativeZeroMesh: PrintMesh = {
      ...CUBE_MESH,
      vertices: [
        { x: -0, y: 0, z: 0 },
        ...CUBE_MESH.vertices.slice(1),
      ],
    };
    const negativeZeroPart: PrintPart = {
      ...part(0),
      mesh: negativeZeroMesh,
    };
    const xml = model(serializeThreeMf(city([negativeZeroPart])));
    expect(xml).toContain('<vertex x="0" y="0" z="0"/>');
    expect(xml).not.toMatch(/="-0"/u);

    const invalidPart: PrintPart = {
      ...part(0),
      mesh: {
        ...CUBE_MESH,
        vertices: [
          { x: Number.NaN, y: 0, z: 0 },
          ...CUBE_MESH.vertices.slice(1),
        ],
      },
    };
    expect(() => serializeThreeMf(city([invalidPart]))).toThrow(/finite/u);
  });

  it.each([
    [
      "title",
      (bad: string): PrintableCity => ({ ...city(), title: bad }),
    ],
    [
      "version",
      (bad: string): PrintableCity => ({ ...city(), version: bad }),
    ],
    [
      "application name",
      (bad: string): PrintableCity => ({
        ...city(),
        application: { ...city().application, name: bad },
      }),
    ],
    [
      "application version",
      (bad: string): PrintableCity => ({
        ...city(),
        application: { ...city().application, version: bad },
      }),
    ],
    [
      "profile",
      (bad: string): PrintableCity => ({ ...city(), profileId: bad }),
    ],
    [
      "part name",
      (bad: string): PrintableCity => ({
        ...city(),
        parts: [{ ...part(0), name: bad }],
      }),
    ],
  ])("rejects XML-forbidden characters in %s", (_label, create) => {
    expect(() => serializeThreeMf(create(`safe\u0000unsafe`))).toThrow(
      /forbidden by XML 1\.0/u,
    );
  });

  it.each(["\u0001", "\ufffe", "\uffff", "\ud800"])(
    "rejects forbidden XML code point %#",
    (character) => {
      expect(() =>
        serializeThreeMf(city([{ ...part(0), name: `Tool${character}1` }])),
      ).toThrow(/forbidden by XML 1\.0/u);
    },
  );

  it.each([
    {
      label: "too few faces",
      mesh: {
        vertices: CUBE_MESH.vertices.slice(0, 3),
        triangles: CUBE_MESH.triangles.slice(0, 3),
      },
      issue: /at least four triangles/u,
    },
    {
      label: "an open shell",
      mesh: {
        vertices: CUBE_MESH.vertices,
        triangles: CUBE_MESH.triangles.slice(0, -1),
      },
      issue: /watertight/u,
    },
    {
      label: "a zero-area face",
      mesh: {
        vertices: CUBE_MESH.vertices.map((vertex, index) =>
          index === 2 ? { x: 0.5, y: 0, z: 0 } : vertex,
        ),
        triangles: CUBE_MESH.triangles,
      },
      issue: /positive area/u,
    },
    {
      label: "an inconsistently wound face",
      mesh: {
        vertices: CUBE_MESH.vertices,
        triangles: CUBE_MESH.triangles.map((triangle, index) =>
          index === 0
            ? { a: triangle.a, b: triangle.c, c: triangle.b }
            : triangle,
        ),
      },
      issue: /consistently wound/u,
    },
    {
      label: "an inward-wound shell",
      mesh: {
        vertices: CUBE_MESH.vertices,
        triangles: CUBE_MESH.triangles.map((triangle) => ({
          a: triangle.a,
          b: triangle.c,
          c: triangle.b,
        })),
      },
      issue: /outward-wound/u,
    },
  ])("rejects $label", ({ mesh, issue }) => {
    expect(() =>
      serializeThreeMf(city([{ ...part(0), mesh }])),
    ).toThrow(issue);
  });
});
