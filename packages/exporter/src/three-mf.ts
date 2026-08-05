import {
  strToU8,
  zipSync,
} from "fflate";

import { normalizeDisplayColor } from "../../core/src/color.js";
import {
  PRINT_FIDELITY_EPSILON,
  PRINT_FEATURE_CATEGORIES,
  type PrintFeatureCategory,
} from "../../core/src/print-layout.js";
import type {
  PrintPart,
  PrintableCity,
} from "./geometry.js";
import { validateMeshForSerialization } from "./validate.js";

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const PACKAGE_RELATIONSHIPS_PATH = "_rels/.rels";
const MODEL_PATH = "3D/3dmodel.model";
const PRUSA_MODEL_CONFIG_PATH = "Metadata/Slic3r_PE_model.config";

const CORE_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const CODE_CITY_NAMESPACE =
  "https://felixgeisler.github.io/code-city/ns/3mf/1.0";
const SLIC3R_NAMESPACE =
  "http://schemas.slic3r.org/3mf/2017/06";
const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const MODEL_RELATIONSHIP_TYPE =
  "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const MODEL_CONTENT_TYPE =
  "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
const RELATIONSHIPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.relationships+xml";
const XML_CONTENT_TYPE = "application/xml";

const BASE_MATERIAL_RESOURCE_ID = 1;
const CITY_OBJECT_RESOURCE_ID = 2;
const FIXED_ZIP_DATE = new Date(1980, 0, 1, 0, 0, 0, 0);
const CORE_INDEX_LIMIT = 0x80000000;
const FEATURE_CATEGORY_ORDER = new Map<PrintFeatureCategory, number>(
  PRINT_FEATURE_CATEGORIES.map((category, index) => [category, index]),
);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function xmlCharacterAllowed(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function xml(value: string, field: string): string {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (!xmlCharacterAllowed(codePoint)) {
      throw new TypeError(
        `${field} contains a character forbidden by XML 1.0.`,
      );
    }
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requiredText(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized === "") {
    throw new TypeError(`${field} must not be empty.`);
  }
  return normalized;
}

function canonicalNumber(value: number, field: string): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite.`);
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function positiveNumber(value: number, field: string): string {
  if (!(value > 0)) {
    throw new TypeError(`${field} must be positive.`);
  }
  return canonicalNumber(value, field);
}

function scaleFidelityMetadata(city: PrintableCity): readonly string[] {
  const fidelity = city.scaleFidelity;
  if (fidelity === undefined) return [];
  const requestedScale = positiveNumber(
    fidelity.requestedScale,
    "scaleFidelity.requestedScale",
  );
  const appliedScale = positiveNumber(
    fidelity.appliedScale,
    "scaleFidelity.appliedScale",
  );
  const minimumSafeScale = positiveNumber(
    fidelity.minimumSafeScale,
    "scaleFidelity.minimumSafeScale",
  );
  if (
    Math.abs(Number(appliedScale) - city.scale) >
      PRINT_FIDELITY_EPSILON
  ) {
    throw new RangeError(
      "scaleFidelity.appliedScale must match the printable city scale.",
    );
  }
  if (
    Number(appliedScale) >
      Number(requestedScale) + PRINT_FIDELITY_EPSILON
  ) {
    throw new RangeError(
      "scaleFidelity.appliedScale must not exceed requestedScale.",
    );
  }
  if (typeof fidelity.belowProfileScaleAcknowledged !== "boolean") {
    throw new TypeError(
      "scaleFidelity.belowProfileScaleAcknowledged must be a boolean.",
    );
  }
  if (!Array.isArray(fidelity.featureViolations)) {
    throw new TypeError("scaleFidelity.featureViolations must be an array.");
  }
  if (fidelity.featureViolations.length > FEATURE_CATEGORY_ORDER.size) {
    throw new RangeError("scaleFidelity has too many feature violations.");
  }
  let previousCategoryOrder = -1;
  const violations = fidelity.featureViolations.map((violation, index) => {
    const categoryOrder = FEATURE_CATEGORY_ORDER.get(violation.category);
    if (categoryOrder === undefined || categoryOrder <= previousCategoryOrder) {
      throw new TypeError(
        "scaleFidelity feature violations must use unique canonical category order.",
      );
    }
    previousCategoryOrder = categoryOrder;
    const resultingValue = Number(
      positiveNumber(
        violation.resultingValue,
        `scaleFidelity.featureViolations[${index}].resultingValue`,
      ),
    );
    const minimum = Number(
      positiveNumber(
        violation.minimum,
        `scaleFidelity.featureViolations[${index}].minimum`,
      ),
    );
    if (resultingValue + PRINT_FIDELITY_EPSILON >= minimum) {
      throw new RangeError(
        `scaleFidelity.featureViolations[${index}] is not below its minimum.`,
      );
    }
    return {
      category: requiredText(
        violation.category,
        `scaleFidelity.featureViolations[${index}].category`,
      ),
      resultingValue,
      minimum,
    };
  });
  const belowSafe =
    Number(appliedScale) + PRINT_FIDELITY_EPSILON <
    Number(minimumSafeScale);
  if (belowSafe !== (violations.length > 0)) {
    throw new RangeError(
      "scaleFidelity safe scale and feature violations must agree.",
    );
  }
  if (belowSafe && !fidelity.belowProfileScaleAcknowledged) {
    throw new RangeError(
      "Below-profile 3MF metadata requires explicit acknowledgement.",
    );
  }
  return [
    `  <metadata name="codecity:RequestedScale" preserve="1">${requestedScale}</metadata>`,
    `  <metadata name="codecity:AppliedScale" preserve="1">${appliedScale}</metadata>`,
    `  <metadata name="codecity:ProfileSafeScale" preserve="1">${minimumSafeScale}</metadata>`,
    `  <metadata name="codecity:BelowProfileScaleAcknowledged" preserve="1">${String(fidelity.belowProfileScaleAcknowledged)}</metadata>`,
    `  <metadata name="codecity:FeatureViolations" preserve="1">${xml(JSON.stringify(violations), "scaleFidelity.featureViolations")}</metadata>`,
  ];
}

function coordinate(value: number, field: string): string {
  if (value < 0) {
    throw new TypeError(`${field} must be in the positive print octant.`);
  }
  return canonicalNumber(value, field);
}

interface SerializedPart {
  readonly part: PrintPart;
  readonly materialIndex: number;
  readonly vertexOffset: number;
  readonly firstTriangle: number;
  readonly lastTriangle: number;
}

function serializedParts(
  parts: readonly PrintPart[],
): readonly SerializedPart[] {
  if (parts.length === 0) {
    throw new TypeError("Printable city must contain at least one used channel.");
  }
  const ordered = [...parts].sort(
    (left, right) =>
      compare(left.channelId, right.channelId) ||
      compare(left.id, right.id),
  );
  const ids = new Set<string>();
  const channelIds = new Set<string>();
  let vertexOffset = 0;
  let triangleOffset = 0;
  const result = ordered.map((part, index): SerializedPart => {
    const id = requiredText(part.id, `parts[${index}].id`);
    const channelId = requiredText(
      part.channelId,
      `parts[${index}].channelId`,
    );
    if (ids.has(id)) {
      throw new TypeError(`Duplicate printable part id '${id}'.`);
    }
    if (channelIds.has(channelId)) {
      throw new TypeError(
        `Printable channel '${channelId}' has more than one mesh part.`,
      );
    }
    ids.add(id);
    channelIds.add(channelId);
    if (
      part.mesh.vertices.length >= CORE_INDEX_LIMIT ||
      part.mesh.triangles.length >= CORE_INDEX_LIMIT
    ) {
      throw new TypeError(
        `parts[${index}].mesh exceeds the 3MF Core index limit.`,
      );
    }
    validateMeshForSerialization(
      part.mesh,
      `parts[${index}].mesh`,
      "decimal",
    );
    part.mesh.vertices.forEach((vertex, vertexIndex) => {
      coordinate(
        vertex.x,
        `parts[${index}].mesh.vertices[${vertexIndex}].x`,
      );
      coordinate(
        vertex.y,
        `parts[${index}].mesh.vertices[${vertexIndex}].y`,
      );
      coordinate(
        vertex.z,
        `parts[${index}].mesh.vertices[${vertexIndex}].z`,
      );
    });
    const serialized: SerializedPart = {
      part,
      materialIndex: index,
      vertexOffset,
      firstTriangle: triangleOffset,
      lastTriangle: triangleOffset + part.mesh.triangles.length - 1,
    };
    vertexOffset += part.mesh.vertices.length;
    triangleOffset += part.mesh.triangles.length;
    if (
      vertexOffset >= CORE_INDEX_LIMIT ||
      triangleOffset >= CORE_INDEX_LIMIT
    ) {
      throw new TypeError(
        "Printable city exceeds the 3MF Core index limit.",
      );
    }
    return serialized;
  });
  return result;
}

function combinedMeshXml(parts: readonly SerializedPart[]): string {
  const vertices = parts.flatMap(
    ({ part }, partIndex) =>
      part.mesh.vertices.map(
        (vertex, vertexIndex) =>
          `          <vertex x="${coordinate(vertex.x, `parts[${partIndex}].mesh.vertices[${vertexIndex}].x`)}" y="${coordinate(vertex.y, `parts[${partIndex}].mesh.vertices[${vertexIndex}].y`)}" z="${coordinate(vertex.z, `parts[${partIndex}].mesh.vertices[${vertexIndex}].z`)}"/>`,
      ),
  );
  const triangles = parts.flatMap(
    ({ part, materialIndex, vertexOffset }) =>
      part.mesh.triangles.map(
        (triangle) =>
          `          <triangle v1="${triangle.a + vertexOffset}" v2="${triangle.b + vertexOffset}" v3="${triangle.c + vertexOffset}" pid="${BASE_MATERIAL_RESOURCE_ID}" p1="${materialIndex}" p2="${materialIndex}" p3="${materialIndex}"/>`,
      ),
  );
  return [
    "      <mesh>",
    "        <vertices>",
    ...vertices,
    "        </vertices>",
    "        <triangles>",
    ...triangles,
    "        </triangles>",
    "      </mesh>",
  ].join("\n");
}

function contentTypesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">`,
    `  <Default Extension="rels" ContentType="${RELATIONSHIPS_CONTENT_TYPE}"/>`,
    `  <Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>`,
    `  <Override PartName="/${PRUSA_MODEL_CONFIG_PATH}" ContentType="${XML_CONTENT_TYPE}"/>`,
    "</Types>",
    "",
  ].join("\n");
}

function packageRelationshipsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`,
    `  <Relationship Target="/${MODEL_PATH}" Id="rel-1" Type="${MODEL_RELATIONSHIP_TYPE}"/>`,
    "</Relationships>",
    "",
  ].join("\n");
}

function modelXml(
  city: PrintableCity,
  parts: readonly SerializedPart[],
): string {
  if (city.unit !== "millimeter") {
    throw new TypeError("3MF export requires millimeter print geometry.");
  }
  const title = requiredText(city.title, "title");
  const applicationName = requiredText(
    city.application.name,
    "application.name",
  );
  const applicationVersion = requiredText(
    city.application.version,
    "application.version",
  );
  const profileId = requiredText(city.profileId, "profileId");
  const scale = positiveNumber(city.scale, "scale");

  const metadata = [
    '  <metadata name="slic3rpe:Version3mf">1</metadata>',
    `  <metadata name="Title">${xml(title, "title")}</metadata>`,
    `  <metadata name="Application">${xml(`${applicationName} ${applicationVersion}`, "application")}</metadata>`,
    ...(city.version === undefined
      ? []
      : [
          `  <metadata name="codecity:Version" preserve="1">${xml(requiredText(city.version, "version"), "version")}</metadata>`,
        ]),
    `  <metadata name="codecity:Profile" preserve="1">${xml(profileId, "profileId")}</metadata>`,
    `  <metadata name="codecity:Scale" preserve="1">${scale}</metadata>`,
    ...scaleFidelityMetadata(city),
  ];

  const materials = parts.map(
    ({ part }, index) =>
      `      <base name="${xml(requiredText(part.name, `parts[${index}].name`), `parts[${index}].name`)}" displaycolor="${normalizeDisplayColor(part.displayColor, `parts[${index}].displayColor`)}"/>`,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="und" xmlns="${CORE_NAMESPACE}" xmlns:codecity="${CODE_CITY_NAMESPACE}" xmlns:slic3rpe="${SLIC3R_NAMESPACE}">`,
    ...metadata,
    "  <resources>",
    `    <basematerials id="${BASE_MATERIAL_RESOURCE_ID}">`,
    ...materials,
    "    </basematerials>",
    `    <object id="${CITY_OBJECT_RESOURCE_ID}" type="model" name="${xml(title, "title")}">`,
    combinedMeshXml(parts),
    "    </object>",
    "  </resources>",
    "  <build>",
    `    <item objectid="${CITY_OBJECT_RESOURCE_ID}"/>`,
    "  </build>",
    "</model>",
    "",
  ].join("\n");
}

function prusaModelConfigXml(
  city: PrintableCity,
  parts: readonly SerializedPart[],
): string {
  const title = requiredText(city.title, "title");
  const volumes = parts.flatMap(({ part, firstTriangle, lastTriangle }, index) => {
    const name = xml(
      requiredText(part.name, `parts[${index}].name`),
      `parts[${index}].name`,
    );
    return [
      `    <volume firstid="${firstTriangle}" lastid="${lastTriangle}">`,
      `      <metadata type="volume" key="name" value="${name}"/>`,
      '      <metadata type="volume" key="volume_type" value="ModelPart"/>',
      '      <metadata type="volume" key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
      '      <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>',
      "    </volume>",
    ];
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<config>",
    `  <object id="${CITY_OBJECT_RESOURCE_ID}" instances_count="1">`,
    `    <metadata type="object" key="name" value="${xml(title, "title")}"/>`,
    ...volumes,
    "  </object>",
    "</config>",
    "",
  ].join("\n");
}

/**
 * Serializes normalized print geometry as one standards-based, material-indexed
 * 3MF mesh. The Prusa metadata sidecar maps its stable triangle ranges back to
 * aligned tool volumes without exposing source paths. ZIP timestamps and all
 * resource ordering are fixed so identical geometry produces identical bytes.
 */
export function serializeThreeMf(city: PrintableCity): Uint8Array {
  const parts = serializedParts(city.parts);
  const entries = new Map<string, string>([
    [CONTENT_TYPES_PATH, contentTypesXml()],
    [PACKAGE_RELATIONSHIPS_PATH, packageRelationshipsXml()],
    [MODEL_PATH, modelXml(city, parts)],
    [PRUSA_MODEL_CONFIG_PATH, prusaModelConfigXml(city, parts)],
  ]);
  const files: Record<string, [Uint8Array, { level: 0; mtime: Date }]> = {};
  for (const path of [...entries.keys()].sort(compare)) {
    files[path] = [
      strToU8(entries.get(path)!),
      { level: 0, mtime: FIXED_ZIP_DATE },
    ];
  }
  return zipSync(files, {
    level: 0,
    mtime: FIXED_ZIP_DATE,
  });
}
