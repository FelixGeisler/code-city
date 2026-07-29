import type {
  CityBuilding,
  CityDistrict,
  CityModel,
  CityModule,
  RiskBand,
  SemanticGroup,
} from "../../../packages/core/src/model.js";

export const LARGE_CITY_FIXTURE_NAME = "large-city-25k";
export const LARGE_CITY_BUILDING_COUNT = 25_000;
export const LARGE_CITY_DISTRICT_COUNT = 100;
export const LARGE_CITY_VISUAL_STYLE_COUNT = 5;

const DISTRICT_COLUMNS = 10;
const DISTRICT_ROWS = 10;
const BUILDING_COLUMNS = 25;
const BUILDING_ROWS = 10;
const DISTRICT_SPACING = 58;
const DISTRICT_SIZE = 54;
const BUILDING_SPACING_X = 2;
const BUILDING_SPACING_Z = 5;
const REPOSITORY_ID = "repository:large-city";
const SOLUTION_ID = "solution:large-city";

const STYLE_GROUPS: readonly SemanticGroup[] = Object.freeze([
  {
    id: "style:blue",
    label: "Blue",
    color: "#36a3ff",
    priority: 50,
  },
  {
    id: "style:amber",
    label: "Amber",
    color: "#f0a23a",
    priority: 40,
  },
  {
    id: "style:violet",
    label: "Violet",
    color: "#a98aff",
    priority: 30,
  },
  {
    id: "style:green",
    label: "Green",
    color: "#4ade80",
    priority: 20,
  },
  {
    id: "style:rose",
    label: "Rose",
    color: "#fb7185",
    priority: 10,
  },
]);

/**
 * Public deterministic upper-bound fixture used by unit and browser budgets.
 * It intentionally has no dependency edges so the benchmark isolates the
 * renderer, spatial index, explorer index, and workspace costs.
 */
export function createLargeCityFixture(): CityModel {
  const districts: CityDistrict[] = [];
  const buildings: CityBuilding[] = [];
  const modules: CityModule[] = [];
  const moduleIds: string[] = [];
  const cityWidth = DISTRICT_COLUMNS * DISTRICT_SPACING;
  const cityDepth = DISTRICT_ROWS * DISTRICT_SPACING;

  for (let districtIndex = 0; districtIndex < 100; districtIndex += 1) {
    const districtColumn = districtIndex % DISTRICT_COLUMNS;
    const districtRow = Math.floor(districtIndex / DISTRICT_COLUMNS);
    const districtId = `district:${padded(districtIndex, 3)}`;
    const moduleId = `module:district-${padded(districtIndex, 3)}`;
    const districtX =
      (districtColumn - (DISTRICT_COLUMNS - 1) * 0.5) * DISTRICT_SPACING;
    const districtZ =
      (districtRow - (DISTRICT_ROWS - 1) * 0.5) * DISTRICT_SPACING;
    moduleIds.push(moduleId);
    modules.push({
      id: moduleId,
      repositoryId: REPOSITORY_ID,
      kind: "npm-package",
      name: `District ${padded(districtIndex + 1, 3)}`,
      path: `src/district-${padded(districtIndex, 3)}`,
      solutionIds: [SOLUTION_ID],
      packageId: `@code-city/large-district-${padded(districtIndex, 3)}`,
    });
    districts.push({
      id: districtId,
      repositoryId: REPOSITORY_ID,
      moduleId,
      name: `District ${padded(districtIndex + 1, 3)}`,
      path: `src/district-${padded(districtIndex, 3)}`,
      position: { x: districtX, y: 0.5, z: districtZ },
      size: { x: DISTRICT_SIZE, y: 1, z: DISTRICT_SIZE },
    });

    for (
      let localIndex = 0;
      localIndex < BUILDING_COLUMNS * BUILDING_ROWS;
      localIndex += 1
    ) {
      const buildingIndex =
        districtIndex * BUILDING_COLUMNS * BUILDING_ROWS + localIndex;
      const column = localIndex % BUILDING_COLUMNS;
      const row = Math.floor(localIndex / BUILDING_COLUMNS);
      const styleIndex = buildingIndex % LARGE_CITY_VISUAL_STYLE_COUNT;
      const height = 1.5 + styleIndex * 0.75;
      const maximumComplexity = 2 + styleIndex * 4;
      buildings.push({
        id: `building:${padded(buildingIndex, 5)}`,
        repositoryId: REPOSITORY_ID,
        moduleId,
        districtId,
        name: `file-${padded(buildingIndex, 5)}.ts`,
        path:
          `src/district-${padded(districtIndex, 3)}/` +
          `file-${padded(buildingIndex, 5)}.ts`,
        language: "typescript",
        metrics: {
          sloc: 20 + (buildingIndex % 980),
          decisionLoad: 1 + (buildingIndex % 100),
          maximumComplexity,
          executableUnitCount: 1 + (buildingIndex % 32),
        },
        risk: riskForComplexity(maximumComplexity),
        semanticGroupId: STYLE_GROUPS[styleIndex]!.id,
        position: {
          x:
            districtX +
            (column - (BUILDING_COLUMNS - 1) * 0.5) *
              BUILDING_SPACING_X,
          y: 1 + height * 0.5,
          z:
            districtZ +
            (row - (BUILDING_ROWS - 1) * 0.5) * BUILDING_SPACING_Z,
        },
        size: { x: 1.55, y: height, z: 4.25 },
      });
    }
  }

  return {
    schemaVersion: "1.0",
    generator: {
      name: "code-city",
      version: "large-city-25k-v1",
    },
    repositories: [{ id: REPOSITORY_ID, name: "Large City Fixture" }],
    solutions: [
      {
        id: SOLUTION_ID,
        repositoryId: REPOSITORY_ID,
        name: "Large City Fixture",
        path: ".",
        moduleIds,
      },
    ],
    modules,
    semanticGroups: [
      {
        id: "base",
        label: "Base",
        color: "#6b7280",
        priority: 100,
      },
      ...STYLE_GROUPS,
    ],
    identity: {
      title: "Large City Performance Fixture",
      version: "25,000 buildings",
    },
    base: {
      id: "base:large-city",
      semanticGroupId: "base",
      position: { x: 0, y: 0.25, z: 0 },
      size: { x: cityWidth, y: 0.5, z: cityDepth },
    },
    districts,
    buildings,
    dependencies: [],
    bounds: {
      x: cityWidth,
      y: 5,
      z: cityDepth,
    },
  };
}

function riskForComplexity(complexity: number): RiskBand {
  if (complexity <= 5) return "low";
  if (complexity <= 10) return "moderate";
  if (complexity <= 20) return "high";
  return "very-high";
}

function padded(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}
