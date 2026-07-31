import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  EXTERNAL_DEPENDENCY_COLOR,
  layoutExternalDependencies,
  resolveExternalDependencyNode,
  selectExternalDependencies,
  type ExternalDependencyLayout,
  type ExternalDependencyLayoutNode,
} from "../../../packages/core/src/external-dependencies.js";
import type {
  CityBase,
  CityBuilding,
  CityDistrict,
  CityModel,
  CityModule,
  CityRepository,
  DependencyKind,
  SemanticGroup,
} from "../../../packages/core/src/model.js";
import type { PrinterProfile } from "../../../packages/core/src/print.js";
import {
  canRevealMoreExecutableUnits,
  INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  presentExecutableUnits,
} from "./building-inspector.js";
import { cityBaseForModel } from "./city-surface.js";
import {
  createDependencyExplorerIndex,
  DEPENDENCY_ROUTES_PER_DIRECTION,
  dependencyRoutesForBuilding,
  type DependencyRouteDirection,
  type DependencyRouteEndpoint,
  type DependencyRouteProjection,
  type DependencyRouteToggleState,
  projectDependencyRoute,
  resetDependencyRouteState,
  type SelectedDependencyRoute,
  toggleDependencyRouteDirection,
} from "./dependency-explorer.js";
import {
  createDistrictDependencyExplorerIndex,
  DISTRICT_DEPENDENCY_BUNDLES_LIMIT,
  type DistrictDependencyBundle,
  type DistrictDependencyEndpoint,
  type DistrictDependencyFilters,
  resetDistrictDependencyFilters,
  summarizeDistrictDependencies,
  toggleDistrictDependencyKind,
} from "./district-dependency-explorer.js";
import {
  districtBoundaryAnchor,
  type DistrictDependencyFootprint,
  districtRouteEndpoints,
  keyedIsolationGateway,
} from "./district-dependency-layout.js";
import {
  type DependencyOverlayRoute,
  DependencyRouteOverlay,
} from "./dependency-overlay.js";
import {
  buildingRouteEndpoint,
  routeEndpointKey,
  type RouteEndpointGeometry,
} from "./dependency-route-layout.js";
import { DEMO_MODEL } from "./demo-model.js";
import { presentExternalDependency } from "./external-dependency-inspector.js";
import { installProjectImportDialog } from "./project-import-dialog.js";
import { installPrintExportDialog } from "./print-export-dialog.js";
import {
  createLargeCityFixture,
  LARGE_CITY_FIXTURE_NAME,
} from "./large-city-fixture.js";
import { installMetricMappingPanel } from "./metric-mapping-panel.js";
import {
  type ProjectedPrintPlate,
  viewerPrintMeshBatches,
} from "./print-plate-preview.js";
import { installPrintPlateToolbar } from "./print-plate-toolbar.js";
import {
  AutomaticModelLoadGate,
  assetRootFromResponseUrl,
  type LoadedViewerImage,
  remoteViewerDisplayUrl,
  resolveAssetUrl,
  sortLegendGroups,
  ViewerLoadGateway,
} from "./model-source.js";
import { validateCityModel } from "./model-validation.js";
import { ViewerImportApiClient } from "./import-api.js";
import {
  loadBuildingSource,
  sourceOmissionMarker,
  sourceLineWindow,
  sourceLineTokens,
  type BuildingSource,
} from "./source-navigation.js";
import {
  createRepositoryExplorerIndex,
  DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT,
  type ExplorerState,
  isolateSelectedDistrict as isolateExplorerDistrict,
  MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT,
  resetExplorerState,
  searchRepositoryEntities,
  selectedExplorerBuildingId,
  selectedExplorerDistrictId,
  selectedExplorerExternalId,
  selectExplorerBuilding,
  selectExplorerDistrict,
  showAllDistricts,
} from "./repository-explorer.js";
import {
  createSceneEntity,
  decodeSceneEntityKey,
  encodeSceneEntityKey,
  sameSceneEntity,
  type SceneEntity,
} from "./scene-entity.js";
import {
  type SceneLabel,
  sceneLabelAccessibleName,
  SceneLabelOverlay,
} from "./scene-label-overlay.js";
import {
  DEFAULT_FOG_DENSITY,
  fogDensityForCameraDistance,
} from "./scene-environment.js";
import { groundGridLayout } from "./scene-grid.js";
import {
  cameraDistanceForBounds,
  cameraMaximumDistanceForFrame,
  focusedDistrictBounds,
  semanticPickingEnabled,
  type ScenePresentationMode,
} from "./scene-navigation.js";
import {
  installViewerWorkspace,
  nextBoundedResultLimit,
} from "./viewer-workspace.js";
import { summarizeViewerScope } from "./viewer-overview.js";
import {
  assertViewerBuildingCapability,
  ViewerBuildingLayer,
  type ViewerBuildingDefinition,
  type ViewerBuildingRenderMode,
} from "./viewer-building-layer.js";
import { ViewerFramePicker } from "./viewer-frame-picker.js";
import { supportsViewerInstancing } from "./viewer-render-capability.js";
import {
  createViewerVisualization,
  describeBuildingMetrics,
  type EvolutionVisualizationData,
  type ViewerVisualizationMode,
} from "./visualization-mode.js";
import {
  EvolutionSeekGate,
  type EvolutionBuildingHistory,
  type EvolutionFrameSummary,
  type EvolutionTransition,
} from "./evolution-timeline.js";
import { EvolutionTimelineWorkerClient } from "./evolution-timeline-worker-client.js";
import "./styles.css";

interface BuildingContext {
  readonly building: CityBuilding;
  readonly repository: CityRepository;
  readonly module: CityModule;
}

interface DistrictContext {
  readonly district: CityDistrict;
  readonly repository: CityRepository;
  readonly module: CityModule;
  readonly buildingCount: number;
}

type ExternalSceneNode = ExternalDependencyLayoutNode;

interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

interface CameraTransition {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly fromPosition: THREE.Vector3;
  readonly fromTarget: THREE.Vector3;
  readonly toPosition: THREE.Vector3;
  readonly toTarget: THREE.Vector3;
}

interface ModelSource {
  readonly label: string;
  readonly assetRoot?: URL;
  readonly jobId?: string;
  readonly sourceAvailability?:
    | "disabled"
    | "not-captured"
    | "retained"
    | "unavailable";
  readonly evolution?: {
    readonly artifactUrl: string;
    readonly size: number;
    readonly sha256: string;
  };
}

interface SceneEvolutionAnimation {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly addedIds: ReadonlySet<string>;
  readonly fromById: ReadonlyMap<
    string,
    {
      readonly position: CityBuilding["position"];
      readonly size: CityBuilding["size"];
    }
  >;
  readonly ghosts: THREE.Group;
}

interface ViewerPerformanceDiagnostics {
  readonly buildingRenderMode: ViewerBuildingRenderMode | null;
  readonly buildingBatchCount: number;
  readonly objectCount: number;
  readonly renderCalls: number;
  readonly pickBenchmark: {
    readonly count: number;
    readonly p95Milliseconds: number;
    readonly maximumAabbTests: number;
  };
}

declare global {
  interface Window {
    __CODE_CITY_PERFORMANCE__?: ViewerPerformanceDiagnostics & {
      readonly ready: true;
      readonly firstInteractiveMilliseconds: number;
    };
  }
}

const INITIAL_ROUTE_RESULT_LIMIT = 8;

const sceneHost = element<HTMLDivElement>("scene");
const viewerWorkspace = installViewerWorkspace(
  element<HTMLElement>("viewer-workspace"),
  element<HTMLElement>("viewer-workspace-scroll"),
);
const fileInput = element<HTMLInputElement>("model-file");
const fileOpenButton = element<HTMLButtonElement>("model-file-open");
const demoButton = element<HTMLButtonElement>("demo-button");
const printExportOpenButton =
  element<HTMLButtonElement>("print-export-open");
const metricPreviewBanner =
  element<HTMLParagraphElement>("metric-preview-banner");
const statusElement = element<HTMLParagraphElement>("status");
const modelNameElement = element<HTMLParagraphElement>("model-name");
const modelLogo = element<HTMLImageElement>("model-logo");
const modelLogoPlaceholder = element<HTMLSpanElement>(
  "model-logo-placeholder",
);
const inspectorEmpty = element<HTMLDivElement>("inspector-empty");
const inspectorContent = element<HTMLDivElement>("inspector-content");
const districtInspectorContent = element<HTMLDivElement>(
  "district-inspector-content",
);
const externalInspectorContent = element<HTMLDivElement>(
  "external-inspector-content",
);
const clearSelectionButton =
  element<HTMLButtonElement>("clear-selection");
const selectionKind = element<HTMLElement>("inspector-title");
const selectionName = element<HTMLHeadingElement>("selection-name");
const dependencySection =
  element<HTMLDetailsElement>("dependency-section");
const viewerScopeName = element<HTMLElement>("viewer-scope-name");
const viewerScopeReset =
  element<HTMLButtonElement>("viewer-scope-reset");
const legend = element<HTMLUListElement>("legend");
const visualizationModeSelect =
  element<HTMLSelectElement>("visualization-mode");
const visualizationModeStatus =
  element<HTMLParagraphElement>("visualization-mode-status");
const evolutionTimeline = element<HTMLElement>("evolution-timeline");
const evolutionFirst = element<HTMLButtonElement>("evolution-first");
const evolutionPrevious =
  element<HTMLButtonElement>("evolution-previous");
const evolutionPlay = element<HTMLButtonElement>("evolution-play");
const evolutionNext = element<HTMLButtonElement>("evolution-next");
const evolutionLast = element<HTMLButtonElement>("evolution-last");
const evolutionRange = element<HTMLInputElement>("evolution-range");
const evolutionSpeed = element<HTMLSelectElement>("evolution-speed");
const evolutionCommit = element<HTMLElement>("evolution-commit");
const evolutionStatus = element<HTMLElement>("evolution-status");
const externalZone = element<HTMLElement>("external-zone");
const externalList = element<HTMLUListElement>("external-list");
const overviewFields = {
  description: element<HTMLParagraphElement>(
    "overview-scope-description",
  ),
  repositories: element<HTMLElement>("overview-repositories"),
  solutions: element<HTMLElement>("overview-solutions"),
  modules: element<HTMLElement>("overview-modules"),
  districts: element<HTMLElement>("overview-districts"),
  buildings: element<HTMLElement>("overview-buildings"),
  sloc: element<HTMLElement>("overview-sloc"),
  medianComplexity: element<HTMLElement>(
    "overview-median-complexity",
  ),
  maximumComplexity: element<HTMLElement>(
    "overview-max-complexity",
  ),
  dependencyEdges: element<HTMLElement>(
    "overview-dependency-edges",
  ),
  referenceWeight: element<HTMLElement>(
    "overview-reference-weight",
  ),
};
const overviewRiskFields = {
  low: {
    count: element<HTMLElement>("overview-risk-low"),
    bar: element<HTMLElement>("overview-risk-low-bar"),
  },
  moderate: {
    count: element<HTMLElement>("overview-risk-moderate"),
    bar: element<HTMLElement>("overview-risk-moderate-bar"),
  },
  high: {
    count: element<HTMLElement>("overview-risk-high"),
    bar: element<HTMLElement>("overview-risk-high-bar"),
  },
  "very-high": {
    count: element<HTMLElement>("overview-risk-very-high"),
    bar: element<HTMLElement>("overview-risk-very-high-bar"),
  },
} as const;
const selectionStatus = element<HTMLParagraphElement>("selection-status");
const errorBanner = element<HTMLDivElement>("error-banner");
const errorMessage = element<HTMLSpanElement>("error-message");
const dismissErrorButton = element<HTMLButtonElement>("dismiss-error");
const dependencyIncomingToggle = element<HTMLButtonElement>(
  "dependency-incoming-toggle",
);
const dependencyIncomingCount = element<HTMLElement>(
  "dependency-incoming-count",
);
const dependencyOutgoingToggle = element<HTMLButtonElement>(
  "dependency-outgoing-toggle",
);
const dependencyOutgoingCount = element<HTMLElement>(
  "dependency-outgoing-count",
);
const dependencyStatus =
  element<HTMLParagraphElement>("dependency-status");
const dependencyEmpty = element<HTMLParagraphElement>("dependency-empty");
const dependencyList = element<HTMLUListElement>("dependency-list");
const dependencyShowMore =
  element<HTMLButtonElement>("dependency-show-more");
const findPanel = element<HTMLElement>("find-panel");
const buildingSearch = element<HTMLInputElement>("building-search");
const searchStatus = element<HTMLParagraphElement>("search-status");
const searchResults = element<HTMLUListElement>("search-results");
const searchShowMore = element<HTMLButtonElement>("search-show-more");
const isolateDistrictButton =
  element<HTMLButtonElement>("isolate-district");
const showWholeCityButton =
  element<HTMLButtonElement>("show-whole-city");
const districtRoutesToggle =
  element<HTMLButtonElement>("district-routes-toggle");
const districtRouteTypeScriptFilter = element<HTMLButtonElement>(
  "district-route-filter-typescript",
);
const districtRouteTypeScriptCount = element<HTMLElement>(
  "district-route-filter-typescript-count",
);
const districtRouteProjectFilter = element<HTMLButtonElement>(
  "district-route-filter-project",
);
const districtRouteProjectCount = element<HTMLElement>(
  "district-route-filter-project-count",
);
const districtRoutePackageFilter = element<HTMLButtonElement>(
  "district-route-filter-package",
);
const districtRoutePackageCount = element<HTMLElement>(
  "district-route-filter-package-count",
);
const districtRoutesStatus =
  element<HTMLParagraphElement>("district-routes-status");
const districtRoutesList =
  element<HTMLUListElement>("district-routes-list");
const districtRoutesShowMore = element<HTMLButtonElement>(
  "district-routes-show-more",
);
const districtRouteDetails =
  element<HTMLElement>("district-route-details");
const districtRouteDetailTitle =
  element<HTMLHeadingElement>("district-route-detail-title");
const districtRouteDetailSummary = element<HTMLParagraphElement>(
  "district-route-detail-summary",
);
const districtRouteDetailKinds = element<HTMLParagraphElement>(
  "district-route-detail-kinds",
);
const districtRouteContributors = element<HTMLUListElement>(
  "district-route-contributors",
);
const districtRouteIsolateConsumer = element<HTMLButtonElement>(
  "district-route-isolate-consumer",
);
const districtRouteIsolateProvider = element<HTMLButtonElement>(
  "district-route-isolate-provider",
);

const inspectorFields = {
  name: element<HTMLHeadingElement>("building-name"),
  repository: element<HTMLElement>("building-repository"),
  module: element<HTMLElement>("building-module"),
  path: element<HTMLElement>("building-path"),
  language: element<HTMLElement>("building-language"),
  sloc: element<HTMLElement>("building-sloc"),
  load: element<HTMLElement>("building-load"),
  cc: element<HTMLElement>("building-cc"),
  metricMethod: element<HTMLElement>("building-metric-method"),
  metricExplanation: element<HTMLParagraphElement>(
    "building-metric-explanation",
  ),
  evolutionRow: element<HTMLElement>("building-evolution-row"),
  evolution: element<HTMLElement>("building-evolution"),
  unitCount: element<HTMLElement>("building-unit-count"),
  unitsEmpty: element<HTMLParagraphElement>("building-units-empty"),
  unitsDetails: element<HTMLDetailsElement>("building-units-details"),
  unitsSummary: element<HTMLElement>("building-units-summary"),
  unitsCaption: element<HTMLTableCaptionElement>("building-units-caption"),
  units: element<HTMLTableSectionElement>("building-units"),
  unitsShowMore: element<HTMLButtonElement>("building-units-show-more"),
  sourceDetails: element<HTMLDetailsElement>("building-source-details"),
  sourceSummary: element<HTMLElement>("building-source-summary"),
  sourceStatus: element<HTMLParagraphElement>("building-source-status"),
  sourceContent: element<HTMLDivElement>("building-source-content"),
  sourcePath: element<HTMLElement>("building-source-path"),
  sourceRevision: element<HTMLElement>("building-source-revision"),
  sourceExternal: element<HTMLAnchorElement>("building-source-external"),
  sourceEditor: element<HTMLAnchorElement>("building-source-editor"),
  sourceCode: element<HTMLPreElement>("building-source-code"),
};

const districtInspectorFields = {
  name: element<HTMLHeadingElement>("district-name"),
  repository: element<HTMLElement>("district-repository"),
  module: element<HTMLElement>("district-module"),
  path: element<HTMLElement>("district-path"),
  buildingCount: element<HTMLElement>("district-building-count"),
};

const externalInspectorFields = {
  name: element<HTMLHeadingElement>("external-name"),
  target: element<HTMLElement>("external-target"),
  weight: element<HTMLElement>("external-weight"),
  edgeCount: element<HTMLElement>("external-edge-count"),
  targetCount: element<HTMLElement>("external-target-count"),
  kinds: element<HTMLElement>("external-kinds"),
  consumerCount: element<HTMLElement>("external-consumer-count"),
  consumers: element<HTMLUListElement>("external-consumers"),
  omitted: element<HTMLParagraphElement>("external-consumers-omitted"),
};

class CityScene {
  private readonly scene = new THREE.Scene();
  private readonly fog = new THREE.FogExp2(
    "#07111f",
    DEFAULT_FOG_DENSITY,
  );
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5_000);
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  private readonly instancingSupported = supportsViewerInstancing(
    this.renderer.getContext(),
  );
  private readonly controls = new OrbitControls(
    this.camera,
    this.renderer.domElement,
  );
  private readonly raycaster = new THREE.Raycaster();
  private readonly city = new THREE.Group();
  private readonly printPlate = new THREE.Group();
  private readonly dependencyOverlay = new DependencyRouteOverlay(
    this.scene,
    "code-city:dependency-routes",
    { instancingSupported: this.instancingSupported },
  );
  private readonly districtDependencyOverlay = new DependencyRouteOverlay(
    this.scene,
    "code-city:district-dependency-routes",
    { instancingSupported: this.instancingSupported },
  );
  private readonly sceneLabelOverlay = new SceneLabelOverlay(this.scene);
  private readonly districtMeshes = new Map<
    string,
    THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  >();
  private readonly externalMeshes = new Map<
    string,
    THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  >();
  private readonly externalNodes = new Map<string, ExternalSceneNode>();
  private readonly buildingContexts = new Map<string, BuildingContext>();
  private readonly districtContexts = new Map<string, DistrictContext>();
  private readonly districtGroups = new Map<string, THREE.Group>();
  private readonly resizeObserver: ResizeObserver;
  private readonly pointerPicker: ViewerFramePicker<
    PointerPosition,
    SceneEntity | null
  >;
  private buildingLayer: ViewerBuildingLayer | null = null;
  private grid: THREE.GridHelper | null = null;
  private hoveredEntity: SceneEntity | null = null;
  private selectedEntity: SceneEntity | null = null;
  private isolatedDistrictId: string | null = null;
  private cameraTransition: CameraTransition | null = null;
  private evolutionAnimation: SceneEvolutionAnimation | null = null;
  private fullCityMaxDistance = 20;
  private fullCityFar = 100;
  private pointerStart: PointerPosition | null = null;
  private presentationMode: ScenePresentationMode = "city";
  private visualizationModeLabel = "Semantic groups";
  private semanticColors = new Map<string, string>();
  private prePrintOverlayVisibility:
    | {
        dependencies: boolean;
        districtDependencies: boolean;
        labels: boolean;
      }
    | undefined;

  public constructor(
    private readonly host: HTMLDivElement,
    private readonly onStateChange: (state: ExplorerState) => void,
    private readonly requestCityPresentation: () => void,
  ) {
    this.scene.background = new THREE.Color("#07111f");
    this.scene.fog = this.fog;
    this.scene.add(this.city);
    this.printPlate.visible = false;
    this.scene.add(this.printPlate);

    const hemisphere = new THREE.HemisphereLight("#b9ddff", "#162033", 2.1);
    this.scene.add(hemisphere);

    const keyLight = new THREE.DirectionalLight("#ffffff", 3.1);
    keyLight.position.set(35, 55, 25);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2_048, 2_048);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight("#6c8cff", 1.2);
    fillLight.position.set(-30, 22, -24);
    this.scene.add(fillLight);

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D code city",
    );
    this.host.append(this.renderer.domElement);

    this.camera.position.set(25, 22, 28);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 2;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener("start", () => {
      this.cameraTransition = null;
    });

    this.renderer.domElement.addEventListener(
      "pointerdown",
      this.onPointerDown,
    );
    this.renderer.domElement.addEventListener(
      "pointermove",
      this.onPointerMove,
    );
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener(
      "pointerleave",
      this.onPointerLeave,
    );
    this.pointerPicker = new ViewerFramePicker(
      (pointer) => this.pick(pointer),
      (entity) => this.hover(entity),
      {
        request: (callback) => window.requestAnimationFrame(callback),
        cancel: (handle) => window.cancelAnimationFrame(handle),
      },
    );

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.renderer.setAnimationLoop(this.render);
  }

  public load(
    model: CityModel,
    effectiveBase: CityBase | undefined,
    externalNodes: readonly ExternalSceneNode[],
    frame = true,
  ): void {
    this.assertBuildingCapability(model.buildings.length);
    const repositories = new Map(
      model.repositories.map((item) => [item.id, item]),
    );
    const modules = new Map(model.modules.map((item) => [item.id, item]));
    const groups = new Map(
      model.semanticGroups.map((item) => [item.id, item]),
    );
    const districtIds = new Set(model.districts.map(({ id }) => id));
    for (const district of model.districts) {
      if (
        !repositories.has(district.repositoryId) ||
        !modules.has(district.moduleId)
      ) {
        throw new Error(
          `District "${district.id}" has invalid model references`,
        );
      }
    }
    const buildingDefinitions: ViewerBuildingDefinition[] =
      model.buildings.map((building) => {
        const semanticGroup = groups.get(building.semanticGroupId);
        if (
          !semanticGroup ||
          !repositories.has(building.repositoryId) ||
          !modules.has(building.moduleId)
        ) {
          throw new Error(
            `Building "${building.id}" has invalid model references`,
          );
        }
        if (!districtIds.has(building.districtId)) {
          throw new Error(
            `Building "${building.id}" references an unknown district`,
          );
        }
        return {
          id: building.id,
          districtId: building.districtId,
          position: building.position,
          size: building.size,
          color: semanticGroup.color,
          style: {
            roughness: 0.58,
            metalness: 0.08,
          },
        };
      });
    const nextBuildingLayer = new ViewerBuildingLayer(buildingDefinitions, {
      instancingSupported: this.instancingSupported,
    });

    this.clear();
    this.showCityLayout(false);
    this.semanticColors = new Map(
      model.semanticGroups.map(({ id, color }) => [id, color]),
    );
    const buildingCountsByDistrictId = new Map<string, number>();
    for (const building of model.buildings) {
      buildingCountsByDistrictId.set(
        building.districtId,
        (buildingCountsByDistrictId.get(building.districtId) ?? 0) + 1,
      );
    }
    const base = effectiveBase ?? cityBaseForModel(model);
    let gridY = 0;
    if (base !== undefined) {
      const geometry = new THREE.BoxGeometry(
        base.size.x,
        base.size.y,
        base.size.z,
      );
      const material = new THREE.MeshStandardMaterial({
        color: groups.get(base.semanticGroupId)?.color ?? "#4b5563",
        roughness: 0.95,
        metalness: 0,
      });
      const foundation = new THREE.Mesh(geometry, material);
      foundation.position.set(
        base.position.x,
        base.position.y,
        base.position.z,
      );
      foundation.receiveShadow = true;
      foundation.userData["semanticGroupId"] = base.semanticGroupId;
      this.city.add(foundation);

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({
          color: "#9aa6b5",
          transparent: true,
          opacity: 0.52,
        }),
      );
      outline.position.copy(foundation.position);
      this.city.add(outline);
      gridY = base.position.y - base.size.y / 2 - 0.01;
    }

    for (const district of model.districts) {
      const repository = repositories.get(district.repositoryId);
      const module = modules.get(district.moduleId);
      if (!repository || !module) {
        throw new Error(
          `District "${district.id}" has invalid model references`,
        );
      }
      const districtGroup = new THREE.Group();
      districtGroup.userData["districtId"] = district.id;
      this.city.add(districtGroup);
      this.districtGroups.set(district.id, districtGroup);

      const geometry = new THREE.BoxGeometry(
        district.size.x,
        district.size.y,
        district.size.z,
      );
      const material = new THREE.MeshStandardMaterial({
        color: "#182a43",
        roughness: 0.88,
        metalness: 0.05,
      });
      const base = new THREE.Mesh(geometry, material);
      base.position.set(
        district.position.x,
        district.position.y,
        district.position.z,
      );
      base.receiveShadow = true;
      base.userData["sceneEntityKey"] = encodeSceneEntityKey(
        createSceneEntity("district", district.id),
      );
      districtGroup.add(base);
      this.districtMeshes.set(district.id, base);
      this.districtContexts.set(district.id, {
        district,
        repository,
        module,
        buildingCount: buildingCountsByDistrictId.get(district.id) ?? 0,
      });

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({
          color: "#42688d",
          transparent: true,
          opacity: 0.72,
        }),
      );
      outline.position.copy(base.position);
      districtGroup.add(outline);
    }

    for (const building of model.buildings) {
      const repository = repositories.get(building.repositoryId);
      const module = modules.get(building.moduleId);
      if (!repository || !module) {
        throw new Error(
          `Building "${building.id}" has invalid model references`,
        );
      }
      this.buildingContexts.set(building.id, {
        building,
        repository,
        module,
      });
    }
    this.buildingLayer = nextBuildingLayer;
    this.city.add(nextBuildingLayer.object);

    for (const node of externalNodes) {
      const geometry = new THREE.BoxGeometry(
        node.size.x,
        node.size.y,
        node.size.z,
      );
      const material = new THREE.MeshStandardMaterial({
        color: EXTERNAL_DEPENDENCY_COLOR,
        roughness: 0.72,
        metalness: 0.12,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        node.position.x,
        node.position.y,
        node.position.z,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData["externalNodeId"] = node.id;
      mesh.userData["sceneEntityKey"] = encodeSceneEntityKey(
        createSceneEntity("external", node.id),
      );
      this.city.add(mesh);
      this.externalMeshes.set(node.id, mesh);
      this.externalNodes.set(node.id, node);

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({
          color: "#8da2bb",
          transparent: true,
          opacity: 0.46,
        }),
      );
      outline.position.copy(mesh.position);
      this.city.add(outline);
    }

    if (model.identityPanel) {
      this.addIdentityPanel(model);
    }

    this.replaceGrid(this.bounds(), gridY);
    if (frame) {
      this.frame();
    } else {
      this.preserveCameraForBounds(this.bounds());
    }
  }

  public showCityLayout(frame = true): void {
    this.presentationMode = "city";
    this.city.visible = true;
    this.printPlate.visible = false;
    if (this.prePrintOverlayVisibility !== undefined) {
      this.dependencyOverlay.object.visible =
        this.prePrintOverlayVisibility.dependencies;
      this.districtDependencyOverlay.object.visible =
        this.prePrintOverlayVisibility.districtDependencies;
      this.sceneLabelOverlay.object.visible =
        this.prePrintOverlayVisibility.labels;
      this.prePrintOverlayVisibility = undefined;
    }
    if (frame && this.city.children.length > 0) {
      this.replaceGrid(this.bounds(), this.cityBaseBottom());
      this.frameObject(this.city, true);
    }
  }

  public setVisualization(
    colorsByBuildingId: ReadonlyMap<string, string>,
    label: string,
  ): void {
    this.visualizationModeLabel = label;
    this.buildingLayer?.setColors(colorsByBuildingId);
    this.refreshSceneLabels();
  }

  public showEvolutionTransition(
    transition: EvolutionTransition,
    reducedMotion: boolean,
  ): void {
    this.clearEvolutionAnimation();
    const ghosts = new THREE.Group();
    ghosts.name = "code-city:evolution-removals";
    for (const building of transition.removedBuildings) {
      const geometry = new THREE.BoxGeometry(
        building.size.x,
        building.size.y,
        building.size.z,
      );
      const material = new THREE.MeshBasicMaterial({
        color: "#fb7185",
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        building.position.x,
        building.position.y,
        building.position.z,
      );
      ghosts.add(mesh);
    }
    this.city.add(ghosts);
    const addedIds = new Set(transition.addedBuildingIds);
    const fromById = new Map(
      transition.interpolatedBuildings.map((building) => [
        building.id,
        building,
      ]),
    );
    this.buildingLayer?.setEvolutionProgress(
      addedIds,
      fromById,
      reducedMotion ? 1 : 0,
    );
    this.evolutionAnimation = {
      startedAt: performance.now(),
      durationMs: reducedMotion ? Number.POSITIVE_INFINITY : 700,
      addedIds,
      fromById,
      ghosts,
    };
  }

  public finishEvolutionTransition(): void {
    this.clearEvolutionAnimation();
  }

  public showPrintPlate(plate: ProjectedPrintPlate): void {
    this.hover(null);
    this.pointerPicker.cancel();
    this.pointerStart = null;
    this.presentationMode = "print";
    if (!this.printPlate.visible) {
      this.prePrintOverlayVisibility = {
        dependencies: this.dependencyOverlay.object.visible,
        districtDependencies:
          this.districtDependencyOverlay.object.visible,
        labels: this.sceneLabelOverlay.object.visible,
      };
    }
    this.clearPrintPlate();
    const batchStyles = new Map<
      string,
      {
        readonly color: string;
        readonly roughness: number;
        readonly castShadow: boolean;
      }
    >();
    const batches = viewerPrintMeshBatches(plate.entities, (entity) => {
      const color = this.printEntityColor(
        entity.kind,
        entity.semanticGroupId,
      );
      const roughness = entity.kind === "base" ? 0.92 : 0.66;
      const castShadow = entity.kind !== "base";
      const key = `${color}|${roughness}|${String(castShadow)}`;
      batchStyles.set(key, { color, roughness, castShadow });
      return key;
    });
    for (const batch of batches) {
      const style = batchStyles.get(batch.key)!;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(batch.buffers.positions, 3),
      );
      geometry.setIndex(
        new THREE.BufferAttribute(batch.buffers.indices, 1),
      );
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({
        color: style.color,
        roughness: style.roughness,
        metalness: 0.03,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = style.castShadow;
      mesh.receiveShadow = true;
      this.printPlate.add(mesh);
    }
    this.city.visible = false;
    this.printPlate.visible = true;
    this.dependencyOverlay.object.visible = false;
    this.districtDependencyOverlay.object.visible = false;
    this.sceneLabelOverlay.object.visible = false;
    const bounds = new THREE.Box3().setFromObject(this.printPlate);
    if (!bounds.isEmpty()) {
      this.replaceGrid(bounds, bounds.min.y - 0.01);
      this.frameObject(this.printPlate, true);
    }
  }

  private printEntityColor(
    kind: string,
    semanticGroupId: string | undefined,
  ): string {
    if (kind === "dependency-endpoint") return EXTERNAL_DEPENDENCY_COLOR;
    if (kind === "dependency-trace" || kind === "dependency-socket") {
      return "#3b82f6";
    }
    if (kind === "identity-panel" || kind === "identity-relief") {
      return this.semanticColors.get("identity") ?? "#78d6c6";
    }
    if (kind === "base" || kind === "district") {
      return this.semanticColors.get("base") ?? "#718096";
    }
    return (
      (semanticGroupId === undefined
        ? undefined
        : this.semanticColors.get(semanticGroupId)) ?? "#75d5a7"
    );
  }

  private cityBaseBottom(): number {
    const bounds = new THREE.Box3().setFromObject(this.city);
    return bounds.isEmpty() ? 0 : bounds.min.y - 0.01;
  }

  private addIdentityPanel(model: CityModel): void {
    const panel = model.identityPanel;
    if (!panel) {
      return;
    }

    const panelColor =
      model.semanticGroups.find(
        (group) => group.id === panel.semanticGroupId,
      )?.color ?? "#78d6c6";
    const geometry = new THREE.BoxGeometry(
      panel.size.x,
      panel.size.y,
      panel.size.z,
    );
    const material = new THREE.MeshStandardMaterial({
      color: panelColor,
      roughness: 0.52,
      metalness: 0.16,
    });
    const plaque = new THREE.Mesh(geometry, material);
    plaque.position.set(panel.position.x, panel.position.y, panel.position.z);
    plaque.castShadow = true;
    plaque.receiveShadow = true;
    this.city.add(plaque);

    const label = makePanelLabel(
      model.identity?.title ?? model.repositories[0]?.name ?? "Code City",
      model.identity?.version,
    );
    const labelHeight = Math.min(panel.size.y * 0.66, panel.size.x * 0.2);
    const labelGeometry = new THREE.PlaneGeometry(
      panel.size.x * 0.86,
      labelHeight,
    );
    const labelMaterial = new THREE.MeshBasicMaterial({
      map: label,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const labelMesh = new THREE.Mesh(labelGeometry, labelMaterial);
    labelMesh.position.set(
      panel.position.x,
      panel.position.y,
      panel.position.z - panel.size.z / 2 - panel.reliefDepth - 0.002,
    );
    labelMesh.rotation.y = Math.PI;
    labelMesh.renderOrder = 2;
    this.city.add(labelMesh);
  }

  public resetSelection(): void {
    this.select(null);
  }

  public replaceDependencyRoutes(
    routes: readonly DependencyOverlayRoute[],
  ): void {
    this.dependencyOverlay.replace(routes);
    if (this.prePrintOverlayVisibility !== undefined) {
      this.prePrintOverlayVisibility.dependencies = routes.length > 0;
    }
  }

  public replaceDistrictDependencyRoutes(
    routes: readonly DependencyOverlayRoute[],
  ): void {
    this.districtDependencyOverlay.replace(routes);
    if (this.prePrintOverlayVisibility !== undefined) {
      this.prePrintOverlayVisibility.districtDependencies =
        routes.length > 0;
    }
  }

  public selectBuilding(id: string, focus = false): boolean {
    const context = this.buildingContexts.get(id);
    if (!context) {
      return false;
    }
    this.ensureCityPresentation();
    if (
      this.isolatedDistrictId !== null &&
      this.isolatedDistrictId !== context.building.districtId
    ) {
      this.applyDistrictIsolation(context.building.districtId, false);
    }
    this.select(createSceneEntity("building", id));
    if (focus) {
      this.focusBuilding(id);
    }
    return true;
  }

  public selectDistrict(id: string, focus = false): boolean {
    const group = this.districtGroups.get(id);
    if (!group || !this.districtContexts.has(id)) {
      return false;
    }
    this.ensureCityPresentation();
    if (
      this.isolatedDistrictId !== null &&
      this.isolatedDistrictId !== id
    ) {
      this.applyDistrictIsolation(id, false);
    }
    this.select(createSceneEntity("district", id));
    if (focus) {
      this.frameDistrict(id, group, true);
    }
    return true;
  }

  public selectExternalNode(id: string, focus = false): boolean {
    const mesh = this.externalMeshes.get(id);
    if (!mesh) {
      return false;
    }
    this.ensureCityPresentation();
    this.select(createSceneEntity("external", id));
    if (focus) {
      this.frameObject(mesh, true);
    }
    return true;
  }

  public isolateDistrict(id: string, focus = true): boolean {
    if (!this.districtGroups.has(id)) {
      return false;
    }
    this.ensureCityPresentation();
    if (!this.applyDistrictIsolation(id, focus)) {
      return false;
    }
    this.emitState();
    return true;
  }

  private applyDistrictIsolation(id: string, focus: boolean): boolean {
    const selectedGroup = this.districtGroups.get(id);
    if (!selectedGroup) {
      return false;
    }
    this.hover(null);
    for (const [districtId, group] of this.districtGroups) {
      group.visible = districtId === id;
    }
    this.buildingLayer?.setIsolatedDistrict(id);
    this.isolatedDistrictId = id;
    const selection = this.selectedEntity;
    const hiddenSelection =
      selection?.kind === "district"
        ? selection.id !== id
        : selection?.kind === "building"
          ? this.buildingContexts.get(selection.id)?.building.districtId !== id
          : false;
    if (hiddenSelection) {
      this.select(null);
    }
    if (focus) {
      this.frameDistrict(id, selectedGroup, true);
    }
    return true;
  }

  public showWholeCity(): void {
    this.ensureCityPresentation();
    for (const group of this.districtGroups.values()) {
      group.visible = true;
    }
    this.buildingLayer?.setIsolatedDistrict(null);
    this.isolatedDistrictId = null;
    this.frameObject(this.city, true);
    this.emitState();
  }

  public assertBuildingCapability(buildingCount: number): void {
    assertViewerBuildingCapability(
      buildingCount,
      this.instancingSupported,
    );
  }

  public performanceDiagnostics(): ViewerPerformanceDiagnostics {
    this.controls.update();
    this.updateFog();
    this.renderer.render(this.scene, this.camera);
    let objectCount = 0;
    this.scene.traverse(() => {
      objectCount += 1;
    });
    return Object.freeze({
      buildingRenderMode: this.buildingLayer?.mode ?? null,
      buildingBatchCount: this.buildingLayer?.batchCount ?? 0,
      objectCount,
      renderCalls: this.renderer.info.render.calls,
      pickBenchmark:
        this.buildingLayer?.benchmarkPicks(50) ??
        Object.freeze({
          count: 0,
          p95Milliseconds: 0,
          maximumAabbTests: 0,
        }),
    });
  }

  private readonly render = (): void => {
    this.updateCameraTransition();
    this.updateEvolutionAnimation();
    this.controls.update();
    this.updateFog();
    this.renderer.render(this.scene, this.camera);
  };

  private updateFog(): void {
    this.fog.density = fogDensityForCameraDistance(
      this.camera.position.distanceTo(this.controls.target),
    );
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private clear(): void {
    this.clearEvolutionAnimation();
    this.hover(null);
    this.pointerPicker.cancel();
    this.sceneLabelOverlay.clear();
    this.dependencyOverlay.clear();
    this.districtDependencyOverlay.clear();
    this.isolatedDistrictId = null;
    this.cameraTransition = null;
    this.select(null);
    this.buildingContexts.clear();
    this.districtMeshes.clear();
    this.districtContexts.clear();
    this.externalMeshes.clear();
    this.externalNodes.clear();
    this.districtGroups.clear();
    this.clearPrintPlate();
    if (this.buildingLayer !== null) {
      this.city.remove(this.buildingLayer.object);
      this.buildingLayer.dispose();
      this.buildingLayer = null;
    }

    for (const child of [...this.city.children]) {
      this.city.remove(child);
      disposeObject(child);
    }
  }

  private updateEvolutionAnimation(): void {
    const animation = this.evolutionAnimation;
    if (!animation || !Number.isFinite(animation.durationMs)) return;
    const progress = Math.min(
      1,
      Math.max(
        0,
        (performance.now() - animation.startedAt) / animation.durationMs,
      ),
    );
    const eased = progress * progress * (3 - 2 * progress);
    this.buildingLayer?.setEvolutionProgress(
      animation.addedIds,
      animation.fromById,
      eased,
    );
    for (const child of animation.ghosts.children) {
      if (child instanceof THREE.Mesh) {
        const material = child.material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity = 0.48 * (1 - eased);
        }
        child.scale.y = Math.max(0.02, 1 - eased);
      }
    }
    if (progress === 1) this.clearEvolutionAnimation();
  }

  private clearEvolutionAnimation(): void {
    const animation = this.evolutionAnimation;
    this.evolutionAnimation = null;
    if (!animation) return;
    this.buildingLayer?.setEvolutionProgress(
      animation.addedIds,
      animation.fromById,
      1,
    );
    this.city.remove(animation.ghosts);
    disposeObject(animation.ghosts);
  }

  private clearPrintPlate(): void {
    for (const child of [...this.printPlate.children]) {
      this.printPlate.remove(child);
      disposeObject(child);
    }
  }

  private bounds(): THREE.Box3 {
    const bounds = new THREE.Box3().setFromObject(this.city);
    if (bounds.isEmpty()) {
      bounds.set(
        new THREE.Vector3(-5, 0, -5),
        new THREE.Vector3(5, 5, 5),
      );
    }
    return bounds;
  }

  private frame(): void {
    this.frameBounds(this.bounds(), false, true);
  }

  private frameObject(object: THREE.Object3D, animate: boolean): void {
    const bounds = new THREE.Box3().setFromObject(object);
    if (!bounds.isEmpty()) {
      this.frameBounds(bounds, animate);
    }
  }

  private frameDistrict(
    districtId: string,
    district: THREE.Object3D,
    animate: boolean,
  ): void {
    const bounds = focusedDistrictBounds(
      districtId,
      district,
      (id) => this.buildingLayer?.districtBounds(id),
      this.externalMeshes.values(),
    );
    if (!bounds.isEmpty()) {
      this.frameBounds(bounds, animate);
    }
  }

  private focusBuilding(id: string): void {
    const bounds = this.buildingLayer?.bounds(id);
    if (bounds) {
      this.frameBounds(bounds, true);
    }
  }

  private frameBounds(
    bounds: THREE.Box3,
    animate: boolean,
    setFullCityRange = false,
  ): void {
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const maximumDimension = Math.max(size.x, size.y, size.z, 1);
    const distance = cameraDistanceForBounds(
      size,
      this.camera.fov,
      this.camera.aspect,
    );
    const direction = this.camera.position
      .clone()
      .sub(this.controls.target);
    if (direction.lengthSq() < 1e-8) {
      direction.set(1, 0.78, -1);
    }
    direction.normalize();
    const position = center
      .clone()
      .addScaledVector(direction, distance);
    this.camera.near = Math.max(distance / 1_000, 0.01);
    const requiredFar = Math.max(
      distance * 20,
      maximumDimension * 20,
    );
    if (setFullCityRange) {
      this.fullCityMaxDistance = Math.max(distance * 5, 20);
      this.fullCityFar = requiredFar;
    }
    this.camera.far = Math.max(requiredFar, this.fullCityFar);
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = cameraMaximumDistanceForFrame(
      this.fullCityMaxDistance,
      distance,
    );
    if (
      !animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      this.cameraTransition = null;
      this.camera.position.copy(position);
      this.controls.target.copy(center);
      this.controls.update();
      this.updateFog();
      return;
    }
    this.cameraTransition = {
      startedAt: performance.now(),
      durationMs: 520,
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: position,
      toTarget: center,
    };
  }

  private preserveCameraForBounds(bounds: THREE.Box3): void {
    const size = bounds.getSize(new THREE.Vector3());
    const maximumDimension = Math.max(size.x, size.y, size.z, 1);
    const requiredDistance = cameraDistanceForBounds(
      size,
      this.camera.fov,
      this.camera.aspect,
    );
    const currentDistance = Math.max(
      this.camera.position.distanceTo(this.controls.target),
      1,
    );
    this.fullCityMaxDistance = Math.max(requiredDistance * 5, 20);
    this.fullCityFar = Math.max(
      requiredDistance * 20,
      maximumDimension * 20,
      currentDistance * 2,
    );
    this.camera.near = Math.max(currentDistance / 1_000, 0.01);
    this.camera.far = this.fullCityFar;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = cameraMaximumDistanceForFrame(
      this.fullCityMaxDistance,
      currentDistance,
    );
    this.controls.update();
    this.updateFog();
  }

  private updateCameraTransition(): void {
    const transition = this.cameraTransition;
    if (!transition) {
      return;
    }
    const progress = Math.min(
      1,
      Math.max(
        0,
        (performance.now() - transition.startedAt) /
          transition.durationMs,
      ),
    );
    const eased = progress * progress * (3 - 2 * progress);
    this.camera.position.lerpVectors(
      transition.fromPosition,
      transition.toPosition,
      eased,
    );
    this.controls.target.lerpVectors(
      transition.fromTarget,
      transition.toTarget,
      eased,
    );
    if (progress === 1) {
      this.cameraTransition = null;
    }
  }

  private replaceGrid(bounds: THREE.Box3, gridY: number): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      disposeObject(this.grid);
    }

    const layout = groundGridLayout({
      minX: bounds.min.x,
      maxX: bounds.max.x,
      minZ: bounds.min.z,
      maxZ: bounds.max.z,
    });
    this.grid = new THREE.GridHelper(
      layout.size,
      layout.divisions,
      "#14283c",
      "#14283c",
    );
    this.grid.position.set(layout.centerX, gridY, layout.centerZ);
    this.scene.add(this.grid);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!semanticPickingEnabled(this.presentationMode)) {
      this.pointerStart = null;
      return;
    }
    this.pointerStart = { x: event.clientX, y: event.clientY };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!semanticPickingEnabled(this.presentationMode)) {
      this.pointerPicker.cancel();
      this.hover(null);
      return;
    }
    this.pointerPicker.request({
      x: event.clientX,
      y: event.clientY,
    });
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!semanticPickingEnabled(this.presentationMode)) {
      this.pointerStart = null;
      return;
    }
    const start = this.pointerStart;
    this.pointerStart = null;
    if (
      !start ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
    ) {
      return;
    }
    this.pointerPicker.cancel();
    this.select(
      this.pick({
        x: event.clientX,
        y: event.clientY,
      }),
    );
  };

  private readonly onPointerLeave = (): void => {
    this.pointerStart = null;
    this.pointerPicker.cancel();
    this.hover(null);
  };

  private pick(pointerPosition: PointerPosition): SceneEntity | null {
    if (!semanticPickingEnabled(this.presentationMode)) {
      return null;
    }
    if (
      (this.buildingLayer?.size ?? 0) === 0 &&
      this.districtMeshes.size === 0 &&
      this.externalMeshes.size === 0
    ) {
      return null;
    }

    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((pointerPosition.x - bounds.left) / bounds.width) * 2 - 1,
      -((pointerPosition.y - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const sceneHit = this.raycaster.intersectObjects(
      [
        ...[...this.districtMeshes.values()].filter(
          (mesh) => mesh.parent?.visible !== false,
        ),
        ...this.externalMeshes.values(),
      ],
      false,
    )[0];
    const buildingHit = this.buildingLayer?.pick(
      {
        origin: this.raycaster.ray.origin,
        direction: this.raycaster.ray.direction,
      },
      this.isolatedDistrictId === null
        ? {}
        : { districtId: this.isolatedDistrictId },
    ).hit;
    if (
      buildingHit !== null &&
      buildingHit !== undefined &&
      (sceneHit === undefined || buildingHit.distance <= sceneHit.distance)
    ) {
      return createSceneEntity("building", buildingHit.id);
    }
    return decodeSceneEntityKey(
      sceneHit?.object.userData["sceneEntityKey"],
    );
  }

  private hover(entity: SceneEntity | null): void {
    if (sameSceneEntity(entity, this.hoveredEntity)) {
      return;
    }
    const previous = this.hoveredEntity;
    this.hoveredEntity = entity;
    this.updateHighlight(previous);
    this.updateHighlight(entity);
    this.refreshSceneLabels();
    this.renderer.domElement.style.cursor = entity ? "pointer" : "grab";
  }

  private ensureCityPresentation(): void {
    if (this.presentationMode === "city") {
      return;
    }
    this.requestCityPresentation();
    this.showCityLayout(false);
  }

  private select(entity: SceneEntity | null): void {
    if (entity !== null) {
      viewerWorkspace.show("details", { intent: "passive" });
    }
    if (sameSceneEntity(entity, this.selectedEntity)) {
      return;
    }
    const previous = this.selectedEntity;
    this.selectedEntity = entity;
    this.updateHighlight(previous);
    this.updateHighlight(entity);
    this.refreshSceneLabels();
    const building =
      entity?.kind === "building"
        ? this.buildingContexts.get(entity.id) ?? null
        : null;
    const district =
      entity?.kind === "district"
        ? this.districtContexts.get(entity.id) ?? null
        : null;
    const external =
      entity?.kind === "external"
        ? this.externalNodes.get(entity.id) ?? null
        : null;
    if (building) {
      showInspector(building);
    } else if (district) {
      showDistrictInspector(district);
    } else if (external) {
      showExternalInspector(external);
    } else {
      showInspector(null);
    }
    this.emitState();
  }

  private emitState(): void {
    this.onStateChange({
      selectedEntity: this.selectedEntity,
      isolatedDistrictId: this.isolatedDistrictId,
    });
  }

  private updateHighlight(entity: SceneEntity | null): void {
    if (!entity) {
      return;
    }
    if (entity.kind === "building") {
      this.buildingLayer?.setHighlight(
        "selected",
        this.selectedEntity?.kind === "building"
          ? this.selectedEntity.id
          : null,
      );
      this.buildingLayer?.setHighlight(
        "hovered",
        this.hoveredEntity?.kind === "building"
          ? this.hoveredEntity.id
          : null,
      );
      return;
    }
    const mesh = this.entityMesh(entity);
    if (!mesh) {
      return;
    }
    const selected = sameSceneEntity(entity, this.selectedEntity);
    const hovered = sameSceneEntity(entity, this.hoveredEntity);
    mesh.material.emissive.copy(mesh.material.color);
    mesh.material.emissiveIntensity =
      selected && hovered ? 0.62 : selected ? 0.45 : hovered ? 0.26 : 0;
  }

  private entityMesh(
    entity: SceneEntity,
  ):
    | THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
    | undefined {
    switch (entity.kind) {
      case "building":
        return undefined;
      case "district":
        return this.districtMeshes.get(entity.id);
      case "external":
        return this.externalMeshes.get(entity.id);
    }
  }

  private refreshSceneLabels(): void {
    const labels = {
      selected: this.sceneLabel(this.selectedEntity),
      hovered: this.sceneLabel(this.hoveredEntity),
    };
    this.sceneLabelOverlay.replace(labels);
    const entityName = sceneLabelAccessibleName(labels);
    this.renderer.domElement.setAttribute(
      "aria-label",
      `${entityName}${entityName ? " " : ""}Visualization mode: ${this.visualizationModeLabel}.`,
    );
    this.renderer.domElement.title =
      labels.hovered?.text ?? labels.selected?.text ?? "";
  }

  private sceneLabel(entity: SceneEntity | null): SceneLabel | null {
    if (!entity) {
      return null;
    }
    switch (entity.kind) {
      case "building": {
        const context = this.buildingContexts.get(entity.id);
        if (!context) {
          return null;
        }
        const { building } = context;
        return {
          id: encodeSceneEntityKey(entity),
          text: building.name,
          position: {
            x: building.position.x,
            y: building.position.y + building.size.y * 0.5 + 1.35,
            z: building.position.z,
          },
          worldHeight: 1.2,
        };
      }
      case "district": {
        const context = this.districtContexts.get(entity.id);
        if (!context) {
          return null;
        }
        const { district } = context;
        let skylineY = district.position.y + district.size.y * 0.5;
        for (const buildingContext of this.buildingContexts.values()) {
          const building = buildingContext.building;
          if (building.districtId === district.id) {
            skylineY = Math.max(
              skylineY,
              building.position.y + building.size.y * 0.5,
            );
          }
        }
        return {
          id: encodeSceneEntityKey(entity),
          text: district.name,
          position: {
            x: district.position.x,
            y: skylineY + 1.55,
            z: district.position.z,
          },
          worldHeight: 1.6,
        };
      }
      case "external": {
        const node = this.externalNodes.get(entity.id);
        if (!node) {
          return null;
        }
        return {
          id: encodeSceneEntityKey(entity),
          text:
            node.kind === "external"
              ? node.normalizedTarget ?? node.label
              : node.label,
          position: {
            x: node.position.x,
            y: node.position.y + node.size.y * 0.5 + 1.35,
            z: node.position.z,
          },
          worldHeight: 1.4,
        };
      }
    }
  }
}

let activeModel: CityModel = DEMO_MODEL;
let activeModelSource: ModelSource = { label: "Built-in demo" };
let sourceRequest: AbortController | undefined;
let loadedBuildingSource:
  | { readonly buildingId: string; readonly source: BuildingSource }
  | undefined;
let visualizationMode: ViewerVisualizationMode = "semantic";
let previewPrinterProfile: PrinterProfile | undefined;
let evolutionWorker = new EvolutionTimelineWorkerClient();
let evolutionLoadController: AbortController | undefined;
let evolutionGeneration = 0;
const evolutionSeekGate = new EvolutionSeekGate();
let evolutionPlaybackTimer: number | undefined;
let evolutionTransitionTimer: number | undefined;
let activeEvolutionFrames: readonly EvolutionFrameSummary[] = [];
let activeEvolutionHistories = new Map<string, EvolutionBuildingHistory>();
let activeEvolutionAnalysis: EvolutionVisualizationData | undefined;
let activeEvolutionTransition: EvolutionTransition | undefined;
let activeEvolutionIndex = 0;
let evolutionPlaying = false;
let evolutionLoading = false;
let activeBuildingsById = new Map(
  DEMO_MODEL.buildings.map((building) => [building.id, building]),
);
let activeDistrictsById = new Map(
  DEMO_MODEL.districts.map((district) => [district.id, district]),
);
let dependencyExplorerIndex = createDependencyExplorerIndex(DEMO_MODEL);
let dependencyRouteState: DependencyRouteToggleState =
  resetDependencyRouteState();
let dependencyRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
let districtDependencyExplorerIndex =
  createDistrictDependencyExplorerIndex(DEMO_MODEL);
let districtDependencyFilters: DistrictDependencyFilters =
  resetDistrictDependencyFilters();
let districtDependencyRoutesVisible = false;
let districtRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
let selectedDistrictDependencyBundleId: string | null = null;
let visibleDistrictDependencyBundlesById = new Map<
  string,
  DistrictDependencyBundle
>();
let districtDependencyFootprintsById =
  createDistrictDependencyFootprints(DEMO_MODEL);
let repositoryExplorerIndex = createRepositoryExplorerIndex(DEMO_MODEL);
let searchResultLimit = DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT;
let executableUnitVisibleLimit =
  INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT;
let explorerState = resetExplorerState();
let activeExternalLayout = createExternalDependencyLayout(DEMO_MODEL);
let activeExternalNodes: readonly ExternalSceneNode[] =
  activeExternalLayout.nodes;
let requestCityPresentation = (): void => {};
const cityScene = new CityScene(
  sceneHost,
  synchronizeExplorerState,
  () => requestCityPresentation(),
);
const printPlateToolbar = installPrintPlateToolbar(
  {
    root: element<HTMLElement>("print-plate-toolbar"),
    cityModeButton: element<HTMLButtonElement>("print-preview-city"),
    platesModeButton: element<HTMLButtonElement>("print-preview-plates"),
    plateSelect: element<HTMLSelectElement>("print-preview-plate"),
    status: element<HTMLElement>("print-preview-status"),
  },
  {
    onStateChange: (state) => {
      if (state.mode === "plates" && state.projection !== undefined) {
        cityScene.showPrintPlate(state.projection);
      } else {
        cityScene.showCityLayout();
      }
    },
  },
);
requestCityPresentation = (): void => printPlateToolbar.show("city");
const viewerLoadGateway = new ViewerLoadGateway();
const sourceApi = new ViewerImportApiClient(
  new URL(window.location.href),
);
const automaticModelLoadGate = new AutomaticModelLoadGate();
const logoLoadGate = new AutomaticModelLoadGate();
let loadedModelLogo: LoadedViewerImage | undefined;
const importParameters = new URL(window.location.href).searchParams;
const projectImportDialog = installProjectImportDialog({
  loadGateway: viewerLoadGateway,
  autoResume:
    importParameters.get("fixture") !== LARGE_CITY_FIXTURE_NAME &&
    importParameters.get("model") === null,
  onModelReady: (model, source) => {
    automaticModelLoadGate.invalidate();
    activateImportedModel(model, {
      label: source.label,
      assetRoot: source.assetRoot,
      jobId: source.jobId,
      sourceAvailability: source.sourceAvailability,
      ...(source.evolution === undefined
        ? {}
        : { evolution: source.evolution }),
    });
  },
  onSignedOut: () => {
    automaticModelLoadGate.invalidate();
    activateImportedModel(DEMO_MODEL, { label: "Built-in demo" });
  },
  onResultRemoved: (jobId) => {
    if (activeModelSource.jobId === jobId) scrubBuildingSource();
  },
});
const printExportDialog = installPrintExportDialog({
  getModel: () => activeModel,
  loadGateway: viewerLoadGateway,
  onPrintLayoutPlan: (plan) => {
    printPlateToolbar.setPlan(plan);
    if (plan !== undefined) {
      printPlateToolbar.show("plates");
    }
  },
  onProfilePreviewChange: (profile) => {
    previewPrinterProfile = profile;
    if (visualizationMode === "print") applyVisualization();
  },
});
const metricMappingPanel = installMetricMappingPanel(
  element<HTMLElement>("metric-mapping-panel"),
  {
    onModelChange: (model) => {
      applyModel(model, activeModelSource);
    },
    onPreviewStateChange: (active) => {
      printExportDialog.setEnabled(!active);
      printExportOpenButton.disabled = active;
      printExportOpenButton.title = active
        ? "Apply or cancel the metric mapping preview before exporting."
        : "";
      metricPreviewBanner.hidden = !active;
    },
  },
);

visualizationModeSelect.addEventListener("change", () => {
  const selected = visualizationModeSelect.value;
  if (
    selected !== "semantic" &&
    selected !== "complexity" &&
    selected !== "age" &&
    selected !== "churn" &&
    selected !== "print"
  ) {
    visualizationModeSelect.value = visualizationMode;
    return;
  }
  visualizationMode = selected;
  applyVisualization();
});

evolutionFirst.addEventListener("click", () => {
  stopEvolutionPlayback();
  void seekEvolution(0);
});
evolutionPrevious.addEventListener("click", () => {
  stopEvolutionPlayback();
  void seekEvolution(Math.max(0, activeEvolutionIndex - 1));
});
evolutionPlay.addEventListener("click", () => {
  if (evolutionPlaying) {
    stopEvolutionPlayback();
  } else {
    startEvolutionPlayback();
  }
});
evolutionNext.addEventListener("click", () => {
  stopEvolutionPlayback();
  void seekEvolution(
    Math.min(activeEvolutionFrames.length - 1, activeEvolutionIndex + 1),
  );
});
evolutionLast.addEventListener("click", () => {
  stopEvolutionPlayback();
  void seekEvolution(activeEvolutionFrames.length - 1);
});
evolutionRange.addEventListener("input", () => {
  stopEvolutionPlayback();
  void seekEvolution(Number(evolutionRange.value));
});

fileOpenButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) {
    return;
  }

  automaticModelLoadGate.invalidate();
  setStatus(`Reading ${file.name}…`);
  try {
    const parsed = await viewerLoadGateway.loadLocalJson(file, "model");
    activateImportedModel(validateCityModel(parsed), { label: file.name });
  } catch (error) {
    showError(messageOf(error));
  }
});

demoButton.addEventListener("click", () => {
  automaticModelLoadGate.invalidate();
  activateImportedModel(DEMO_MODEL, { label: "Built-in demo" });
});

clearSelectionButton.addEventListener("click", () => {
  clearBuildingSelection();
});

dependencyIncomingToggle.addEventListener("click", () => {
  toggleDependencyDirection("incoming");
});
dependencyOutgoingToggle.addEventListener("click", () => {
  toggleDependencyDirection("outgoing");
});
dependencyShowMore.addEventListener("click", () => {
  dependencyRouteVisibleLimit = nextBoundedResultLimit(
    dependencyRouteVisibleLimit,
    DEPENDENCY_ROUTES_PER_DIRECTION,
    INITIAL_ROUTE_RESULT_LIMIT,
  );
  renderDependencyExplorer();
});
districtRoutesToggle.addEventListener("click", () => {
  if (!districtDependencyRoutesVisible) {
    districtRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
  }
  districtDependencyRoutesVisible = !districtDependencyRoutesVisible;
  renderDistrictDependencyExplorer();
});
districtRoutesShowMore.addEventListener("click", () => {
  districtRouteVisibleLimit = nextBoundedResultLimit(
    districtRouteVisibleLimit,
    DISTRICT_DEPENDENCY_BUNDLES_LIMIT,
    INITIAL_ROUTE_RESULT_LIMIT,
  );
  renderDistrictDependencyExplorer();
});
districtRouteTypeScriptFilter.addEventListener("click", () => {
  toggleDistrictDependencyFilter("typescript-import");
});
districtRouteProjectFilter.addEventListener("click", () => {
  toggleDistrictDependencyFilter("project-reference");
});
districtRoutePackageFilter.addEventListener("click", () => {
  toggleDistrictDependencyFilter("package-reference");
});
districtRoutesList.addEventListener("keydown", (event) => {
  navigateDistrictDependencyRoutes(event);
});
externalList.addEventListener("keydown", (event) => {
  navigateExternalNodes(event);
});
districtRouteIsolateConsumer.addEventListener("click", () => {
  isolateDistrictDependencyEndpoint("consumer", true);
});
districtRouteIsolateProvider.addEventListener("click", () => {
  isolateDistrictDependencyEndpoint("provider", true);
});

buildingSearch.addEventListener("input", () => {
  searchResultLimit = DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT;
  renderBuildingSearch();
});
searchShowMore.addEventListener("click", () => {
  searchResultLimit = nextBoundedResultLimit(
    searchResultLimit,
    MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT,
    DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT,
  );
  renderBuildingSearch();
});
inspectorFields.unitsShowMore.addEventListener("click", () => {
  const selectedBuildingId =
    selectedExplorerBuildingId(explorerState);
  const building = selectedBuildingId
    ? activeBuildingsById.get(selectedBuildingId)
    : undefined;
  if (!building) return;
  executableUnitVisibleLimit = nextBoundedResultLimit(
    executableUnitVisibleLimit,
    MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
    INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  );
  renderExecutableUnits(building);
});
buildingSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && buildingSearch.value !== "") {
    event.preventDefault();
    event.stopPropagation();
    buildingSearch.value = "";
    searchResultLimit = DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT;
    renderBuildingSearch();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const buttons = searchResultButtons();
    const button =
      event.key === "ArrowDown" ? buttons[0] : buttons.at(-1);
    if (button) {
      event.preventDefault();
      button.focus();
    }
  }
});

searchResults.addEventListener("keydown", (event) => {
  const buttons = searchResultButtons();
  if (buttons.length === 0) {
    return;
  }
  if (
    (event.key === "Enter" || event.key === " ") &&
    document.activeElement instanceof HTMLButtonElement &&
    document.activeElement.classList.contains("search-result-button")
  ) {
    event.preventDefault();
    document.activeElement.click();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    buildingSearch.focus();
    return;
  }
  const current = buttons.indexOf(
    document.activeElement as HTMLButtonElement,
  );
  let next: HTMLButtonElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      next =
        current < 0
          ? buttons[0]
          : buttons[(current + 1) % buttons.length];
      break;
    case "ArrowUp":
      next =
        current < 0
          ? buttons.at(-1)
          : buttons[(current - 1 + buttons.length) % buttons.length];
      break;
    case "Home":
      next = buttons[0];
      break;
    case "End":
      next = buttons.at(-1);
      break;
  }
  if (next) {
    event.preventDefault();
    next.focus();
  }
});

isolateDistrictButton.addEventListener("click", () => {
  const next = isolateExplorerDistrict(explorerState, activeModel);
  if (
    next !== explorerState &&
    next.isolatedDistrictId !== null
  ) {
    cityScene.isolateDistrict(next.isolatedDistrictId);
  }
});

showWholeCityButton.addEventListener("click", () => {
  if (showAllDistricts(explorerState) !== explorerState) {
    cityScene.showWholeCity();
  }
});
viewerScopeReset.addEventListener("click", () => {
  if (explorerState.isolatedDistrictId !== null) {
    cityScene.showWholeCity();
  }
});

dismissErrorButton.addEventListener("click", hideError);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearBuildingSelection();
    hideError();
  }
});
window.addEventListener("beforeunload", () => {
  resetEvolutionTimeline(false);
  viewerWorkspace.dispose();
  printPlateToolbar.dispose();
  projectImportDialog.dispose();
  metricMappingPanel.dispose();
  logoLoadGate.invalidate();
  loadedModelLogo?.dispose();
  loadedModelLogo = undefined;
});

let performanceDiagnosticsGeneration = 0;
const initialParameters = new URL(window.location.href).searchParams;
if (initialParameters.get("fixture") === LARGE_CITY_FIXTURE_NAME) {
  try {
    activateImportedModel(createLargeCityFixture(), {
      label: "Built-in 25k performance fixture",
    });
  } catch (error) {
    activateImportedModel(DEMO_MODEL, { label: "Built-in demo" });
    showError(messageOf(error));
  }
} else {
  activateImportedModel(DEMO_MODEL, { label: "Built-in demo" });
  void loadModelFromQuery();
}

async function loadModelFromQuery(): Promise<void> {
  const modelParameter = new URL(window.location.href).searchParams.get(
    "model",
  );
  if (!modelParameter) {
    return;
  }

  const attempt = automaticModelLoadGate.begin();
  try {
    const modelUrl = new URL(modelParameter, window.location.href);
    setStatus(`Fetching ${remoteViewerDisplayUrl(modelUrl)}…`);
    const loaded = await viewerLoadGateway.loadRemoteModel(
      modelUrl,
      attempt.signal,
    );
    if (!attempt.isCurrent()) {
      return;
    }
    activateImportedModel(validateCityModel(loaded.model), {
      label: remoteViewerDisplayUrl(loaded.responseUrl),
      assetRoot: assetRootFromResponseUrl(loaded.responseUrl.href),
    });
  } catch (error) {
    if (attempt.isCurrent()) {
      showError(messageOf(error));
    }
  } finally {
    attempt.finish();
  }
}

function activateImportedModel(
  model: CityModel,
  source: ModelSource,
): void {
  resetEvolutionTimeline();
  activeModelSource = source;
  metricMappingPanel.setProject(model);
  applyModel(model, source);
  void startEvolutionTimeline(source);
}

function applyModel(
  model: CityModel,
  source: ModelSource,
  options: {
    readonly preserveView?: boolean;
    readonly preserveSelection?: boolean;
  } = {},
): void {
  const preservedSelection = options.preserveSelection
    ? explorerState.selectedEntity
    : null;
  const preservedIsolation = options.preserveSelection
    ? explorerState.isolatedDistrictId
    : null;
  const preservedDependencyRouteState = dependencyRouteState;
  const preservedDependencyRouteVisibleLimit = dependencyRouteVisibleLimit;
  printExportDialog.invalidate();
  printPlateToolbar.setPlan(undefined);
  const buildingsById = new Map(
    model.buildings.map((building) => [building.id, building]),
  );
  const districtsById = new Map(
    model.districts.map((district) => [district.id, district]),
  );
  const nextDependencyExplorerIndex =
    createDependencyExplorerIndex(model);
  const nextDistrictDependencyExplorerIndex =
    createDistrictDependencyExplorerIndex(model);
  const nextDistrictDependencyFootprints =
    createDistrictDependencyFootprints(model);
  const nextRepositoryExplorerIndex =
    createRepositoryExplorerIndex(model);
  const nextExternalLayout = createExternalDependencyLayout(model);
  cityScene.assertBuildingCapability(model.buildings.length);

  activeModel = model;
  activeModelSource = source;
  scrubBuildingSource();
  activeBuildingsById = buildingsById;
  activeDistrictsById = districtsById;
  dependencyExplorerIndex = nextDependencyExplorerIndex;
  dependencyRouteState = resetDependencyRouteState();
  dependencyRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
  districtDependencyExplorerIndex =
    nextDistrictDependencyExplorerIndex;
  districtDependencyFilters = resetDistrictDependencyFilters();
  districtDependencyRoutesVisible = false;
  districtRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
  selectedDistrictDependencyBundleId = null;
  visibleDistrictDependencyBundlesById = new Map();
  districtDependencyFootprintsById =
    nextDistrictDependencyFootprints;
  repositoryExplorerIndex = nextRepositoryExplorerIndex;
  explorerState = resetExplorerState();
  activeExternalLayout = nextExternalLayout;
  activeExternalNodes = nextExternalLayout.nodes;
  buildingSearch.value = "";
  searchResultLimit = DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT;
  synchronizeExplorerState(explorerState);
  renderBuildingSearch();
  cityScene.load(
    model,
    nextExternalLayout.base,
    nextExternalLayout.nodes,
    !options.preserveView,
  );
  renderExternalNodeList();
  const title =
    model.identity?.title ??
    (model.repositories.length === 1
      ? model.repositories[0]?.name
      : undefined) ??
    source.label;
  modelNameElement.textContent = title;
  modelNameElement.title = `Source: ${source.label}`;
  void applyLogo(model, source);
  const version = model.identity?.version
    ? `${model.identity.version} · `
    : "";
  setStatus(
    `${version}${model.districts.length.toLocaleString()} districts · ${model.buildings.length.toLocaleString()} buildings`,
  );
  applyVisualization();
  if (
    preservedIsolation !== null &&
    activeDistrictsById.has(preservedIsolation)
  ) {
    cityScene.isolateDistrict(preservedIsolation, false);
  }
  if (options.preserveSelection) {
    dependencyRouteState = preservedDependencyRouteState;
    dependencyRouteVisibleLimit = preservedDependencyRouteVisibleLimit;
  }
  if (preservedSelection?.kind === "building") {
    cityScene.selectBuilding(preservedSelection.id);
  } else if (preservedSelection?.kind === "district") {
    cityScene.selectDistrict(preservedSelection.id);
  } else if (preservedSelection?.kind === "external") {
    cityScene.selectExternalNode(preservedSelection.id);
  }
  hideError();
  schedulePerformanceDiagnostics();
}

function resetEvolutionTimeline(recreateWorker = true): void {
  evolutionGeneration += 1;
  evolutionLoadController?.abort();
  evolutionLoadController = undefined;
  stopEvolutionPlayback();
  if (evolutionTransitionTimer !== undefined) {
    window.clearTimeout(evolutionTransitionTimer);
    evolutionTransitionTimer = undefined;
  }
  evolutionWorker.dispose();
  if (recreateWorker) evolutionWorker = new EvolutionTimelineWorkerClient();
  activeEvolutionFrames = [];
  activeEvolutionHistories = new Map();
  activeEvolutionAnalysis = undefined;
  activeEvolutionTransition = undefined;
  activeEvolutionIndex = 0;
  evolutionLoading = false;
  evolutionTimeline.hidden = true;
  evolutionRange.max = "0";
  evolutionRange.value = "0";
  if (
    visualizationMode === "age" ||
    visualizationMode === "churn"
  ) {
    applyVisualization();
  }
}

async function startEvolutionTimeline(source: ModelSource): Promise<void> {
  const artifact = source.evolution;
  if (artifact === undefined || source.jobId === undefined) return;
  const generation = evolutionGeneration;
  const controller = new AbortController();
  evolutionLoadController = controller;
  evolutionTimeline.hidden = false;
  evolutionLoading = true;
  evolutionCommit.textContent = "Loading repository history";
  evolutionStatus.textContent =
    "Verifying and preparing deterministic timeline frames\u2026";
  renderEvolutionTimeline();
  try {
    const bytes = await sourceApi.evolutionArtifact(
      source.jobId,
      artifact,
      controller.signal,
    );
    if (generation !== evolutionGeneration) return;
    const loaded = await evolutionWorker.load(bytes, artifact);
    if (generation !== evolutionGeneration) return;
    activeEvolutionFrames = loaded.frames;
    activeEvolutionHistories = new Map(
      loaded.histories.map((history) => [history.id, history]),
    );
    activeEvolutionAnalysis = evolutionVisualizationData(loaded.analysis);
    activeEvolutionIndex = 0;
    evolutionRange.max = String(Math.max(0, loaded.frames.length - 1));
    evolutionLoading = false;
    renderEvolutionTimeline();
    if (loaded.frames.length > 1) {
      await seekEvolution(loaded.frames.length - 1, true);
    } else {
      applyVisualization();
    }
  } catch (error) {
    if (
      generation !== evolutionGeneration ||
      controller.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      return;
    }
    evolutionLoading = false;
    evolutionCommit.textContent = "Repository history unavailable";
    evolutionStatus.textContent =
      error instanceof Error ? error.message : "Evolution could not be loaded.";
    renderEvolutionTimeline();
  } finally {
    if (evolutionLoadController === controller) {
      evolutionLoadController = undefined;
    }
  }
}

function evolutionVisualizationData(
  analysis: {
    readonly ageByBuildingId: readonly (readonly [string, number])[];
    readonly churnByBuildingId: readonly (readonly [string, number])[];
  },
): EvolutionVisualizationData {
  return {
    ageByBuildingId: new Map(analysis.ageByBuildingId),
    churnByBuildingId: new Map(analysis.churnByBuildingId),
  };
}

async function seekEvolution(
  targetIndex: number,
  initial = false,
): Promise<boolean> {
  if (
    activeEvolutionFrames.length === 0 ||
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= activeEvolutionFrames.length
  ) {
    return false;
  }
  if (targetIndex === activeEvolutionIndex && !initial) {
    renderEvolutionTimeline();
    return true;
  }
  const generation = evolutionGeneration;
  const seekGeneration = evolutionSeekGate.begin();
  const fromIndex = activeEvolutionIndex;
  const selected = explorerState.selectedEntity;
  const deletedBuilding =
    selected?.kind === "building"
      ? activeBuildingsById.get(selected.id)
      : undefined;
  evolutionRange.value = String(targetIndex);
  evolutionStatus.textContent = "Seeking\u2026";
  renderEvolutionTimeline();
  try {
    const result = await evolutionWorker.seek(fromIndex, targetIndex);
    if (
      generation !== evolutionGeneration ||
      !evolutionSeekGate.isCurrent(seekGeneration)
    ) {
      return false;
    }
    activeEvolutionIndex = targetIndex;
    activeEvolutionAnalysis = evolutionVisualizationData(result.analysis);
    activeEvolutionTransition = initial ? undefined : result.transition;
    applyModel(result.model, activeModelSource, {
      preserveView: true,
      preserveSelection: true,
    });
    if (!initial) {
      if (evolutionTransitionTimer !== undefined) {
        window.clearTimeout(evolutionTransitionTimer);
      }
      cityScene.showEvolutionTransition(
        result.transition,
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
      evolutionTransitionTimer = window.setTimeout(() => {
        if (
          generation !== evolutionGeneration ||
          targetIndex !== activeEvolutionIndex
        ) {
          return;
        }
        activeEvolutionTransition = undefined;
        evolutionTransitionTimer = undefined;
        cityScene.finishEvolutionTransition();
        applyVisualization();
      }, 1_200);
    }
    if (
      selected?.kind === "building" &&
      !activeBuildingsById.has(selected.id) &&
      deletedBuilding !== undefined
    ) {
      showDeletedEvolutionBuilding(deletedBuilding);
    }
    evolutionSeekGate.settle(seekGeneration);
    renderEvolutionTimeline();
    return true;
  } catch (error) {
    if (
      generation !== evolutionGeneration ||
      !evolutionSeekGate.isCurrent(seekGeneration)
    ) {
      return false;
    }
    evolutionSeekGate.settle(seekGeneration);
    if (error instanceof DOMException && error.name === "AbortError") {
      renderEvolutionTimeline();
      return false;
    }
    evolutionStatus.textContent =
      error instanceof Error ? error.message : "The frame could not be shown.";
    renderEvolutionTimeline();
    return false;
  }
}

function renderEvolutionTimeline(): void {
  const frame = activeEvolutionFrames[activeEvolutionIndex];
  const lastIndex = Math.max(0, activeEvolutionFrames.length - 1);
  const busy = evolutionLoading || evolutionSeekGate.busy;
  evolutionRange.value = String(activeEvolutionIndex);
  evolutionFirst.disabled = busy || activeEvolutionIndex === 0;
  evolutionPrevious.disabled = busy || activeEvolutionIndex === 0;
  evolutionNext.disabled =
    busy || activeEvolutionIndex >= lastIndex;
  evolutionLast.disabled =
    busy || activeEvolutionIndex >= lastIndex;
  evolutionRange.disabled = lastIndex === 0;
  evolutionPlay.disabled = lastIndex === 0;
  evolutionPlay.setAttribute("aria-pressed", String(evolutionPlaying));
  evolutionPlay.textContent = evolutionPlaying ? "\u23f8" : "\u25b6";
  evolutionPlay.setAttribute(
    "aria-label",
    evolutionPlaying
      ? "Pause repository evolution"
      : "Play repository evolution",
  );
  if (!frame) return;
  evolutionCommit.textContent =
    `${activeEvolutionIndex + 1}/${activeEvolutionFrames.length} \u00b7 ` +
    frame.sha.slice(0, 10);
  const transition = activeEvolutionTransition;
  const changeText =
    transition === undefined
      ? ""
      : [
          `${transition.addedBuildingIds.length} added`,
          `${transition.removedBuildings.length} removed`,
          `${transition.renamedBuildingIds.length} renamed`,
          `${transition.resizedBuildingIds.length} resized`,
        ].join(" \u00b7 ");
  evolutionStatus.textContent =
    `${new Date(frame.committedAt).toLocaleString()}${changeText ? ` \u00b7 ${changeText}` : ""}`;
}

function startEvolutionPlayback(): void {
  if (
    activeEvolutionFrames.length < 2 ||
    evolutionLoading ||
    evolutionSeekGate.busy
  ) return;
  evolutionPlaying = true;
  evolutionPlay.setAttribute("aria-pressed", "true");
  renderEvolutionTimeline();
  void advanceEvolutionPlayback();
}

async function advanceEvolutionPlayback(): Promise<void> {
  if (!evolutionPlaying) return;
  if (activeEvolutionIndex >= activeEvolutionFrames.length - 1) {
    const reset = await seekEvolution(0);
    if (!reset || !evolutionPlaying) return;
  } else {
    const advanced = await seekEvolution(activeEvolutionIndex + 1);
    if (!advanced || !evolutionPlaying) return;
  }
  const delay = Number(evolutionSpeed.value);
  evolutionPlaybackTimer = window.setTimeout(
    () => void advanceEvolutionPlayback(),
    Number.isFinite(delay) ? delay : 1_000,
  );
}

function stopEvolutionPlayback(): void {
  evolutionPlaying = false;
  const cancelledSeek = evolutionSeekGate.cancel();
  evolutionWorker.cancel();
  if (evolutionPlaybackTimer !== undefined) {
    window.clearTimeout(evolutionPlaybackTimer);
    evolutionPlaybackTimer = undefined;
  }
  evolutionPlay?.setAttribute("aria-pressed", "false");
  if (evolutionPlay) evolutionPlay.textContent = "\u25b6";
  if (cancelledSeek) renderEvolutionTimeline();
}

function showDeletedEvolutionBuilding(building: CityBuilding): void {
  scrubBuildingSource();
  inspectorEmpty.hidden = true;
  inspectorContent.hidden = false;
  districtInspectorContent.hidden = true;
  externalInspectorContent.hidden = true;
  clearSelectionButton.hidden = false;
  selectionKind.textContent = "Removed building";
  selectionName.textContent = building.name;
  inspectorFields.name.textContent = building.name;
  inspectorFields.repository.textContent = "Removed in this frame";
  inspectorFields.module.textContent = "Historical selection";
  inspectorFields.path.textContent = building.path;
  inspectorFields.language.textContent = languageLabel(building.language);
  inspectorFields.sloc.textContent = building.metrics.sloc.toLocaleString();
  inspectorFields.load.textContent =
    building.metrics.decisionLoad.toLocaleString();
  inspectorFields.cc.textContent =
    building.metrics.maximumComplexity.toLocaleString();
  inspectorFields.metricMethod.textContent =
    building.metricMethod ?? "Not recorded";
  inspectorFields.metricExplanation.textContent =
    "The selected lineage no longer exists at this commit. Its last known facts remain visible.";
  inspectorFields.unitsDetails.hidden = true;
  inspectorFields.sourceDetails.hidden = true;
  renderBuildingEvolutionHistory(building.id);
  selectionStatus.textContent =
    `Selected lineage ${building.name} was removed by this commit.`;
}

function schedulePerformanceDiagnostics(): void {
  const parameters = new URL(window.location.href).searchParams;
  if (parameters.get("performance") !== "1") {
    delete window.__CODE_CITY_PERFORMANCE__;
    delete document.documentElement.dataset["viewerPerformance"];
    return;
  }
  const generation = ++performanceDiagnosticsGeneration;
  window.setTimeout(() => {
    if (generation !== performanceDiagnosticsGeneration) return;
    const diagnostics = cityScene.performanceDiagnostics();
    const snapshot = Object.freeze({
      ready: true as const,
      firstInteractiveMilliseconds: performance.now(),
      ...diagnostics,
    });
    window.__CODE_CITY_PERFORMANCE__ = snapshot;
    document.documentElement.dataset["viewerPerformance"] =
      JSON.stringify(snapshot);
  }, 0);
}

function createExternalDependencyLayout(
  model: CityModel,
): ExternalDependencyLayout {
  return layoutExternalDependencies(
    selectExternalDependencies(model.dependencies),
    cityBaseForModel(model),
  );
}

function renderExternalNodeList(): void {
  externalList.replaceChildren();
  externalZone.hidden = activeExternalNodes.length === 0;
  const selectedExternalNodeId =
    selectedExplorerExternalId(explorerState);
  for (const node of activeExternalNodes) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset["externalNodeId"] = node.id;
    button.title =
      node.kind === "external"
        ? node.normalizedTarget ?? node.label
        : `${node.label}: ${node.targetCount.toLocaleString()} targets`;
    button.setAttribute(
      "aria-label",
      `${button.title}, ${referenceCountLabel(node.weight)}`,
    );
    if (node.id === selectedExternalNodeId) {
      button.setAttribute("aria-current", "true");
    }
    button.addEventListener("click", () => {
      viewerWorkspace.show("details", {
        intent: "explicit",
        focusTab: true,
      });
      cityScene.selectExternalNode(node.id);
    });

    const label = document.createElement("span");
    label.textContent = node.label;
    const weight = document.createElement("span");
    weight.textContent = node.weight.toLocaleString();
    button.append(label, weight);
    item.append(button);
    externalList.append(item);
  }
}

function navigateExternalNodes(event: KeyboardEvent): void {
  const buttons = [
    ...externalList.querySelectorAll<HTMLButtonElement>("button"),
  ];
  if (buttons.length === 0) {
    return;
  }
  const current = buttons.indexOf(
    document.activeElement as HTMLButtonElement,
  );
  let next: HTMLButtonElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      next =
        current < 0
          ? buttons[0]
          : buttons[(current + 1) % buttons.length];
      break;
    case "ArrowUp":
      next =
        current < 0
          ? buttons.at(-1)
          : buttons[(current - 1 + buttons.length) % buttons.length];
      break;
    case "Home":
      next = buttons[0];
      break;
    case "End":
      next = buttons.at(-1);
      break;
  }
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

function renderBuildingSearch(): void {
  searchResults.replaceChildren();
  searchShowMore.hidden = true;
  findPanel.classList.remove("has-results");
  const entityCount =
    activeModel.buildings.length + activeModel.districts.length;
  buildingSearch.disabled = entityCount === 0;
  if (entityCount === 0) {
    searchStatus.textContent = "This model has no searchable city entities.";
    return;
  }

  const matches = searchRepositoryEntities(
    repositoryExplorerIndex,
    buildingSearch.value,
    { limit: MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT },
  );
  if (matches.state === "empty-query") {
    searchStatus.textContent = "Type to find a building or district.";
    return;
  }
  const totalCount = matches.totalCount;
  if (totalCount === 0) {
    searchStatus.textContent =
      `No city entities match “${matches.query}”.`;
    return;
  }

  const results = matches.results.slice(0, searchResultLimit);
  const visibleCount = results.length;
  findPanel.classList.add("has-results");
  searchStatus.textContent =
    `${totalCount.toLocaleString()} ${totalCount === 1 ? "result" : "results"} found` +
    (visibleCount < totalCount
      ? ` · showing ${visibleCount.toLocaleString()}`
      : "");
  searchShowMore.hidden =
    visibleCount >= totalCount ||
    searchResultLimit >= MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT;

  for (const entry of results) {
    const item = document.createElement("li");
    item.className = "search-result";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result-button";
    button.title = entry.result.path;
    if (entry.kind === "building") {
      const { result } = entry;
      button.dataset["buildingId"] = result.buildingId;
      if (
        result.buildingId === selectedExplorerBuildingId(explorerState)
      ) {
        button.setAttribute("aria-current", "true");
      }
      button.addEventListener("click", () => {
        viewerWorkspace.show("details", {
          intent: "explicit",
          focusTab: true,
        });
        selectBuildingFromExplorer(result.buildingId);
      });
    } else {
      const { result } = entry;
      button.dataset["districtId"] = result.districtId;
      if (
        result.districtId === selectedExplorerDistrictId(explorerState)
      ) {
        button.setAttribute("aria-current", "true");
      }
      button.addEventListener("click", () => {
        viewerWorkspace.show("details", {
          intent: "explicit",
          focusTab: true,
        });
        selectDistrictFromExplorer(result.districtId);
      });
    }

    const name = document.createElement("span");
    name.className = "search-result-name";
    name.textContent = entry.result.name;

    const path = document.createElement("span");
    path.className = "search-result-path";
    path.textContent = entry.result.path;

    const metadata = document.createElement("span");
    metadata.className = "search-result-meta";
    if (entry.kind === "building") {
      metadata.textContent =
        `${entry.result.moduleName} · Max CC ` +
        entry.result.maximumComplexity.toLocaleString();
    } else {
      metadata.textContent =
        `${entry.result.moduleName} · ` +
        `${entry.result.buildingCount.toLocaleString()} ${
          entry.result.buildingCount === 1 ? "building" : "buildings"
        }`;
    }

    button.append(name, path, metadata);
    item.append(button);
    searchResults.append(item);
  }
}

function searchResultButtons(): HTMLButtonElement[] {
  return [
    ...searchResults.querySelectorAll<HTMLButtonElement>(
      ".search-result-button",
    ),
  ];
}

function selectBuildingFromExplorer(buildingId: string): void {
  const next = selectExplorerBuilding(
    explorerState,
    activeModel,
    buildingId,
  );
  if (selectedExplorerBuildingId(next) === buildingId) {
    cityScene.selectBuilding(buildingId, true);
  }
}

function selectDistrictFromExplorer(districtId: string): void {
  const next = selectExplorerDistrict(
    explorerState,
    activeModel,
    districtId,
  );
  if (selectedExplorerDistrictId(next) === districtId) {
    cityScene.selectDistrict(districtId, true);
  }
}

function clearBuildingSelection(): void {
  cityScene.resetSelection();
  showInspector(null);
}

function synchronizeExplorerState(state: ExplorerState): void {
  const previousSelectedBuildingId =
    selectedExplorerBuildingId(explorerState);
  const previousIsolatedDistrictId =
    explorerState.isolatedDistrictId;
  explorerState = state;
  const selectedBuildingId = selectedExplorerBuildingId(state);
  const selectedDistrictId = selectedExplorerDistrictId(state);
  const selectedExternalNodeId = selectedExplorerExternalId(state);
  if (selectedExternalNodeId !== null) {
    const selectedExternal = activeExternalNodes.find(
      ({ id }) => id === selectedExternalNodeId,
    );
    if (selectedExternal) {
      showExternalInspector(selectedExternal);
    }
  }
  if (
    previousSelectedBuildingId !== null &&
    selectedBuildingId === null
  ) {
    dependencyRouteState = resetDependencyRouteState();
  }
  if (previousSelectedBuildingId !== selectedBuildingId) {
    dependencyRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
  }
  if (previousIsolatedDistrictId !== state.isolatedDistrictId) {
    districtRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
  }
  const selected = selectedBuildingId
    ? activeModel.buildings.find(
        ({ id }) => id === selectedBuildingId,
      )
    : undefined;
  const isolatableDistrictId =
    selected?.districtId ?? selectedDistrictId;
  isolateDistrictButton.disabled =
    isolatableDistrictId === null ||
    state.isolatedDistrictId === isolatableDistrictId;
  showWholeCityButton.disabled = state.isolatedDistrictId === null;
  for (const button of searchResultButtons()) {
    if (
      button.dataset["buildingId"] === selectedBuildingId ||
      button.dataset["districtId"] === selectedDistrictId
    ) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  renderExternalNodeList();
  renderDependencyExplorer();
  renderDistrictDependencyExplorer();
  renderViewerOverview();
}

function toggleDistrictDependencyFilter(kind: DependencyKind): void {
  districtDependencyFilters = toggleDistrictDependencyKind(
    districtDependencyFilters,
    kind,
  );
  districtRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
  renderDistrictDependencyExplorer();
}

function renderDistrictDependencyExplorer(): void {
  const focusedBundleId =
    document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset["bundleId"] ?? null
      : null;
  const summary = summarizeDistrictDependencies(
    districtDependencyExplorerIndex,
    districtDependencyFilters,
    explorerState.isolatedDistrictId,
  );
  const visibleBundles = summary.bundles.slice(
    0,
    districtRouteVisibleLimit,
  );
  const visibleReferenceWeight = visibleBundles.reduce(
    (total, bundle) => total + bundle.weight,
    0,
  );
  const revealableBundleCount =
    summary.bundles.length - visibleBundles.length;
  const hiddenBundleCount =
    summary.totalBundleCount - visibleBundles.length;
  const availableKinds = new Map(
    summary.availableKinds.map((kind) => [kind.kind, kind]),
  );

  updateDistrictDependencyFilter(
    districtRouteTypeScriptFilter,
    districtRouteTypeScriptCount,
    "typescript-import",
    districtDependencyFilters.typescriptImport,
    availableKinds.get("typescript-import"),
  );
  updateDistrictDependencyFilter(
    districtRouteProjectFilter,
    districtRouteProjectCount,
    "project-reference",
    districtDependencyFilters.projectReference,
    availableKinds.get("project-reference"),
  );
  updateDistrictDependencyFilter(
    districtRoutePackageFilter,
    districtRoutePackageCount,
    "package-reference",
    districtDependencyFilters.packageReference,
    availableKinds.get("package-reference"),
  );

  districtRoutesToggle.disabled =
    districtDependencyExplorerIndex.bundleCount === 0;
  districtRoutesToggle.setAttribute(
    "aria-expanded",
    String(districtDependencyRoutesVisible),
  );
  districtRoutesToggle.textContent =
    districtDependencyRoutesVisible ? "Hide" : "Show";
  districtRoutesList.replaceChildren();
  visibleDistrictDependencyBundlesById = new Map(
    visibleBundles.map((bundle) => [bundle.id, bundle]),
  );
  districtRoutesShowMore.hidden =
    !districtDependencyRoutesVisible || revealableBundleCount === 0;
  districtRoutesShowMore.textContent =
    "Show more routes" +
    ` (${revealableBundleCount.toLocaleString()} available)`;

  if (
    selectedDistrictDependencyBundleId !== null &&
    !visibleDistrictDependencyBundlesById.has(
      selectedDistrictDependencyBundleId,
    )
  ) {
    selectedDistrictDependencyBundleId = null;
  }

  if (!districtDependencyRoutesVisible) {
    districtRoutesList.hidden = true;
    districtRoutesShowMore.hidden = true;
    districtRouteDetails.hidden = true;
    districtRoutesStatus.textContent =
      districtDependencyExplorerIndex.bundleCount === 0
        ? "No cross-district dependency routes recorded."
        : `Routes hidden · ${routeCountLabel(summary.totalBundleCount)} with current filters.`;
    cityScene.replaceDistrictDependencyRoutes([]);
    return;
  }

  const hasEnabledKind =
    districtDependencyFilters.typescriptImport ||
    districtDependencyFilters.projectReference ||
    districtDependencyFilters.packageReference;
  districtRoutesList.hidden = visibleBundles.length === 0;
  if (!hasEnabledKind) {
    districtRoutesStatus.textContent = "No route kinds selected.";
  } else if (summary.totalBundleCount === 0) {
    districtRoutesStatus.textContent =
      explorerState.isolatedDistrictId === null
        ? "No routes match the selected kinds."
        : "No matching routes touch this district.";
  } else {
    districtRoutesStatus.textContent =
      `Showing ${visibleBundles.length.toLocaleString()} of ` +
      `${routeCountLabel(summary.totalBundleCount)} · ` +
      `${visibleReferenceWeight.toLocaleString()} of ` +
      `${referenceCountLabel(summary.totalReferenceWeight)}` +
      (hiddenBundleCount > 0
        ? ` · ${hiddenBundleCount.toLocaleString()} not shown`
        : "");
  }

  const overlayRoutes: DependencyOverlayRoute[] = [];
  for (const bundle of visibleBundles) {
    overlayRoutes.push(districtDependencyOverlayRoute(bundle));
    districtRoutesList.append(districtDependencyListItem(bundle));
  }
  cityScene.replaceDistrictDependencyRoutes(overlayRoutes);

  const selected =
    selectedDistrictDependencyBundleId === null
      ? null
      : visibleDistrictDependencyBundlesById.get(
          selectedDistrictDependencyBundleId,
        ) ?? null;
  renderDistrictDependencyDetails(selected);

  if (focusedBundleId !== null) {
    districtRouteButton(focusedBundleId)?.focus({
      preventScroll: true,
    });
  }
}

function updateDistrictDependencyFilter(
  button: HTMLButtonElement,
  count: HTMLElement,
  kind: DependencyKind,
  pressed: boolean,
  availability:
    | {
        readonly edgeCount: number;
        readonly weight: number;
      }
    | undefined,
): void {
  const edgeCount = availability?.edgeCount ?? 0;
  const weight = availability?.weight ?? 0;
  button.disabled = edgeCount === 0;
  button.setAttribute("aria-pressed", String(pressed));
  button.setAttribute(
    "aria-label",
    `${districtDependencyKindLabel(kind)} routes, ` +
      `${edgeCountLabel(edgeCount)}, ${referenceCountLabel(weight)}`,
  );
  button.title =
    `${edgeCountLabel(edgeCount)} · ${referenceCountLabel(weight)}`;
  count.textContent =
    `${weight.toLocaleString()} ${weight === 1 ? "ref" : "refs"}`;
}

function districtDependencyListItem(
  bundle: DistrictDependencyBundle,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "district-route-item";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "district-route-button";
  button.dataset["bundleId"] = bundle.id;
  const external = bundle.target.kind === "external";
  if (external) {
    button.dataset["external"] = "true";
  }
  if (bundle.id === selectedDistrictDependencyBundleId) {
    button.setAttribute("aria-current", "true");
  }
  button.setAttribute(
    "aria-label",
    `${districtDependencyEndpointLabel(bundle.source)} to ` +
      `${districtDependencyEndpointLabel(bundle.target)}, ` +
      `${edgeCountLabel(bundle.edgeCount)}, ` +
      referenceCountLabel(bundle.weight),
  );
  button.addEventListener("click", () => {
    selectedDistrictDependencyBundleId = bundle.id;
    renderDistrictDependencyExplorer();
  });

  const name = document.createElement("span");
  name.className = "district-route-name";
  name.textContent =
    `${districtDependencyEndpointLabel(bundle.source)} → ` +
    districtDependencyEndpointLabel(bundle.target);
  name.title = name.textContent;

  const weight = document.createElement("span");
  weight.className = "district-route-weight";
  weight.textContent = referenceCountLabel(bundle.weight);

  const kind = document.createElement("span");
  kind.className = "district-route-kind";
  const dominantKind = dominantDistrictDependencyKind(bundle);
  kind.dataset["kind"] = districtDependencyKindToken(dominantKind);
  if (external) {
    kind.dataset["external"] = "true";
  }
  kind.textContent = bundle.kinds
    .map(
      (summary) =>
        `${districtDependencyKindLabel(summary.kind)} ` +
        `${summary.weight.toLocaleString()}`,
    )
    .join(" · ");

  button.append(name, weight, kind);
  item.append(button);
  return item;
}

function renderDistrictDependencyDetails(
  bundle: DistrictDependencyBundle | null,
): void {
  districtRouteDetails.hidden =
    !districtDependencyRoutesVisible || bundle === null;
  districtRouteContributors.replaceChildren();
  if (bundle === null) {
    districtRouteDetailTitle.textContent = "Route details";
    districtRouteDetailSummary.textContent = "";
    districtRouteDetailKinds.textContent = "";
    districtRouteIsolateConsumer.disabled = true;
    districtRouteIsolateProvider.disabled = true;
    return;
  }

  districtRouteDetailTitle.textContent =
    `${districtDependencyEndpointLabel(bundle.source)} → ` +
    districtDependencyEndpointLabel(bundle.target);
  districtRouteDetailSummary.textContent =
    `${edgeCountLabel(bundle.edgeCount)} · ` +
    referenceCountLabel(bundle.weight);
  districtRouteDetailKinds.textContent = bundle.kinds
    .map(
      (summary) =>
        `${districtDependencyKindLabel(summary.kind)}: ` +
        `${edgeCountLabel(summary.edgeCount)}, ` +
        referenceCountLabel(summary.weight),
    )
    .join(" · ");

  for (const contributor of bundle.contributors) {
    const item = document.createElement("li");
    item.textContent =
      `${contributor.sourceLabel} → ${contributor.targetLabel} · ` +
      referenceCountLabel(contributor.weight);
    item.title =
      `${contributor.sourcePath} → ${contributor.targetPath} · ` +
      districtDependencyKindLabel(contributor.kind);
    districtRouteContributors.append(item);
  }

  updateDistrictEndpointAction(
    districtRouteIsolateConsumer,
    bundle.source,
    "consumer",
  );
  updateDistrictEndpointAction(
    districtRouteIsolateProvider,
    bundle.target,
    "provider",
  );
}

function updateDistrictEndpointAction(
  button: HTMLButtonElement,
  endpoint: DistrictDependencyEndpoint,
  role: "consumer" | "provider",
): void {
  const districtId = districtDependencyEndpointDistrictId(endpoint);
  button.disabled =
    districtId === null ||
    districtId === explorerState.isolatedDistrictId;
  button.textContent =
    districtId === null
      ? "External provider"
      : `Isolate ${role}`;
}

function isolateDistrictDependencyEndpoint(
  role: "consumer" | "provider",
  focusInspectTab = false,
): void {
  if (selectedDistrictDependencyBundleId === null) {
    return;
  }
  const bundle = visibleDistrictDependencyBundlesById.get(
    selectedDistrictDependencyBundleId,
  );
  if (!bundle) {
    return;
  }
  const endpoint = role === "consumer" ? bundle.source : bundle.target;
  const districtId = districtDependencyEndpointDistrictId(endpoint);
  if (districtId === null) {
    return;
  }
  if (focusInspectTab) {
    viewerWorkspace.show("details", {
      intent: "explicit",
      focusTab: true,
    });
  }
  cityScene.isolateDistrict(districtId);
  cityScene.selectDistrict(districtId);
}

function navigateDistrictDependencyRoutes(event: KeyboardEvent): void {
  const buttons = districtRouteButtons();
  if (buttons.length === 0) {
    return;
  }
  const current = buttons.indexOf(
    document.activeElement as HTMLButtonElement,
  );
  let next: HTMLButtonElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      next =
        current < 0
          ? buttons[0]
          : buttons[(current + 1) % buttons.length];
      break;
    case "ArrowUp":
      next =
        current < 0
          ? buttons.at(-1)
          : buttons[(current - 1 + buttons.length) % buttons.length];
      break;
    case "Home":
      next = buttons[0];
      break;
    case "End":
      next = buttons.at(-1);
      break;
  }
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

function districtRouteButtons(): HTMLButtonElement[] {
  return [
    ...districtRoutesList.querySelectorAll<HTMLButtonElement>(
      ".district-route-button",
    ),
  ];
}

function districtRouteButton(
  bundleId: string,
): HTMLButtonElement | undefined {
  return districtRouteButtons().find(
    (button) => button.dataset["bundleId"] === bundleId,
  );
}

function toggleDependencyDirection(
  direction: DependencyRouteDirection,
): void {
  const selectedBuildingId = selectedExplorerBuildingId(explorerState);
  if (selectedBuildingId === null) {
    return;
  }
  const summary = dependencyRoutesForBuilding(
    dependencyExplorerIndex,
    selectedBuildingId,
  );
  if (!summary || summary[direction].totalCount === 0) {
    return;
  }
  dependencyRouteState = toggleDependencyRouteDirection(
    dependencyRouteState,
    direction,
  );
  dependencyRouteVisibleLimit = INITIAL_ROUTE_RESULT_LIMIT;
  renderDependencyExplorer();
}

function renderDependencyExplorer(): void {
  dependencyList.replaceChildren();
  dependencyShowMore.hidden = true;
  const selectedBuildingId = selectedExplorerBuildingId(explorerState);
  const summary =
    selectedBuildingId === null
      ? null
      : dependencyRoutesForBuilding(
          dependencyExplorerIndex,
          selectedBuildingId,
        );
  const incomingCount = summary?.incoming.totalCount ?? 0;
  const outgoingCount = summary?.outgoing.totalCount ?? 0;
  const hasRoutes = incomingCount + outgoingCount > 0;

  updateDependencyToggle(
    dependencyIncomingToggle,
    dependencyIncomingCount,
    incomingCount,
    dependencyRouteState.incoming,
  );
  updateDependencyToggle(
    dependencyOutgoingToggle,
    dependencyOutgoingCount,
    outgoingCount,
    dependencyRouteState.outgoing,
  );
  dependencyEmpty.hidden = hasRoutes || selectedBuildingId === null;

  if (selectedBuildingId === null || !summary || !hasRoutes) {
    dependencyList.hidden = true;
    dependencyStatus.textContent =
      selectedBuildingId === null
        ? "Select a building to inspect its dependencies."
        : "No file-level dependency routes recorded.";
    cityScene.replaceDependencyRoutes([]);
    return;
  }

  const visibleIncomingRoutes = dependencyRouteState.incoming
    ? summary.incoming.routes.slice(0, dependencyRouteVisibleLimit)
    : [];
  const visibleOutgoingRoutes = dependencyRouteState.outgoing
    ? summary.outgoing.routes.slice(0, dependencyRouteVisibleLimit)
    : [];
  const visibleRoutes = [
    ...visibleIncomingRoutes,
    ...visibleOutgoingRoutes,
  ];
  const activeSummaries = [
    ...(dependencyRouteState.incoming ? [summary.incoming] : []),
    ...(dependencyRouteState.outgoing ? [summary.outgoing] : []),
  ];
  dependencyList.hidden = visibleRoutes.length === 0;

  if (activeSummaries.length === 0) {
    dependencyStatus.textContent =
      `Routes hidden · ${incomingCount.toLocaleString()} incoming · ` +
      `${outgoingCount.toLocaleString()} outgoing`;
    cityScene.replaceDependencyRoutes([]);
    return;
  }

  const totalCount = activeSummaries.reduce(
    (total, direction) => total + direction.totalCount,
    0,
  );
  const revealableCount = activeSummaries.reduce(
    (total, direction) =>
      total +
      Math.max(0, direction.routes.length - dependencyRouteVisibleLimit),
    0,
  );
  const visibleWeight = visibleRoutes.reduce(
    (total, route) => total + route.weight,
    0,
  );
  const totalWeight = activeSummaries.reduce(
    (total, direction) => total + direction.totalWeight,
    0,
  );
  const hiddenCount = totalCount - visibleRoutes.length;
  const hiddenWeight = totalWeight - visibleWeight;
  dependencyShowMore.hidden = revealableCount === 0;
  dependencyShowMore.textContent =
    "Show more routes" +
    ` (${revealableCount.toLocaleString()} available)`;
  dependencyStatus.textContent =
    visibleRoutes.length === 0
      ? "No routes in the selected direction."
      : `Showing ${routeCountLabel(visibleRoutes.length)} · ` +
        `${referenceCountLabel(visibleWeight)}` +
        (hiddenCount > 0
          ? ` · ${hiddenCount.toLocaleString()} hidden (${referenceCountLabel(hiddenWeight)})`
          : "");

  const overlayRoutes: DependencyOverlayRoute[] = [];
  for (const route of visibleRoutes) {
    const projection = projectDependencyRoute(
      dependencyExplorerIndex,
      selectedBuildingId,
      route,
      explorerState.isolatedDistrictId,
    );
    overlayRoutes.push(dependencyOverlayRoute(route, projection));
    dependencyList.append(dependencyListItem(route, projection));
  }
  cityScene.replaceDependencyRoutes(overlayRoutes);
}

function updateDependencyToggle(
  button: HTMLButtonElement,
  count: HTMLElement,
  totalCount: number,
  pressed: boolean,
): void {
  button.disabled = totalCount === 0;
  button.setAttribute("aria-pressed", String(pressed));
  count.textContent = totalCount.toLocaleString();
}

function dependencyListItem(
  route: SelectedDependencyRoute,
  projection: DependencyRouteProjection,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "dependency-item";

  const isExternal = route.counterpart.kind === "external";
  const row = document.createElement("button");
  row.type = "button";
  row.className = "dependency-result-button";
  row.dataset["direction"] = route.direction;
  if (isExternal) {
    row.dataset["external"] = "true";
    const target = route.counterpart.target;
    row.addEventListener("click", () => {
      const node = resolveExternalDependencyNode(
        activeExternalLayout,
        target,
      );
      if (!node) return;
      viewerWorkspace.show("details", {
        intent: "explicit",
        focusTab: true,
      });
      cityScene.selectExternalNode(node.id);
    });
  } else if (route.counterpart.kind === "building") {
    const counterpartBuildingId = route.counterpart.buildingId;
    row.addEventListener("click", () => {
      viewerWorkspace.show("details", {
        intent: "explicit",
        focusTab: true,
      });
      selectBuildingFromExplorer(counterpartBuildingId);
    });
  }

  const direction = document.createElement("span");
  direction.className = "dependency-result-direction";
  direction.textContent =
    route.direction === "incoming" ? "Incoming" : "Outgoing";

  const content = document.createElement("span");
  content.className = "dependency-result-content";
  const name = document.createElement("span");
  name.className = "dependency-result-name";
  name.textContent =
    route.counterpart.kind === "building"
      ? route.counterpart.name
      : route.counterpart.target;
  const path = document.createElement("span");
  path.className = "dependency-result-path";
  path.textContent =
    route.counterpart.kind === "building"
      ? route.counterpart.path
      : "External provider";
  if (!isExternal) {
    row.title = path.textContent;
  }

  const role =
    route.direction === "incoming" ? "Consumer" : "Provider";
  const meta = document.createElement("span");
  meta.className = "dependency-result-meta";
  meta.textContent =
    `${isExternal ? "External provider" : role} · ` +
    referenceCountLabel(route.weight) +
    hiddenBoundaryLabel(projection);

  row.setAttribute(
    "aria-label",
    `${name.textContent}, ${
      isExternal ? "external provider" : role.toLowerCase()
    }, ${referenceCountLabel(route.weight)}`,
  );
  content.append(name, path, meta);
  row.append(direction, content);
  item.append(row);
  return item;
}

function hiddenBoundaryLabel(
  projection: DependencyRouteProjection,
): string {
  const boundary =
    projection.source.kind === "district-boundary"
      ? projection.source
      : projection.target.kind === "district-boundary"
        ? projection.target
        : null;
  if (!boundary) {
    return "";
  }
  const hiddenDistrict = activeDistrictsById.get(
    boundary.hiddenCounterpart.districtId,
  );
  return ` · Outside isolated district${hiddenDistrict ? `: ${hiddenDistrict.name}` : ""}`;
}

function dependencyOverlayRoute(
  route: SelectedDependencyRoute,
  projection: DependencyRouteProjection,
): DependencyOverlayRoute {
  return {
    id: `${route.dependencyId}:${route.direction}`,
    consumer: dependencyEndpointGeometry(projection.source),
    provider: dependencyEndpointGeometry(projection.target),
    direction: route.direction,
    weight: route.weight,
    externalProvider: route.counterpart.kind === "external",
  };
}

function dependencyEndpointGeometry(
  endpoint: DependencyRouteEndpoint,
): RouteEndpointGeometry {
  switch (endpoint.kind) {
    case "building": {
      const building = activeBuildingsById.get(endpoint.buildingId);
      if (!building) {
        throw new Error(
          `Dependency route references unknown building "${endpoint.buildingId}".`,
        );
      }
      return buildingRouteEndpoint(building);
    }
    case "district-boundary": {
      return keyedIsolationGateway(
        requiredDistrictDependencyFootprint(endpoint.districtId),
        endpoint.gatewayKey,
      );
    }
    case "external": {
      return externalDependencyEndpoint(endpoint.target);
    }
  }
}

function districtDependencyOverlayRoute(
  bundle: DistrictDependencyBundle,
): DependencyOverlayRoute {
  const geometry = districtDependencyRouteGeometry(bundle);
  const externalProvider = bundle.target.kind === "external";
  return {
    id: bundle.id,
    consumer: geometry.consumer,
    provider: geometry.provider,
    direction: "outgoing",
    weight: bundle.weight,
    externalProvider,
    color: districtDependencyRouteColor(bundle),
    emphasized: bundle.id === selectedDistrictDependencyBundleId,
  };
}

function districtDependencyRouteGeometry(
  bundle: DistrictDependencyBundle,
): {
  readonly consumer: RouteEndpointGeometry;
  readonly provider: RouteEndpointGeometry;
} {
  if (
    bundle.source.kind === "district" &&
    bundle.target.kind === "district"
  ) {
    return districtRouteEndpoints(
      requiredDistrictDependencyFootprint(bundle.source.districtId),
      requiredDistrictDependencyFootprint(bundle.target.districtId),
    );
  }

  if (
    bundle.source.kind === "district" &&
    bundle.target.kind === "external"
  ) {
    const consumerDistrict = requiredDistrictDependencyFootprint(
      bundle.source.districtId,
    );
    const provider = externalDependencyEndpoint(bundle.target.target);
    return {
      consumer: districtBoundaryAnchor(
        consumerDistrict,
        provider.anchor,
      ),
      provider,
    };
  }

  if (
    bundle.source.kind === "district" &&
    bundle.target.kind === "district-boundary"
  ) {
    const visibleDistrict = requiredDistrictDependencyFootprint(
      bundle.source.districtId,
    );
    const provider = keyedIsolationGateway(
      visibleDistrict,
      routeEndpointKey(
        "district",
        bundle.target.hiddenDistrictId,
      ),
    );
    return {
      consumer: keyedIsolationGateway(
        visibleDistrict,
        routeEndpointKey(
          "district",
          bundle.source.districtId,
        ),
      ),
      provider,
    };
  }

  if (
    bundle.source.kind === "district-boundary" &&
    bundle.target.kind === "district"
  ) {
    const visibleDistrict = requiredDistrictDependencyFootprint(
      bundle.target.districtId,
    );
    const consumer = keyedIsolationGateway(
      visibleDistrict,
      routeEndpointKey(
        "district",
        bundle.source.hiddenDistrictId,
      ),
    );
    return {
      consumer,
      provider: keyedIsolationGateway(
        visibleDistrict,
        routeEndpointKey(
          "district",
          bundle.target.districtId,
        ),
      ),
    };
  }

  throw new Error(
    `Unsupported district dependency route geometry for "${bundle.id}".`,
  );
}

function externalDependencyEndpoint(
  target: string,
): RouteEndpointGeometry {
  const node = resolveExternalDependencyNode(
    activeExternalLayout,
    target,
  );
  if (!node) {
    throw new Error(
      `External dependency route references unknown target "${target}".`,
    );
  }
  const roof = {
    x: node.position.x,
    y: node.position.y + node.size.y * 0.5,
    z: node.position.z,
  };
  return {
    contact: roof,
    anchor: { ...roof },
  };
}

function requiredDistrictDependencyFootprint(
  districtId: string,
): DistrictDependencyFootprint {
  const district = districtDependencyFootprintsById.get(districtId);
  if (!district) {
    throw new Error(
      `Unknown district dependency footprint "${districtId}".`,
    );
  }
  return district;
}

function createDistrictDependencyFootprints(
  model: CityModel,
): ReadonlyMap<string, DistrictDependencyFootprint> {
  const footprints = new Map<string, DistrictDependencyFootprint>();
  for (const district of model.districts) {
    const buildingSkyline = model.buildings
      .filter((building) => building.districtId === district.id)
      .reduce(
        (maximum, building) =>
          Math.max(
            maximum,
            building.position.y + building.size.y * 0.5,
          ),
        district.position.y + district.size.y * 0.5,
      );
    footprints.set(district.id, {
      centerX: district.position.x,
      centerZ: district.position.z,
      sizeX: district.size.x,
      sizeZ: district.size.z,
      surfaceY: district.position.y + district.size.y * 0.5,
      skylineY: buildingSkyline,
    });
  }
  return footprints;
}

function districtDependencyRouteColor(
  bundle: DistrictDependencyBundle,
): string {
  if (bundle.target.kind === "external") {
    return "#f59e0b";
  }
  switch (dominantDistrictDependencyKind(bundle)) {
    case "typescript-import":
      return "#38bdf8";
    case "project-reference":
      return "#a78bfa";
    case "package-reference":
      return "#4ade80";
  }
}

function dominantDistrictDependencyKind(
  bundle: DistrictDependencyBundle,
): DependencyKind {
  const first = bundle.kinds[0];
  if (!first) {
    throw new Error(
      `District dependency bundle "${bundle.id}" has no kinds.`,
    );
  }
  return bundle.kinds.reduce((dominant, current) =>
    current.weight > dominant.weight ? current : dominant,
  ).kind;
}

function districtDependencyEndpointLabel(
  endpoint: DistrictDependencyEndpoint,
): string {
  switch (endpoint.kind) {
    case "district":
      return endpoint.name;
    case "district-boundary":
      return endpoint.hiddenDistrictName;
    case "external":
      return endpoint.target;
  }
}

function districtDependencyEndpointDistrictId(
  endpoint: DistrictDependencyEndpoint,
): string | null {
  switch (endpoint.kind) {
    case "district":
      return endpoint.districtId;
    case "district-boundary":
      return endpoint.hiddenDistrictId;
    case "external":
      return null;
  }
}

function districtDependencyKindLabel(kind: DependencyKind): string {
  switch (kind) {
    case "typescript-import":
      return "TypeScript";
    case "project-reference":
      return "Project";
    case "package-reference":
      return "Package";
  }
}

function districtDependencyKindToken(
  kind: DependencyKind,
): "typescript" | "project" | "package" {
  switch (kind) {
    case "typescript-import":
      return "typescript";
    case "project-reference":
      return "project";
    case "package-reference":
      return "package";
  }
}

function edgeCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "edge" : "edges"}`;
}

function routeCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "route" : "routes"}`;
}

function referenceCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "reference" : "references"}`;
}

async function applyLogo(
  model: CityModel,
  source: ModelSource,
): Promise<void> {
  logoLoadGate.invalidate();
  loadedModelLogo?.dispose();
  loadedModelLogo = undefined;
  const logo = model.identity?.logo;
  modelLogo.onerror = null;
  modelLogo.hidden = true;
  modelLogo.removeAttribute("src");
  modelLogoPlaceholder.hidden = true;
  modelLogoPlaceholder.title = "";

  if (!logo) {
    return;
  }

  const alt = logo.alt ?? `${model.identity?.title ?? "Model"} logo`;
  modelLogo.alt = alt;
  if (!source.assetRoot) {
    showLogoPlaceholder(model, alt, logo.relativePath);
    return;
  }

  const attempt = logoLoadGate.begin();
  try {
    const image = await viewerLoadGateway.loadRemoteLogo(
      resolveAssetUrl(logo.relativePath, source.assetRoot),
      logo.format,
      attempt.signal,
    );
    if (!attempt.isCurrent()) {
      image.dispose();
      return;
    }
    loadedModelLogo = image;
    modelLogo.src = image.objectUrl;
    modelLogo.hidden = false;
    modelLogo.onerror = () => {
      if (loadedModelLogo !== image) return;
      loadedModelLogo = undefined;
      image.dispose();
      modelLogo.hidden = true;
      modelLogo.removeAttribute("src");
      showLogoPlaceholder(model, alt, logo.relativePath);
    };
  } catch {
    if (attempt.isCurrent()) {
      showLogoPlaceholder(model, alt, logo.relativePath);
    }
  } finally {
    attempt.finish();
  }
}

function showLogoPlaceholder(
  model: CityModel,
  alt: string,
  relativePath: string,
): void {
  modelLogoPlaceholder.textContent = initials(
    model.identity?.title ?? "Code City",
  );
  modelLogoPlaceholder.title = `${alt}: ${relativePath}`;
  modelLogoPlaceholder.hidden = false;
}

function initials(title: string): string {
  const letters = title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "CC";
}

function renderLegend(
  model: CityModel,
  semanticGroups: readonly SemanticGroup[] = model.semanticGroups,
): void {
  legend.replaceChildren();
  const displayGroups = [...semanticGroups];
  if (
    activeExternalNodes.length > 0 &&
    !displayGroups.some(({ id }) => id === "external")
  ) {
    displayGroups.push({
      id: "external",
      label: "External dependencies",
      color: EXTERNAL_DEPENDENCY_COLOR,
      priority: 55,
      mergeInto: "base",
    });
  }
  const groups = sortLegendGroups(displayGroups);

  for (const group of groups) {
    const item = document.createElement("li");
    item.className = "legend-item";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = group.color;
    swatch.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = group.label;
    item.append(swatch, label);
    legend.append(item);
  }
}

function applyVisualization(): void {
  const visualization = createViewerVisualization(
    activeModel,
    visualizationMode,
    previewPrinterProfile,
    activeEvolutionAnalysis,
  );
  const colors = new Map(visualization.colorsByBuildingId);
  const transition = activeEvolutionTransition;
  if (transition !== undefined) {
    transition.changedBuildingIds.forEach((id) => colors.set(id, "#a78bfa"));
    transition.resizedBuildingIds.forEach((id) => colors.set(id, "#fbbf24"));
    transition.renamedBuildingIds.forEach((id) => colors.set(id, "#22d3ee"));
    transition.addedBuildingIds.forEach((id) => colors.set(id, "#4ade80"));
  }
  cityScene.setVisualization(
    colors,
    visualization.label,
  );
  const transitionStatus =
    transition === undefined
      ? ""
      : " Current-frame changes override the mode colors.";
  visualizationModeStatus.textContent =
    visualization.status + transitionStatus;
  visualizationModeSelect.setAttribute(
    "aria-invalid",
    visualization.available ? "false" : "true",
  );
  legend.setAttribute(
    "aria-label",
    `${visualization.label} legend`,
  );
  const changeGroups: SemanticGroup[] = [];
  if (transition?.addedBuildingIds.length) {
    changeGroups.push({
      id: "evolution-added",
      label: "Added in this transition",
      color: "#4ade80",
      priority: 104,
    });
  }
  if (transition?.renamedBuildingIds.length) {
    changeGroups.push({
      id: "evolution-renamed",
      label: "Renamed in this transition",
      color: "#22d3ee",
      priority: 103,
    });
  }
  if (transition?.resizedBuildingIds.length) {
    changeGroups.push({
      id: "evolution-resized",
      label: "Moved or resized in this transition",
      color: "#fbbf24",
      priority: 102,
    });
  }
  if (
    transition?.changedBuildingIds.some(
      (id) =>
        !transition.renamedBuildingIds.includes(id) &&
        !transition.resizedBuildingIds.includes(id),
    )
  ) {
    changeGroups.push({
      id: "evolution-changed",
      label: "Metrics or relationships changed",
      color: "#a78bfa",
      priority: 101,
    });
  }
  renderLegend(activeModel, [...changeGroups, ...visualization.legend]);
}

function renderViewerOverview(): void {
  const summary = summarizeViewerScope(
    activeModel,
    explorerState.isolatedDistrictId,
  );
  viewerScopeName.textContent = summary.scope.label;
  viewerScopeName.title = summary.scope.label;
  viewerScopeReset.disabled = summary.scope.kind === "city";
  overviewFields.description.textContent =
    summary.scope.kind === "city"
      ? "Metrics for the whole city."
      : `Metrics for district ${summary.scope.name}.`;
  overviewFields.repositories.textContent =
    summary.counts.repositories.toLocaleString();
  overviewFields.solutions.textContent =
    summary.counts.solutions.toLocaleString();
  overviewFields.modules.textContent =
    summary.counts.modules.toLocaleString();
  overviewFields.districts.textContent =
    summary.counts.districts.toLocaleString();
  overviewFields.buildings.textContent =
    summary.counts.buildings.toLocaleString();
  overviewFields.sloc.textContent =
    summary.complexity.totalSloc.toLocaleString();
  overviewFields.medianComplexity.textContent =
    summary.complexity.medianMaximumComplexity.toLocaleString(
      undefined,
      { maximumFractionDigits: 1 },
    );
  overviewFields.maximumComplexity.textContent =
    summary.complexity.maximumComplexity.toLocaleString();
  overviewFields.dependencyEdges.textContent =
    summary.dependencies.edgeCount.toLocaleString();
  overviewFields.referenceWeight.textContent =
    summary.dependencies.totalReferenceWeight.toLocaleString();

  const totalBuildings = summary.counts.buildings;
  for (const risk of [
    "low",
    "moderate",
    "high",
    "very-high",
  ] as const) {
    const count = summary.risks[risk];
    const field = overviewRiskFields[risk];
    field.count.textContent = count.toLocaleString();
    field.bar.style.width =
      totalBuildings === 0
        ? "0%"
        : `${(count / totalBuildings) * 100}%`;
  }
}

function sourceAvailabilityMessage(): string {
  if (activeModelSource.sourceAvailability === "disabled") {
    return "Source retention is disabled for this deployment; provenance and metrics remain available.";
  }
  if (activeModelSource.sourceAvailability === "unavailable") {
    return "This imported result predates retained source navigation.";
  }

  if (activeModelSource.sourceAvailability === "not-captured") {
    return "This model-only import did not capture source files; import a repository archive or remote repository to enable navigation.";
  }
  return "Source is unavailable for models opened directly in the viewer.";
}

function scrubBuildingSource(): void {
  sourceRequest?.abort();
  sourceRequest = undefined;
  loadedBuildingSource = undefined;
  inspectorFields.sourceCode.replaceChildren();
  inspectorFields.sourcePath.textContent = "";
  inspectorFields.sourceRevision.textContent = "";
  inspectorFields.sourceExternal.removeAttribute("href");
  inspectorFields.sourceEditor.removeAttribute("href");
  inspectorFields.sourceExternal.hidden = true;
  inspectorFields.sourceEditor.hidden = true;
  inspectorFields.sourceContent.hidden = true;
}

function renderSourceCode(
  source: BuildingSource,
  startLine?: number,
  endLine = startLine,
): void {
  inspectorFields.sourceCode.replaceChildren();
  const lines = source.text.split(/\r\n?|\n/u);
  const {
    requestedStart,
    requestedEnd,
    firstLine,
    lastLine,
    omittedBefore,
    omittedAfter,
  } = sourceLineWindow(
    lines.length,
    startLine ?? source.location.startLine,
    endLine ?? startLine ?? source.location.startLine,
  );
  const appendOmitted = (text: string): void => {
    const indicator = document.createElement("span");
    indicator.className = "source-line source-line-omitted";
    indicator.textContent = text;
    inspectorFields.sourceCode.append(indicator);
  };
  if (omittedBefore > 0) {
    appendOmitted(sourceOmissionMarker(omittedBefore, "earlier"));
  }
  for (
    let lineNumber = firstLine;
    lineNumber <= lastLine;
    lineNumber += 1
  ) {
    const text = lines[lineNumber - 1]!;
    const line = document.createElement("span");
    line.className = "source-line";
    line.dataset["line"] = String(lineNumber);
    if (
      startLine !== undefined &&
      lineNumber >= startLine &&
      lineNumber <= (endLine ?? startLine)
    ) {
      line.classList.add("source-line-highlight");
    }
    for (const token of sourceLineTokens(text)) {
      const span = document.createElement("span");
      if (token.kind !== "text") {
        span.className = `source-token-${token.kind}`;
      }
      span.textContent = token.text;
      line.append(span);
    }
    if (text === "") line.append("\u200b");
    inspectorFields.sourceCode.append(line);
  }
  if (omittedAfter > 0) {
    appendOmitted(sourceOmissionMarker(omittedAfter, "later"));
  }
  inspectorFields.sourceCode
    .querySelector<HTMLElement>(`[data-line="${requestedStart}"]`)
    ?.scrollIntoView({ block: "center" });
}

function revealBuildingSource(
  building: CityBuilding,
  startLine?: number,
  endLine?: number,
): void {
  inspectorFields.sourceDetails.open = true;
  if (
    loadedBuildingSource?.buildingId === building.id
  ) {
    renderSourceCode(
      loadedBuildingSource.source,
      startLine,
      endLine,
    );
    return;
  }
  scrubBuildingSource();
  const jobId = activeModelSource.jobId;
  if (
    jobId === undefined ||
    activeModelSource.sourceAvailability !== "retained"
  ) {
    inspectorFields.sourceSummary.textContent = "Unavailable";
    inspectorFields.sourceStatus.textContent =
      sourceAvailabilityMessage();
    return;
  }
  const controller = new AbortController();
  sourceRequest = controller;
  inspectorFields.sourceSummary.textContent = "Loading";
  const provenance = activeModel.sourceProvenance?.repositories.find(
    ({ repositoryId }) => repositoryId === building.repositoryId,
  );
  if (provenance === undefined) {
    sourceRequest = undefined;
    inspectorFields.sourceSummary.textContent = "Unavailable";
    inspectorFields.sourceStatus.textContent =
      "This building has no validated source provenance.";
    return;
  }
  inspectorFields.sourceStatus.textContent =
    `Loading ${building.path}…`;
  void loadBuildingSource(
    jobId,
    {
      buildingId: building.id,
      repositoryId: building.repositoryId,
      path: building.path,
      language: building.language,
      ...(building.sourceLocation === undefined
        ? {}
        : { location: building.sourceLocation }),
      provenance,
    },
    (requestedJobId, requestedBuildingId, signal) =>
      sourceApi.buildingSource(
        requestedJobId,
        requestedBuildingId,
        signal,
      ),
    controller.signal,
  )
    .then((source) => {
      if (controller.signal.aborted || sourceRequest !== controller) {
        return;
      }
      sourceRequest = undefined;
      loadedBuildingSource = { buildingId: building.id, source };
      inspectorFields.sourceSummary.textContent = "Read only";
      inspectorFields.sourceStatus.textContent =
        `Showing the exact retained file for ${source.path}.`;
      inspectorFields.sourcePath.textContent = source.path;
      inspectorFields.sourceRevision.textContent =
        `${source.provenance.provider} · ${source.provenance.revision.value}`;
      inspectorFields.sourceExternal.hidden =
        source.externalUrl === undefined;
      if (source.externalUrl !== undefined) {
        inspectorFields.sourceExternal.href = source.externalUrl;
      }
      inspectorFields.sourceEditor.hidden =
        source.editorUrl === undefined;
      if (source.editorUrl !== undefined) {
        inspectorFields.sourceEditor.href = source.editorUrl;
      }
      inspectorFields.sourceContent.hidden = false;
      renderSourceCode(source, startLine, endLine);
    })
    .catch((error: unknown) => {
      if (
        controller.signal.aborted ||
        sourceRequest !== controller
      ) {
        return;
      }
      scrubBuildingSource();
      inspectorFields.sourceSummary.textContent = "Unavailable";
      inspectorFields.sourceStatus.textContent =
        error instanceof Error
          ? error.message
          : "Source code could not be loaded.";
    });
}

function showInspector(context: BuildingContext | null): void {
  inspectorEmpty.hidden = context !== null;
  inspectorContent.hidden = context === null;
  districtInspectorContent.hidden = true;
  externalInspectorContent.hidden = true;
  clearSelectionButton.hidden = context === null;
  dependencySection.open = false;
  if (!context) {
    scrubBuildingSource();
    inspectorFields.evolutionRow.hidden = true;
    selectionKind.textContent = "Details";
    selectionName.textContent = "Nothing selected";
    selectionStatus.textContent = "Selection cleared.";
    return;
  }

  const { building, repository, module } = context;
  inspectorFields.unitsDetails.hidden = false;
  inspectorFields.sourceDetails.hidden = false;
  selectionKind.textContent = "Building";
  selectionName.textContent = building.name;
  inspectorFields.name.textContent = building.name;
  inspectorFields.repository.textContent = repository.name;
  inspectorFields.module.textContent = module.name;
  inspectorFields.path.textContent = building.path;
  inspectorFields.language.textContent = languageLabel(building.language);
  inspectorFields.sloc.textContent = building.metrics.sloc.toLocaleString();
  inspectorFields.load.textContent =
    building.metrics.decisionLoad.toLocaleString();
  inspectorFields.cc.textContent =
    building.metrics.maximumComplexity.toLocaleString();
  inspectorFields.metricMethod.textContent =
    building.metricMethod ?? "Not recorded";
  inspectorFields.metricExplanation.textContent =
    describeBuildingMetrics(activeModel, building);
  renderBuildingEvolutionHistory(building.id);
  inspectorFields.sourceDetails.open = false;
  revealBuildingSource(
    building,
    building.sourceLocation?.startLine,
  );
  executableUnitVisibleLimit =
    INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT;
  inspectorFields.unitsDetails.open = false;
  renderExecutableUnits(building);
  selectionStatus.textContent =
    `Selected ${building.name}. Maximum cyclomatic complexity ` +
    `${building.metrics.maximumComplexity.toLocaleString()}.`;
}

function renderBuildingEvolutionHistory(buildingId: string): void {
  const history = activeEvolutionHistories.get(buildingId);
  inspectorFields.evolutionRow.hidden = history === undefined;
  if (!history) {
    inspectorFields.evolution.textContent = "";
    return;
  }
  const first = activeEvolutionFrames[history.firstFrame];
  const removed =
    history.removedAtFrame === undefined
      ? ""
      : ` Removed at frame ${history.removedAtFrame + 1}.`;
  const kinds =
    history.changeKinds.length === 0
      ? ""
      : ` Changes: ${history.changeKinds.join(", ")}.`;
  inspectorFields.evolution.textContent =
    `First seen ${first?.sha.slice(0, 10) ?? `frame ${history.firstFrame + 1}`}; ` +
    `${history.changeCount.toLocaleString()} historical ` +
    `${history.changeCount === 1 ? "change" : "changes"}.` +
    removed +
    kinds;
}

function showDistrictInspector(context: DistrictContext): void {
  scrubBuildingSource();
  const { district, repository, module, buildingCount } = context;
  inspectorEmpty.hidden = true;
  inspectorContent.hidden = true;
  districtInspectorContent.hidden = false;
  externalInspectorContent.hidden = true;
  clearSelectionButton.hidden = false;
  selectionKind.textContent = "District";
  selectionName.textContent = district.name;
  dependencySection.open = false;
  districtInspectorFields.name.textContent = district.name;
  districtInspectorFields.repository.textContent = repository.name;
  districtInspectorFields.module.textContent = module.name;
  districtInspectorFields.path.textContent = district.path;
  districtInspectorFields.buildingCount.textContent =
    buildingCount.toLocaleString();
  selectionStatus.textContent =
    `Selected district ${district.name}. ` +
    `${buildingCount.toLocaleString()} ${
      buildingCount === 1 ? "building" : "buildings"
    }.`;
}

function showExternalInspector(node: ExternalSceneNode): void {
  scrubBuildingSource();
  const presentation = presentExternalDependency(
    node,
    externalConsumerIdentity,
  );

  inspectorEmpty.hidden = true;
  inspectorContent.hidden = true;
  districtInspectorContent.hidden = true;
  externalInspectorContent.hidden = false;
  clearSelectionButton.hidden = false;
  selectionKind.textContent = "External dependency";
  selectionName.textContent = presentation.label;
  dependencySection.open = false;
  externalInspectorFields.name.textContent = presentation.label;
  externalInspectorFields.target.textContent =
    presentation.kind === "external"
      ? presentation.label
      : `${presentation.targetCount.toLocaleString()} aggregated targets`;
  externalInspectorFields.weight.textContent =
    presentation.totalWeight.toLocaleString();
  externalInspectorFields.edgeCount.textContent =
    presentation.edgeCount.toLocaleString();
  externalInspectorFields.targetCount.textContent =
    presentation.targetCount.toLocaleString();
  externalInspectorFields.kinds.textContent = presentation.kindTotals
    .map(
      ({ kind, edgeCount, weight }) =>
        `${districtDependencyKindLabel(kind)}: ` +
        `${edgeCountLabel(edgeCount)}, ${referenceCountLabel(weight)}`,
    )
    .join(" · ");
  externalInspectorFields.consumerCount.textContent =
    (
      presentation.consumers.length +
      presentation.hiddenConsumerCount
    ).toLocaleString();
  externalInspectorFields.consumers.replaceChildren();
  for (const consumer of presentation.consumers) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = consumer.label;
    const weight = document.createElement("span");
    weight.textContent = referenceCountLabel(consumer.weight);
    const path = document.createElement("span");
    path.className = "external-consumer-path";
    path.textContent = consumer.path;
    item.append(label, weight, path);
    externalInspectorFields.consumers.append(item);
  }
  externalInspectorFields.omitted.hidden =
    presentation.hiddenConsumerCount === 0;
  externalInspectorFields.omitted.textContent =
    presentation.hiddenConsumerCount === 0
      ? ""
      : `${presentation.hiddenConsumerCount.toLocaleString()} more consumers · ` +
        referenceCountLabel(presentation.hiddenConsumerWeight);
  selectionStatus.textContent =
    `Selected external dependency ${presentation.label}. ` +
    `${referenceCountLabel(presentation.totalWeight)}.`;
}

function externalConsumerIdentity(
  sourceId: string,
): { readonly label: string; readonly path: string } | null | undefined {
  const isolatedDistrictId = explorerState.isolatedDistrictId;
  const building = activeBuildingsById.get(sourceId);
  if (building) {
    return isolatedDistrictId !== null &&
      building.districtId !== isolatedDistrictId
      ? null
      : { label: building.name, path: building.path };
  }

  const module = activeModel.modules.find(({ id }) => id === sourceId);
  if (!module) {
    return isolatedDistrictId === null ? undefined : null;
  }
  if (
    isolatedDistrictId !== null &&
    !activeModel.districts.some(
      ({ id, moduleId }) =>
        id === isolatedDistrictId && moduleId === module.id,
    )
  ) {
    return null;
  }
  return { label: module.name, path: module.path };
}

function renderExecutableUnits(building: CityBuilding): void {
  const presentation = presentExecutableUnits(building.units, {
    visibleLimit: executableUnitVisibleLimit,
  });
  const wasOpen = inspectorFields.unitsDetails.open;
  inspectorFields.units.replaceChildren();
  inspectorFields.unitsDetails.hidden = presentation === null;
  inspectorFields.unitsEmpty.hidden = presentation !== null;
  inspectorFields.unitCount.hidden = presentation === null;
  inspectorFields.unitsShowMore.hidden =
    presentation === null ||
    !canRevealMoreExecutableUnits(presentation);

  if (!presentation) {
    inspectorFields.unitsDetails.open = false;
    inspectorFields.unitCount.textContent = "";
    inspectorFields.unitsSummary.textContent = "";
    inspectorFields.unitsCaption.textContent = "";
    inspectorFields.unitsShowMore.textContent = "Show more units";
    return;
  }

  const count = presentation.count.toLocaleString();
  const unitLabel = presentation.count === 1 ? "unit" : "units";
  const maximumComplexity =
    presentation.maximumComplexity.toLocaleString();
  inspectorFields.unitsDetails.open = wasOpen;
  inspectorFields.unitCount.textContent = count;
  const cappedOmission =
    presentation.hiddenCount > 0 &&
    !canRevealMoreExecutableUnits(presentation);
  inspectorFields.unitsSummary.textContent =
    `${count} ${unitLabel} · highest complexity ${maximumComplexity}` +
    (presentation.hiddenCount > 0
      ? cappedOmission
        ? ` · showing first ${presentation.visibleCount.toLocaleString()}` +
          ` · ${presentation.hiddenCount.toLocaleString()} omitted at viewer limit`
        : ` · showing ${presentation.visibleCount.toLocaleString()}`
      : "");
  inspectorFields.unitsCaption.textContent =
    `Executable units for ${building.name}`;
  const nextRevealCount = Math.min(
    INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
    presentation.hiddenCount,
  );
  inspectorFields.unitsShowMore.textContent =
    `Show ${nextRevealCount.toLocaleString()} more` +
    ` (${presentation.hiddenCount.toLocaleString()} remaining)`;

  for (const unit of presentation.rows) {
    const row = document.createElement("tr");
    const name = document.createElement("th");
    name.className = "unit-name";
    name.scope = "row";
    name.textContent = unit.name;

    const complexity = document.createElement("td");
    complexity.className = "unit-number";
    complexity.textContent = unit.complexity.toLocaleString();

    const line = document.createElement("td");
    line.className = "unit-number";
    const jump = document.createElement("button");
    jump.className = "unit-source-jump";
    jump.type = "button";
    jump.textContent = unit.line.toLocaleString();
    jump.title = `Open ${unit.name} at line ${unit.line.toLocaleString()}`;
    jump.addEventListener("click", () => {
      revealBuildingSource(
        building,
        unit.line,
        unit.endLine ?? unit.line,
      );
    });
    line.append(jump);

    row.append(name, complexity, line);
    inspectorFields.units.append(row);
  }
}

function languageLabel(language: CityBuilding["language"]): string {
  switch (language) {
    case "csharp":
      return "C#";
    case "javascript":
      return "JavaScript";
    case "typescript":
      return "TypeScript";
  }
}

function setStatus(message: string): void {
  statusElement.textContent = message;
}

function showError(message: string): void {
  errorMessage.textContent = message;
  errorBanner.hidden = false;
  setStatus("Current model remains open");
}

function hideError(): void {
  errorBanner.hidden = true;
  errorMessage.textContent = "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makePanelLabel(
  title: string,
  version: string | undefined,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1_024;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is unavailable");
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#06121f";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font =
    '700 88px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  context.fillText(title, canvas.width / 2, version ? 102 : 128, 900);
  if (version) {
    context.fillStyle = "#18354a";
    context.font =
      '600 40px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    context.fillText(version, canvas.width / 2, 186, 850);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (
      child instanceof THREE.Mesh ||
      child instanceof THREE.LineSegments ||
      child instanceof THREE.GridHelper
    ) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      materials.forEach((material) => {
        if ("map" in material && material.map instanceof THREE.Texture) {
          material.map.dispose();
        }
        material.dispose();
      });
    }
  });
}

function element<T extends HTMLElement>(id: string): T {
  const item = document.getElementById(id);
  if (!item) {
    throw new Error(`Missing required element #${id}`);
  }
  return item as T;
}
