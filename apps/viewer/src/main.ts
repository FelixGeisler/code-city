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
import {
  DESIGN_SMELL_PROTOCOL_VERSION,
  type DesignSmellEvaluation,
  type DesignSmellFinding,
} from "../../../packages/core/src/design-smells.js";
import {
  applySafeExtensionEvaluation,
  type ExtensionEvaluation,
} from "../../../packages/core/src/extensions.js";
import type { PrinterProfile } from "../../../packages/core/src/print.js";
import {
  installAdvancedQueryPanel,
  type AdvancedQueryPanelController,
} from "./advanced-query-panel.js";
import type {
  AdvancedQueryChangeKind,
  AdvancedQueryContext,
} from "./advanced-query.js";
import type {
  AdvancedSelectionIntent,
  AdvancedSelectionState,
} from "./advanced-selection.js";
import {
  canRevealMoreExecutableUnits,
  INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  presentBuildingComplexity,
  type BuildingComplexityPresentation,
  type ExecutableUnitSort,
} from "./building-inspector.js";
import {
  cameraOrientationForPreset,
  orthographicCameraDistanceForBounds,
  orthographicViewHeightForOrientedBounds,
  perspectiveDistanceForViewHeight,
  perspectiveViewHeightAtDistance,
  type CameraOrientation,
  type CameraPreset,
  type CameraProjection,
} from "./camera-presets.js";
import {
  cameraNavigationProfile,
  type CameraNavigationMode,
} from "./camera-navigation.js";
import {
  FINE_DETAIL_INITIAL_LIMIT,
  FINE_DETAIL_MAXIMUM_LIMIT,
  projectFineDetail,
  type FineDetailNode,
} from "./progressive-granularity.js";
import { cityBaseForModel } from "./city-surface.js";
import {
  createDependencyExplorerIndex,
  DEPENDENCY_ROUTES_PER_DIRECTION,
  dependencyRoutesForBuilding,
  dependencyRoutesForBuildings,
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
} from "./district-dependency-layout.js";
import {
  type DependencyOverlayRoute,
  type DependencyRouteOverlayDiagnostics,
  DependencyRouteOverlay,
} from "./dependency-overlay.js";
import {
  buildingRouteEndpoint,
  type RouteEndpointGeometry,
} from "./dependency-route-layout.js";
import { DEMO_MODEL } from "./demo-model.js";
import {
  EvolutionRemovalLayer,
  type EvolutionRemovalDiagnostics,
} from "./evolution-removal-layer.js";
import { presentExternalDependency } from "./external-dependency-inspector.js";
import {
  drawImageExportOverlay,
  flipRgbaRows,
  imageExportFileName,
  validateImageExportLegend,
  validateImageExportResolution,
  type ImageExportLegendEntry,
  type ImageExportOverlay,
  type ImageExportProjectedLabel,
  type ImageExportRequest,
  type ValidatedImageExportResolution,
} from "./image-export.js";
import {
  installImageExportDialog,
  type PreparedImageExport,
} from "./image-export-dialog.js";
import { installProjectImportDialog } from "./project-import-dialog.js";
import { installPrintExportDialog } from "./print-export-dialog.js";
import {
  createLargeCityFixture,
  LARGE_CITY_FIXTURE_NAME,
} from "./large-city-fixture.js";
import { installMetricMappingPanel } from "./metric-mapping-panel.js";
import { installDesignSmellPanel } from "./design-smell-panel.js";
import {
  createDesignSmellBuildingVisualization,
  DESIGN_SMELL_BUILDING_LEGEND,
  designSmellBuildingDiagnostics,
  type DesignSmellBuildingDiagnostics,
  type DesignSmellBuildingVisualization,
} from "./design-smell-visualization.js";
import {
  installSafeExtensionPanel,
  type SafeExtensionPanelController,
} from "./safe-extension-panel.js";
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
import {
  ViewerImportApiClient,
  type ViewerAiGuidanceContext,
} from "./import-api.js";
import { AiProviderDiscoveryController } from "./ai-provider-discovery.js";
import {
  codeInspectionAiContext,
  codeInspectionFocusKey,
  fileInspectionFocus,
  INITIAL_DECISION_SITE_VISIBLE_LIMIT,
  MAXIMUM_DECISION_SITE_VISIBLE_LIMIT,
  presentDecisionEvidence,
  resolveCodeInspectionFocus,
  unitInspectionFocus,
  type CodeInspectionFocus,
} from "./code-inspection.js";
import {
  extractSourceLineWindow,
  loadBuildingSource,
  presentHighlightedSourceLine,
  sourceOmissionMarker,
  SOURCE_RENDERED_CHARACTER_LIMIT,
  SOURCE_RENDERED_TOKEN_LIMIT,
  sourceOwnerAfterResultRemoval,
  type BuildingSource,
} from "./source-navigation.js";
import {
  createRepositoryExplorerIndex,
  DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT,
  type ExplorerState,
  MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT,
  resetExplorerState,
  searchRepositoryEntities,
  selectedExplorerBuildingId,
  selectedExplorerDistrictId,
  selectedExplorerExternalId,
  selectExplorerBuilding,
  selectExplorerDistrict,
} from "./repository-explorer.js";
import {
  installRepositoryHierarchyTree,
  repositoryHierarchyProjectKey,
} from "./repository-hierarchy-tree.js";
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
  boxBounds,
  createSemanticSceneBounds,
} from "./semantic-scene-bounds.js";
import {
  DEFAULT_FOG_DENSITY,
  fogDensityForCameraDistance,
} from "./scene-environment.js";
import { groundGridLayout } from "./scene-grid.js";
import {
  cameraDistanceForBounds,
  cameraMaximumDistanceForFrame,
  semanticPickingEnabled,
  type ScenePresentationMode,
} from "./scene-navigation.js";
import {
  installViewerWorkspace,
  nextBoundedResultLimit,
  type ViewerWorkspaceState,
} from "./viewer-workspace.js";
import { summarizeViewerOverview } from "./viewer-overview.js";
import {
  assertViewerBuildingCapability,
  ViewerBuildingLayer,
  type ViewerBuildingDefinition,
  type ViewerBuildingRenderMode,
} from "./viewer-building-layer.js";
import { ViewerFramePicker } from "./viewer-frame-picker.js";
import { supportsViewerInstancing } from "./viewer-render-capability.js";
import {
  availableViewerVisualizationModes,
  createViewerVisualization,
  presentBuildingMetrics,
  viewerVisualizationModeLabel,
  type EvolutionVisualizationData,
  type ViewerVisualizationMode,
} from "./visualization-mode.js";
import {
  createEvolutionBuildingLineageSelection,
  EvolutionDeferredSeekController,
  resolveEvolutionBuildingLineage,
  type EvolutionBuildingHistory,
  type EvolutionBuildingLineageSelection,
  type EvolutionBuildingLineageState,
  type EvolutionDependencyChanges,
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
  readonly fromUp: THREE.Vector3;
  readonly toPosition: THREE.Vector3;
  readonly toTarget: THREE.Vector3;
  readonly toUp: THREE.Vector3;
  readonly fromOrthographicViewHeight?: number;
  readonly toOrthographicViewHeight?: number;
}

interface SceneImageExport {
  readonly blob: Blob;
  readonly resolution: ValidatedImageExportResolution;
}

interface ExportCameraFrame {
  readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  readonly target: THREE.Vector3;
}

interface ModelSource {
  readonly label: string;
  readonly assetRoot?: URL;
  readonly jobId?: string;
  readonly sourceAvailability?:
    | "disabled"
    | "model-only"
    | "not-captured"
    | "removed"
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
  readonly removals: EvolutionRemovalLayer;
}

interface ViewerPerformanceDiagnostics {
  readonly buildingRenderMode: ViewerBuildingRenderMode | null;
  readonly buildingBatchCount: number;
  readonly visibleBuildingCount: number;
  readonly buildingVisibilityMaskActive: boolean;
  readonly objectCount: number;
  readonly renderCalls: number;
  readonly camera: {
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
    readonly up: readonly [number, number, number];
    readonly projection: CameraProjection;
    readonly navigationMode: CameraNavigationMode;
    readonly zoom: number;
    readonly viewHeight: number;
  };
  readonly evolutionRemovals: EvolutionRemovalDiagnostics | null;
  readonly evolutionRemovalAnimated: boolean;
  readonly dependencyRoutes: DependencyRouteOverlayDiagnostics;
  readonly districtDependencyRoutes: DependencyRouteOverlayDiagnostics;
  readonly designSmells: DesignSmellBuildingDiagnostics;
  readonly pickBenchmark: {
    readonly count: number;
    readonly p95Milliseconds: number;
    readonly maximumAabbTests: number;
  };
}

const EMPTY_DEPENDENCY_ROUTE_DIAGNOSTICS: DependencyRouteOverlayDiagnostics =
  Object.freeze({
    routeCount: 0,
    gatewayCount: 0,
    routes: Object.freeze([]),
  });
const EMPTY_DESIGN_SMELL_DIAGNOSTICS: DesignSmellBuildingDiagnostics =
  Object.freeze({
    active: false,
    requestedFindings: 0,
    validFindings: 0,
    buildingCount: 0,
    affectedBuildings: 0,
    coloredBuildings: 0,
    severityBuildings: Object.freeze({
      moderate: 0,
      high: 0,
      critical: 0,
    }),
  });

declare global {
  interface Window {
    __CODE_CITY_PERFORMANCE__?: ViewerPerformanceDiagnostics & {
      readonly ready: true;
      readonly firstInteractiveMilliseconds: number;
      readonly evolutionFrameIndex: number;
    };
  }
}

const INITIAL_ROUTE_RESULT_LIMIT = 8;
const EVOLUTION_DEPENDENCY_ROUTE_COLOR = "#f472b6";

const sceneHost = element<HTMLDivElement>("scene");
let synchronizeHierarchyWorkspace = (
  _state: ViewerWorkspaceState,
): void => {};
let synchronizeFindingsWorkspace = (
  _state: ViewerWorkspaceState,
): void => {};
const viewerWorkspace = installViewerWorkspace(
  element<HTMLElement>("viewer-workspace"),
  element<HTMLElement>("viewer-workspace-scroll"),
  {
    onStateChange: (state) => {
      synchronizeHierarchyWorkspace(state);
      synchronizeFindingsWorkspace(state);
    },
  },
);
const fileInput = element<HTMLInputElement>("model-file");
const fileOpenButton = element<HTMLButtonElement>("model-file-open");
const demoButton = element<HTMLButtonElement>("demo-button");
const imageExportOpenButton =
  element<HTMLButtonElement>("image-export-open");
const printExportOpenButton =
  element<HTMLButtonElement>("print-export-open");
const projectActionsMenu =
  element<HTMLDetailsElement>("project-actions-menu");
const projectActionsSummary = projectActionsMenu.querySelector<HTMLElement>(
  "summary",
);
if (projectActionsSummary === null) {
  throw new Error("Missing Project menu summary.");
}
const exportActionsMenu =
  element<HTMLDetailsElement>("export-actions-menu");
const exportActionsSummary = exportActionsMenu.querySelector<HTMLElement>(
  "summary",
);
if (exportActionsSummary === null) {
  throw new Error("Missing Export menu summary.");
}
const advancedProjectSettingsOpen = element<HTMLButtonElement>(
  "advanced-project-settings-open",
);
const advancedProjectSettingsDialog = element<HTMLDialogElement>(
  "advanced-project-settings-dialog",
);
const advancedProjectSettingsClose = element<HTMLButtonElement>(
  "advanced-project-settings-close",
);
const cameraFitCityButton =
  element<HTMLButtonElement>("camera-fit-city");
const cameraFocusSelectionButton =
  element<HTMLButtonElement>("camera-focus-selection");
const cameraControlsHint =
  element<HTMLParagraphElement>("camera-controls-hint");
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
const legend = element<HTMLUListElement>("legend");
const visualizationModeSelect =
  element<HTMLSelectElement>("visualization-mode");
const visualizationModeField = (() => {
  const field = visualizationModeSelect.closest<HTMLElement>("label");
  if (field === null) {
    throw new Error("Missing visualization mode field.");
  }
  return field;
})();
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
const advancedQueryIsolateButton = element<HTMLButtonElement>(
  "advanced-query-isolate",
);
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
const repositoryTree = element<HTMLElement>("repository-tree");
const repositoryTreeStatus = element<HTMLElement>(
  "repository-tree-status",
);
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
const inspectorFields = {
  codeInspection: element<HTMLElement>("building-code-inspection"),
  name: element<HTMLHeadingElement>("building-name"),
  repository: element<HTMLElement>("building-repository"),
  module: element<HTMLElement>("building-module"),
  path: element<HTMLElement>("building-path"),
  language: element<HTMLElement>("building-language"),
  metricExplanation: element<HTMLParagraphElement>(
    "building-metric-explanation",
  ),
  metricPresentation: element<HTMLElement>("building-metric-presentation"),
  metricRows: element<HTMLDListElement>("building-metric-rows"),
  metricTechnicalDetails: element<HTMLDetailsElement>(
    "building-metric-technical-details",
  ),
  metricTechnical: element<HTMLDListElement>("building-metric-technical"),
  hotspotsSection: element<HTMLElement>("building-hotspots-section"),
  hotspotsCount: element<HTMLElement>("building-hotspots-count"),
  hotspotsStatus: element<HTMLParagraphElement>("building-hotspots-status"),
  hotspots: element<HTMLOListElement>("building-hotspots"),
  hotspotsSourceNote: element<HTMLParagraphElement>(
    "building-hotspots-source-note",
  ),
  evolutionRow: element<HTMLElement>("building-evolution-row"),
  evolution: element<HTMLElement>("building-evolution"),
  unitCount: element<HTMLElement>("building-unit-count"),
  unitsEmpty: element<HTMLParagraphElement>("building-units-empty"),
  unitsDetails: element<HTMLDetailsElement>("building-units-details"),
  unitsSummary: element<HTMLElement>("building-units-summary"),
  unitsCaption: element<HTMLTableCaptionElement>("building-units-caption"),
  units: element<HTMLTableSectionElement>("building-units"),
  unitsSearch: element<HTMLInputElement>("building-units-search"),
  unitsSort: element<HTMLSelectElement>("building-units-sort"),
  unitsFilterStatus: element<HTMLParagraphElement>(
    "building-units-filter-status",
  ),
  unitsShowMore: element<HTMLButtonElement>("building-units-show-more"),
  sourceOpen: element<HTMLButtonElement>("building-source-open"),
  sourceStructureDetails: element<HTMLDetailsElement>("building-source-structure-details"),
  sourceStructureSummary: element<HTMLElement>("building-source-structure-summary"),
  sourceStructureStatus: element<HTMLParagraphElement>("building-source-structure-status"),
  sourceStructure: element<HTMLOListElement>("building-source-structure"),
  sourceStructureShowMore: element<HTMLButtonElement>("building-source-structure-show-more"),
  sourceStructureReturn: element<HTMLButtonElement>("building-source-structure-return"),
  sourceDetails: element<HTMLDetailsElement>("building-source-details"),
  sourceSummary: element<HTMLElement>("building-source-summary"),
  sourceStatus: element<HTMLParagraphElement>("building-source-status"),
  sourceContent: element<HTMLDivElement>("building-source-content"),
  sourcePath: element<HTMLElement>("building-source-path"),
  sourceRevision: element<HTMLElement>("building-source-revision"),
  sourceExternal: element<HTMLAnchorElement>("building-source-external"),
  sourceEditor: element<HTMLAnchorElement>("building-source-editor"),
  sourceCode: element<HTMLPreElement>("building-source-code"),
  decisionEvidence: element<HTMLElement>("building-decision-evidence"),
  decisionEvidenceEquation: element<HTMLElement>("building-decision-evidence-equation"),
  decisionEvidenceStatus: element<HTMLParagraphElement>("building-decision-evidence-status"),
  decisionSites: element<HTMLOListElement>("building-decision-sites"),
  decisionSitesShowMore: element<HTMLButtonElement>("building-decision-sites-show-more"),
  aiDetails: element<HTMLDetailsElement>("building-ai-guidance-details"),
  aiSummary: element<HTMLElement>("building-ai-guidance-summary"),
  aiStatus: element<HTMLParagraphElement>("building-ai-guidance-status"),
  aiProviderLabel: element<HTMLLabelElement>("building-ai-guidance-provider-label"),
  aiProvider: element<HTMLSelectElement>("building-ai-guidance-provider"),
  aiPrepare: element<HTMLButtonElement>("building-ai-guidance-prepare"),
  aiPreview: element<HTMLPreElement>("building-ai-guidance-preview"),
  aiRequest: element<HTMLButtonElement>("building-ai-guidance-request"),
  aiSuggestions: element<HTMLUListElement>("building-ai-guidance-suggestions"),
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
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(
    45,
    1,
    0.1,
    5_000,
  );
  private readonly orthographicCamera = new THREE.OrthographicCamera(
    -10,
    10,
    10,
    -10,
    0.1,
    5_000,
  );
  private camera:
    | THREE.OrthographicCamera
    | THREE.PerspectiveCamera = this.perspectiveCamera;
  private readonly renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
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
  private readonly webglRuntimeStatus = document.createElement("p");
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
  private readonly semanticCityBounds = new THREE.Box3();
  private readonly semanticDistrictBounds = new Map<string, THREE.Box3>();
  private readonly semanticExternalBounds = new THREE.Box3();
  private readonly resizeObserver: ResizeObserver;
  private readonly pointerPicker: ViewerFramePicker<
    PointerPosition,
    SceneEntity | null
  >;
  private buildingLayer: ViewerBuildingLayer | null = null;
  private grid: THREE.GridHelper | null = null;
  private hoveredEntity: SceneEntity | null = null;
  private selectedEntity: SceneEntity | null = null;
  private buildingVisibilityMask: ReadonlySet<string> | null = null;
  private cameraTransition: CameraTransition | null = null;
  private cameraNavigationMode: CameraNavigationMode = "orbit";
  private orbitOrientationBeforeTopDown: CameraOrientation | null = null;
  private topDownTargetY: number | null = null;
  private evolutionAnimation: SceneEvolutionAnimation | null = null;
  private orthographicViewHeight = 20;
  private webglContextAvailable = true;
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
    private readonly onPointerSelection?: (
      entity: SceneEntity | null,
      intent: AdvancedSelectionIntent,
    ) => boolean,
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
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D code city",
    );
    this.webglRuntimeStatus.className = "webgl-runtime-status";
    this.webglRuntimeStatus.setAttribute("role", "alert");
    this.webglRuntimeStatus.setAttribute("aria-atomic", "true");
    this.webglRuntimeStatus.hidden = true;
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        this.webglContextAvailable = false;
        this.host.dataset["webglAvailable"] = "false";
        imageExportOpenButton.disabled = true;
        imageExportOpenButton.title =
          "Image export is unavailable while the WebGL context is lost.";
        cameraFitCityButton.disabled = true;
        cameraFocusSelectionButton.disabled = true;
        this.renderer.domElement.setAttribute(
          "aria-label",
          "Interactive 3D code city unavailable because the WebGL context was lost",
        );
        this.webglRuntimeStatus.hidden = false;
        this.webglRuntimeStatus.textContent =
          "The WebGL context was lost. Restore hardware acceleration or reload the page before using the 3D viewer or image export.";
      },
    );
    this.renderer.domElement.addEventListener(
      "webglcontextrestored",
      () => {
        this.webglContextAvailable = true;
        this.host.dataset["webglAvailable"] = "true";
        imageExportOpenButton.disabled = false;
        imageExportOpenButton.title = "";
        cameraFitCityButton.disabled = false;
        synchronizeCameraFocusControl();
        this.renderer.domElement.setAttribute(
          "aria-label",
          "Interactive 3D code city",
        );
        this.webglRuntimeStatus.textContent = "";
        this.webglRuntimeStatus.hidden = true;
      },
    );
    this.host.dataset["webglAvailable"] = "true";
    this.host.append(this.renderer.domElement, this.webglRuntimeStatus);

    this.camera.position.set(25, 22, 28);
    this.orthographicCamera.position.copy(this.camera.position);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 2;
    this.applyCameraNavigationProfile("orbit");
    this.controls.addEventListener("start", () => {
      if (
        this.cameraNavigationMode === "top-down" &&
        this.cameraTransition !== null
      ) {
        this.completeCameraTransition();
      } else {
        this.cameraTransition = null;
      }
    });
    this.controls.addEventListener("end", schedulePerformanceDiagnostics);

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
    this.updateSemanticBounds(model, base, externalNodes);
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

  public get projection(): CameraProjection {
    return this.camera === this.orthographicCamera
      ? "orthographic"
      : "perspective";
  }

  public get navigationMode(): CameraNavigationMode {
    return this.cameraNavigationMode;
  }

  public get selectedEntityAvailable(): boolean {
    return this.selectedEntity !== null;
  }

  public fitCity(animate = true): boolean {
    this.ensureCityPresentation();
    const bounds = this.bounds();
    if (bounds === undefined || bounds.isEmpty()) return false;
    this.frameBounds(bounds, animate);
    return true;
  }

  public focusSelectedEntity(animate = true): boolean {
    this.ensureCityPresentation();
    const bounds = this.selectedEntityBounds();
    if (bounds === undefined || bounds.isEmpty()) return false;
    this.frameBounds(bounds, animate);
    return true;
  }

  public setProjection(projection: CameraProjection): void {
    if (projection === this.projection) return;
    if (
      this.cameraNavigationMode === "top-down" &&
      this.cameraTransition !== null
    ) {
      this.completeCameraTransition();
    } else {
      this.cameraTransition = null;
    }
    const target = this.controls.target.clone();
    const direction = this.camera.position.clone().sub(target);
    if (direction.lengthSq() < 1e-12) direction.set(1, 1, 1);
    direction.normalize();
    const currentDistance = Math.max(
      this.camera.position.distanceTo(target),
      0.01,
    );

    if (projection === "orthographic") {
      this.orthographicViewHeight = perspectiveViewHeightAtDistance(
        currentDistance,
        this.perspectiveCamera.fov,
      );
      this.orthographicCamera.position.copy(this.camera.position);
      this.orthographicCamera.up.copy(this.camera.up);
      this.orthographicCamera.near = this.camera.near;
      this.orthographicCamera.far = this.camera.far;
      this.orthographicCamera.zoom = 1;
      this.camera = this.orthographicCamera;
    } else {
      const effectiveViewHeight =
        this.orthographicViewHeight /
        Math.max(this.orthographicCamera.zoom, 1e-6);
      const distance = perspectiveDistanceForViewHeight(
        effectiveViewHeight,
        this.perspectiveCamera.fov,
      );
      this.perspectiveCamera.position
        .copy(target)
        .addScaledVector(direction, distance);
      this.perspectiveCamera.up.copy(this.camera.up);
      this.perspectiveCamera.near = Math.max(distance / 1_000, 0.01);
      this.perspectiveCamera.far = Math.max(
        distance * 20,
        this.fullCityFar,
      );
      this.controls.maxDistance = cameraMaximumDistanceForFrame(
        this.fullCityMaxDistance,
        distance,
      );
      this.camera = this.perspectiveCamera;
    }
    this.controls.object = this.camera;
    this.updateCameraProjection(
      Math.max(1, this.host.clientWidth),
      Math.max(1, this.host.clientHeight),
    );
    this.controls.update();
    this.enforceTopDownNavigationPlane();
    this.updateFog();
    schedulePerformanceDiagnostics();
  }

  public applyCameraPreset(
    preset: CameraPreset,
    animate = true,
  ): boolean {
    this.ensureCityPresentation();
    if (preset === "whole-city") {
      this.showAllBuildings(false);
    }
    const bounds = this.boundsForPreset(preset);
    if (bounds === undefined || bounds.isEmpty()) return false;
    const restoredOrbitOrientation =
      preset === "top-down"
        ? (this.prepareTopDownNavigation(), undefined)
        : this.leaveTopDownNavigation();
    const orientation =
      restoredOrbitOrientation !== undefined &&
      (preset === "selected-entity" || preset === "whole-city")
        ? restoredOrbitOrientation
        : cameraOrientationForPreset(
            preset,
            this.camera.position.clone().sub(this.controls.target),
            this.camera.up,
          );
    this.frameBounds(bounds, animate, false, orientation);
    return true;
  }

  public async exportPng(
    request: ImageExportRequest,
    overlay: Omit<ImageExportOverlay, "labels" | "legend"> & {
      readonly legend: readonly ImageExportLegendEntry[];
    },
  ): Promise<SceneImageExport> {
    const resolution = validateImageExportResolution(
      request.width,
      request.height,
      this.imageExportCapabilities(),
    );
    const legend = request.includeLegend ? overlay.legend : [];
    validateImageExportLegend(
      legend,
      resolution.width,
      resolution.height,
    );
    this.ensureCityPresentation();
    this.clearEvolutionAnimation();
    const restoreVisibility =
      request.camera.mode === "custom" &&
      request.camera.fit === "whole-city"
        ? this.temporarilyShowAllBuildings()
        : () => undefined;
    let pixels: Uint8Array;
    let labels: readonly ImageExportProjectedLabel[];
    try {
      const aspect = resolution.width / resolution.height;
      const frame =
        request.camera.mode === "current-view"
          ? this.createCurrentExportCamera(aspect)
          : this.createCustomExportCamera(request.camera, aspect);
      labels = request.includeLabels
        ? this.projectExportLabels(
            frame.camera,
            resolution.width,
            resolution.height,
          )
        : [];
      pixels = this.renderExportPixels(
        frame.camera,
        frame.target,
        resolution,
        request.background,
      );
    } finally {
      restoreVisibility();
    }
    const blob = await this.composeExportPng(pixels, resolution, {
      ...overlay,
      labels,
      legend,
    });
    return { blob, resolution };
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
      this.frameBounds(this.bounds(), true);
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

  public setBuildingGroupHighlight(
    buildingIds: readonly string[],
    visible = true,
    color?: string,
  ): void {
    this.buildingLayer?.setGroupHighlight(
      visible ? buildingIds : [],
      color,
    );
  }

  public get buildingSelectionIsolated(): boolean {
    return this.buildingVisibilityMask !== null;
  }

  public focusBuildings(buildingIds: readonly string[]): boolean {
    const bounds = this.buildingLayer?.selectionBounds(buildingIds);
    if (bounds === undefined || bounds.isEmpty()) return false;
    this.ensureCityPresentation();
    this.frameBounds(bounds, true);
    return true;
  }

  public isolateBuildings(
    buildingIds: readonly string[],
    focus = true,
  ): boolean {
    const valid = new Set<string>();
    for (const id of buildingIds) {
      if (this.buildingContexts.has(id)) valid.add(id);
    }
    if (valid.size === 0) return false;
    this.ensureCityPresentation();
    this.hover(null);
    this.buildingVisibilityMask = valid;
    const visibleBuildingIds = [...valid];
    this.buildingLayer?.setVisibleBuildingIds(visibleBuildingIds);
    this.evolutionAnimation?.removals.setVisibleBuildingIds(
      visibleBuildingIds,
    );
    const selection = this.selectedEntity;
    if (
      selection?.kind === "building" &&
      !valid.has(selection.id)
    ) {
      this.select(null);
    }
    if (focus) this.focusBuildings([...valid]);
    this.emitState();
    schedulePerformanceDiagnostics();
    return true;
  }

  public showEvolutionTransition(
    transition: EvolutionTransition,
    reducedMotion: boolean,
  ): void {
    this.clearEvolutionAnimation();
    const removals = new EvolutionRemovalLayer(
      transition.removedBuildings,
      { instancingSupported: this.instancingSupported },
    );
    removals.setVisibleBuildingIds(
      this.buildingVisibilityMask === null
        ? null
        : [...this.buildingVisibilityMask],
    );
    this.city.add(removals.object);
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
      removals,
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
    const bounds = this.bounds();
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
    schedulePerformanceDiagnostics();
  }

  public replaceDistrictDependencyRoutes(
    routes: readonly DependencyOverlayRoute[],
  ): void {
    this.districtDependencyOverlay.replace(routes);
    if (this.prePrintOverlayVisibility !== undefined) {
      this.prePrintOverlayVisibility.districtDependencies =
        routes.length > 0;
    }
    schedulePerformanceDiagnostics();
  }

  public selectBuilding(
    id: string,
    focus = false,
    showDetails = true,
  ): boolean {
    const context = this.buildingContexts.get(id);
    if (!context) {
      return false;
    }
    this.ensureCityPresentation();
    if (
      this.buildingVisibilityMask !== null &&
      !this.buildingVisibilityMask.has(id)
    ) {
      this.clearBuildingVisibilityMask();
    }
    this.select(createSceneEntity("building", id), showDetails);
    if (focus) {
      this.focusBuilding(id);
    }
    return true;
  }

  public selectDistrict(
    id: string,
    focus = false,
    showDetails = true,
  ): boolean {
    const group = this.districtGroups.get(id);
    if (!group || !this.districtContexts.has(id)) {
      return false;
    }
    this.ensureCityPresentation();
    this.clearBuildingVisibilityMask();
    this.select(createSceneEntity("district", id), showDetails);
    if (focus) {
      this.frameDistrict(id, true);
    }
    return true;
  }

  public selectExternalNode(id: string, focus = false): boolean {
    const mesh = this.externalMeshes.get(id);
    if (!mesh) {
      return false;
    }
    this.ensureCityPresentation();
    this.clearBuildingVisibilityMask();
    this.select(createSceneEntity("external", id));
    if (focus) {
      this.frameObject(mesh, true);
    }
    return true;
  }

  public showAllBuildings(frame = true): void {
    this.ensureCityPresentation();
    this.clearBuildingVisibilityMask();
    if (frame) this.frameBounds(this.bounds(), true);
    this.emitState();
    schedulePerformanceDiagnostics();
  }

  private clearBuildingVisibilityMask(): void {
    if (this.buildingVisibilityMask === null) return;
    this.buildingVisibilityMask = null;
    this.buildingLayer?.setVisibleBuildingIds(null);
    this.evolutionAnimation?.removals.setVisibleBuildingIds(null);
  }

  public assertBuildingCapability(buildingCount: number): void {
    assertViewerBuildingCapability(
      buildingCount,
      this.instancingSupported,
    );
  }

  public performanceDiagnostics(): ViewerPerformanceDiagnostics {
    this.controls.update();
    this.enforceTopDownNavigationPlane();
    this.updateFog();
    this.renderer.render(this.scene, this.camera);
    let objectCount = 0;
    this.scene.traverse(() => {
      objectCount += 1;
    });
    return Object.freeze({
      buildingRenderMode: this.buildingLayer?.mode ?? null,
      buildingBatchCount: this.buildingLayer?.batchCount ?? 0,
      visibleBuildingCount:
        this.buildingLayer?.visibleBuildingCount ?? 0,
      buildingVisibilityMaskActive:
        this.buildingVisibilityMask !== null,
      objectCount,
      renderCalls: this.renderer.info.render.calls,
      camera: {
        position: [this.camera.position.x, this.camera.position.y, this.camera.position.z] as const,
        target: [this.controls.target.x, this.controls.target.y, this.controls.target.z] as const,
        up: [this.camera.up.x, this.camera.up.y, this.camera.up.z] as const,
        projection: this.projection,
        navigationMode: this.cameraNavigationMode,
        zoom: this.camera.zoom,
        viewHeight:
          this.camera === this.orthographicCamera
            ? this.orthographicViewHeight /
              Math.max(this.orthographicCamera.zoom, 1e-6)
            : perspectiveViewHeightAtDistance(
                Math.max(
                  this.perspectiveCamera.position.distanceTo(
                    this.controls.target,
                  ),
                  0.01,
                ),
                this.perspectiveCamera.fov,
              ),
      },
      evolutionRemovals:
        this.evolutionAnimation?.removals.diagnostics() ?? null,
      evolutionRemovalAnimated:
        this.evolutionAnimation !== null &&
        Number.isFinite(this.evolutionAnimation.durationMs),
      dependencyRoutes: this.dependencyOverlay.diagnostics(),
      districtDependencyRoutes:
        this.districtDependencyOverlay.diagnostics(),
      designSmells: EMPTY_DESIGN_SMELL_DIAGNOSTICS,
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
    this.enforceTopDownNavigationPlane();
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
    this.updateCameraProjection(width, height);
    this.renderer.setSize(width, height, false);
  }

  private clear(): void {
    this.clearEvolutionAnimation();
    this.hover(null);
    this.pointerPicker.cancel();
    this.sceneLabelOverlay.clear();
    this.dependencyOverlay.clear();
    this.districtDependencyOverlay.clear();
    this.buildingVisibilityMask = null;
    this.cameraTransition = null;
    this.select(null);
    this.buildingContexts.clear();
    this.districtMeshes.clear();
    this.districtContexts.clear();
    this.externalMeshes.clear();
    this.externalNodes.clear();
    this.districtGroups.clear();
    this.semanticCityBounds.makeEmpty();
    this.semanticDistrictBounds.clear();
    this.semanticExternalBounds.makeEmpty();
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
    animation.removals.setProgress(eased);
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
    this.city.remove(animation.removals.object);
    animation.removals.dispose();
  }

  private clearPrintPlate(): void {
    for (const child of [...this.printPlate.children]) {
      this.printPlate.remove(child);
      disposeObject(child);
    }
  }

  private bounds(): THREE.Box3 {
    const bounds = this.semanticCityBounds.clone();
    if (bounds.isEmpty()) {
      bounds.set(
        new THREE.Vector3(-5, 0, -5),
        new THREE.Vector3(5, 5, 5),
      );
    }
    return bounds;
  }

  private updateSemanticBounds(
    model: CityModel,
    base: CityBase | undefined,
    externalNodes: readonly ExternalSceneNode[],
  ): void {
    const bounds = createSemanticSceneBounds(
      model,
      base,
      externalNodes,
    );
    this.semanticCityBounds.copy(bounds.city);
    this.semanticDistrictBounds.clear();
    this.semanticExternalBounds.makeEmpty();
    for (const [id, districtBounds] of bounds.districts) {
      this.semanticDistrictBounds.set(id, districtBounds.clone());
    }
    for (const node of externalNodes) {
      this.semanticExternalBounds.union(
        boxBounds(node.position, node.size),
      );
    }
  }

  private boundsForPreset(preset: CameraPreset): THREE.Box3 | undefined {
    if (preset === "selected-entity") {
      return this.selectedEntityBounds();
    }
    return this.bounds();
  }

  private selectedEntityBounds(): THREE.Box3 | undefined {
    const selected = this.selectedEntity;
    if (selected === null) return undefined;
    switch (selected.kind) {
      case "building":
        return this.buildingLayer?.bounds(selected.id);
      case "district":
        return this.districtFrameBounds(selected.id);
      case "external": {
        const node = this.externalNodes.get(selected.id);
        return node === undefined
          ? undefined
          : boxBounds(node.position, node.size);
      }
    }
  }

  private temporarilyShowAllBuildings(): () => void {
    const previousBuildingVisibilityMask =
      this.buildingVisibilityMask === null
        ? null
        : [...this.buildingVisibilityMask];
    this.buildingLayer?.setVisibleBuildingIds(null);
    this.evolutionAnimation?.removals.setVisibleBuildingIds(null);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      this.buildingLayer?.setVisibleBuildingIds(
        previousBuildingVisibilityMask,
      );
      this.evolutionAnimation?.removals.setVisibleBuildingIds(
        previousBuildingVisibilityMask,
      );
    };
  }

  private imageExportCapabilities(): {
    readonly maxRenderbufferSize: number;
    readonly maxTextureSize: number;
    readonly maxViewportWidth: number;
    readonly maxViewportHeight: number;
    readonly samples: number;
    readonly contextAvailable: boolean;
  } {
    const context = this.renderer.getContext();
    const contextAvailable =
      this.webglContextAvailable && !context.isContextLost();
    if (!contextAvailable) {
      return {
        maxRenderbufferSize: 0,
        maxTextureSize: 0,
        maxViewportWidth: 0,
        maxViewportHeight: 0,
        samples: 0,
        contextAvailable: false,
      };
    }
    const viewport = context.getParameter(
      context.MAX_VIEWPORT_DIMS,
    ) as Int32Array | number[] | null;
    return {
      maxRenderbufferSize: Number(
        context.getParameter(context.MAX_RENDERBUFFER_SIZE),
      ),
      maxTextureSize: Number(
        context.getParameter(context.MAX_TEXTURE_SIZE),
      ),
      maxViewportWidth: Number(viewport?.[0]),
      maxViewportHeight: Number(viewport?.[1]),
      samples: Number(context.getParameter(context.SAMPLES)),
      contextAvailable: true,
    };
  }

  private createCurrentExportCamera(aspect: number): ExportCameraFrame {
    const target = this.controls.target.clone();
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (this.camera === this.perspectiveCamera) {
      camera = this.perspectiveCamera.clone();
      camera.aspect = aspect;
    } else {
      const viewHeight =
        this.orthographicViewHeight /
        Math.max(this.orthographicCamera.zoom, 1e-6);
      const halfHeight = viewHeight / 2;
      const halfWidth = halfHeight * aspect;
      camera = new THREE.OrthographicCamera(
        -halfWidth,
        halfWidth,
        halfHeight,
        -halfHeight,
        this.camera.near,
        this.camera.far,
      );
    }
    camera.position.copy(this.camera.position);
    camera.up.copy(this.camera.up);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return { camera, target };
  }

  private createCustomExportCamera(
    request: Extract<
      ImageExportRequest["camera"],
      { readonly mode: "custom" }
    >,
    aspect: number,
  ): ExportCameraFrame {
    const bounds =
      request.fit === "selected-entity"
        ? this.selectedEntityBounds()
        : request.fit === "whole-city"
          ? this.bounds()
          : this.boundsForPreset("isometric");
    if (bounds === undefined || bounds.isEmpty()) {
      throw new Error(
        request.fit === "selected-entity"
          ? "Select a building, district, or external dependency before fitting the export to the selection."
          : "The requested camera frame is unavailable.",
      );
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const maximumDimension = Math.max(size.x, size.y, size.z, 1);
    const projection =
      request.lens === "current-view"
        ? this.projection
        : request.lens;
    const orientation = cameraOrientationForPreset(
      request.angle === "current-view" ? "whole-city" : request.angle,
      this.camera.position.clone().sub(this.controls.target),
      this.camera.up,
    );
    const distance =
      projection === "perspective"
        ? cameraDistanceForBounds(
            size,
            this.perspectiveCamera.fov,
            aspect,
          )
        : orthographicCameraDistanceForBounds(size);
    const near = Math.max(distance / 1_000, 0.01);
    const far = Math.max(distance * 20, maximumDimension * 20);
    const position = center
      .clone()
      .addScaledVector(orientation.direction, distance);
    const camera =
      projection === "perspective"
        ? new THREE.PerspectiveCamera(
            this.perspectiveCamera.fov,
            aspect,
            near,
            far,
          )
        : exportOrthographicCamera(
            size,
            aspect,
            near,
            far,
            orientation,
          );
    camera.position.copy(position);
    camera.up.copy(orientation.up);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return { camera, target: center };
  }

  private projectExportLabels(
    camera: THREE.Camera,
    width: number,
    height: number,
  ): readonly ImageExportProjectedLabel[] {
    const state = this.sceneLabelOverlay.snapshot();
    const labels = [state.selected, state.hovered].filter(
      (label, index, values): label is SceneLabel =>
        label !== null &&
        values.findIndex((candidate) => candidate?.id === label.id) ===
          index,
    );
    const projected: ImageExportProjectedLabel[] = [];
    for (const label of labels) {
      const world = new THREE.Vector3(
        label.position.x,
        label.position.y,
        label.position.z,
      );
      const cameraSpace = world
        .clone()
        .applyMatrix4(camera.matrixWorldInverse);
      if (cameraSpace.z >= 0) continue;
      const clip = world.project(camera);
      if (
        ![clip.x, clip.y, clip.z].every(Number.isFinite) ||
        clip.x < -1 ||
        clip.x > 1 ||
        clip.y < -1 ||
        clip.y > 1 ||
        clip.z < -1 ||
        clip.z > 1
      ) {
        continue;
      }
      projected.push({
        text: label.text,
        x: (clip.x * 0.5 + 0.5) * width,
        y: (-clip.y * 0.5 + 0.5) * height,
      });
    }
    return projected;
  }

  private renderExportPixels(
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    target: THREE.Vector3,
    resolution: ValidatedImageExportResolution,
    background: ImageExportRequest["background"],
  ): Uint8Array {
    const context = this.renderer.getContext();
    if (
      !this.webglContextAvailable ||
      context.isContextLost()
    ) {
      throw new Error(
        "Image export is unavailable because the WebGL context is lost.",
      );
    }
    for (let index = 0; index < 8; index += 1) {
      if (context.getError() === context.NO_ERROR) break;
    }

    const rendererSize = this.renderer.getSize(new THREE.Vector2());
    const pixelRatio = this.renderer.getPixelRatio();
    const renderTarget = this.renderer.getRenderTarget();
    const viewport = this.renderer.getViewport(new THREE.Vector4());
    const scissor = this.renderer.getScissor(new THREE.Vector4());
    const scissorTest = this.renderer.getScissorTest();
    const autoClear = this.renderer.autoClear;
    const clearColor = this.renderer.getClearColor(new THREE.Color());
    const clearAlpha = this.renderer.getClearAlpha();
    const sceneBackground = this.scene.background;
    const labelsVisible = this.sceneLabelOverlay.object.visible;
    const fogDensity = this.fog.density;
    const pixels = new Uint8Array(
      resolution.width * resolution.height * 4,
    );

    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(
        resolution.width,
        resolution.height,
        false,
      );
      const drawingBuffer = this.renderer.getDrawingBufferSize(
        new THREE.Vector2(),
      );
      if (
        drawingBuffer.x !== resolution.width ||
        drawingBuffer.y !== resolution.height
      ) {
        throw new Error(
          `The browser could not create a ${resolution.width.toLocaleString()}\u00d7${resolution.height.toLocaleString()} drawing buffer. Try a smaller resolution.`,
        );
      }
      this.renderer.setRenderTarget(null);
      this.renderer.setViewport(
        0,
        0,
        resolution.width,
        resolution.height,
      );
      this.renderer.setScissorTest(false);
      this.renderer.autoClear = true;
      this.sceneLabelOverlay.object.visible = false;
      this.fog.density = fogDensityForCameraDistance(
        camera.position.distanceTo(target),
      );
      if (background === "transparent") {
        this.scene.background = null;
        this.renderer.setClearColor(0x000000, 0);
      } else {
        this.renderer.setClearAlpha(1);
      }
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, camera);
      context.readPixels(
        0,
        0,
        resolution.width,
        resolution.height,
        context.RGBA,
        context.UNSIGNED_BYTE,
        pixels,
      );
      if (
        context.isContextLost() ||
        context.getError() !== context.NO_ERROR
      ) {
        throw new Error(
          "The GPU could not read the rendered image. Try a smaller resolution or restore WebGL.",
        );
      }
      flipRgbaRows(pixels, resolution.width, resolution.height);
      return pixels;
    } finally {
      this.scene.background = sceneBackground;
      this.sceneLabelOverlay.object.visible = labelsVisible;
      this.fog.density = fogDensity;
      this.renderer.setClearColor(clearColor, clearAlpha);
      this.renderer.autoClear = autoClear;
      this.renderer.setSize(rendererSize.x, rendererSize.y, false);
      this.renderer.setPixelRatio(pixelRatio);
      this.renderer.setRenderTarget(renderTarget);
      this.renderer.setViewport(viewport);
      this.renderer.setScissor(scissor);
      this.renderer.setScissorTest(scissorTest);
    }
  }

  private async composeExportPng(
    pixels: Uint8Array,
    resolution: ValidatedImageExportResolution,
    overlay: ImageExportOverlay,
  ): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = resolution.width;
    canvas.height = resolution.height;
    const context = canvas.getContext("2d", { alpha: true });
    if (context === null) {
      throw new Error(
        "Image export is unavailable because Canvas2D could not be created.",
      );
    }
    try {
      context.putImageData(
        new ImageData(
          new Uint8ClampedArray(pixels),
          resolution.width,
          resolution.height,
        ),
        0,
        0,
      );
      drawImageExportOverlay(
        context,
        resolution.width,
        resolution.height,
        overlay,
      );
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob === null) {
            reject(
              new Error(
                "The browser could not encode the rendered image as PNG.",
              ),
            );
          } else {
            resolve(blob);
          }
        }, "image/png");
      });
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  private updateCameraProjection(width: number, height: number): void {
    const aspect = width / height;
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    const halfHeight = this.orthographicViewHeight / 2;
    const halfWidth = halfHeight * aspect;
    this.orthographicCamera.left = -halfWidth;
    this.orthographicCamera.right = halfWidth;
    this.orthographicCamera.top = halfHeight;
    this.orthographicCamera.bottom = -halfHeight;
    this.orthographicCamera.updateProjectionMatrix();
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
    animate: boolean,
  ): void {
    const bounds = this.districtFrameBounds(districtId);
    if (bounds !== undefined && !bounds.isEmpty()) {
      this.frameBounds(bounds, animate);
    }
  }

  private districtFrameBounds(districtId: string): THREE.Box3 | undefined {
    const bounds = this.semanticDistrictBounds.get(districtId)?.clone();
    if (bounds === undefined) return undefined;
    if (!this.semanticExternalBounds.isEmpty()) {
      bounds.union(this.semanticExternalBounds);
    }
    return bounds;
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
    orientation?: CameraOrientation,
  ): void {
    const center = bounds.getCenter(new THREE.Vector3());
    if (this.cameraNavigationMode === "top-down") {
      this.topDownTargetY = center.y;
    }
    const size = bounds.getSize(new THREE.Vector3());
    const maximumDimension = Math.max(size.x, size.y, size.z, 1);
    const aspect =
      Math.max(1, this.host.clientWidth) /
      Math.max(1, this.host.clientHeight);
    const direction =
      this.cameraNavigationMode === "top-down"
        ? new THREE.Vector3(0, 1, 0)
        : orientation?.direction.clone() ??
          this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-8) {
      direction.set(1, 0.78, -1);
    }
    direction.normalize();
    const up =
      this.cameraNavigationMode === "top-down"
        ? new THREE.Vector3(0, 0, -1)
        : orientation?.up.clone() ?? this.camera.up.clone();
    const distance =
      this.camera === this.perspectiveCamera
        ? cameraDistanceForBounds(
            size,
            this.perspectiveCamera.fov,
            aspect,
          )
        : orthographicCameraDistanceForBounds(size);
    const targetOrthographicViewHeight =
      this.camera === this.orthographicCamera
        ? orthographicViewHeightForOrientedBounds(
            size,
            aspect,
            direction,
            up,
          )
        : undefined;
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
      this.camera.up.copy(up);
      this.controls.target.copy(center);
      if (targetOrthographicViewHeight !== undefined) {
        this.orthographicViewHeight = targetOrthographicViewHeight;
        this.orthographicCamera.zoom = 1;
        this.updateCameraProjection(
          Math.max(1, this.host.clientWidth),
          Math.max(1, this.host.clientHeight),
        );
      }
      this.controls.update();
      this.enforceTopDownNavigationPlane();
      this.updateFog();
      return;
    }
    this.cameraTransition = {
      startedAt: performance.now(),
      durationMs: 520,
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      fromUp: this.camera.up.clone(),
      toPosition: position,
      toTarget: center,
      toUp: up,
      ...(targetOrthographicViewHeight === undefined
        ? {}
        : {
            fromOrthographicViewHeight:
              this.orthographicViewHeight /
              Math.max(this.orthographicCamera.zoom, 1e-6),
            toOrthographicViewHeight: targetOrthographicViewHeight,
          }),
    };
    if (targetOrthographicViewHeight !== undefined) {
      this.orthographicCamera.zoom = 1;
    }
  }

  private preserveCameraForBounds(bounds: THREE.Box3): void {
    const size = bounds.getSize(new THREE.Vector3());
    const maximumDimension = Math.max(size.x, size.y, size.z, 1);
    const requiredDistance =
      this.camera === this.perspectiveCamera
        ? cameraDistanceForBounds(
            size,
            this.perspectiveCamera.fov,
            this.perspectiveCamera.aspect,
          )
        : orthographicCameraDistanceForBounds(size);
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
    this.enforceTopDownNavigationPlane();
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
    this.camera.up
      .lerpVectors(transition.fromUp, transition.toUp, eased)
      .normalize();
    this.controls.target.lerpVectors(
      transition.fromTarget,
      transition.toTarget,
      eased,
    );
    if (
      transition.fromOrthographicViewHeight !== undefined &&
      transition.toOrthographicViewHeight !== undefined
    ) {
      this.orthographicViewHeight =
        transition.fromOrthographicViewHeight +
        (transition.toOrthographicViewHeight -
          transition.fromOrthographicViewHeight) *
          eased;
      this.updateCameraProjection(
        Math.max(1, this.host.clientWidth),
        Math.max(1, this.host.clientHeight),
      );
    }
    if (progress === 1) {
      this.completeCameraTransition();
    }
  }

  private completeCameraTransition(): void {
    const transition = this.cameraTransition;
    if (transition === null) return;
    this.cameraTransition = null;
    this.camera.position.copy(transition.toPosition);
    this.camera.up.copy(transition.toUp);
    this.controls.target.copy(transition.toTarget);
    if (transition.toOrthographicViewHeight !== undefined) {
      this.orthographicViewHeight =
        transition.toOrthographicViewHeight;
      this.orthographicCamera.zoom = 1;
      this.updateCameraProjection(
        Math.max(1, this.host.clientWidth),
        Math.max(1, this.host.clientHeight),
      );
    }
    this.discardControlMomentum();
    this.updateFog();
    schedulePerformanceDiagnostics();
  }

  private prepareTopDownNavigation(): void {
    this.discardControlMomentum();
    if (this.cameraNavigationMode !== "top-down") {
      this.orbitOrientationBeforeTopDown =
        cameraOrientationForPreset(
          "whole-city",
          this.camera.position.clone().sub(this.controls.target),
          this.camera.up,
        );
      this.cameraNavigationMode = "top-down";
      this.applyCameraNavigationProfile("top-down");
    }
  }

  private leaveTopDownNavigation(): CameraOrientation | undefined {
    if (this.cameraNavigationMode !== "top-down") return undefined;
    this.discardControlMomentum();
    const orientation = this.orbitOrientationBeforeTopDown;
    this.orbitOrientationBeforeTopDown = null;
    this.topDownTargetY = null;
    this.cameraNavigationMode = "orbit";
    this.applyCameraNavigationProfile("orbit");
    return orientation === null
      ? undefined
      : {
          direction: orientation.direction.clone(),
          up: orientation.up.clone(),
        };
  }

  private applyCameraNavigationProfile(
    mode: CameraNavigationMode,
  ): void {
    const profile = cameraNavigationProfile(mode);
    this.controls.enableRotate = profile.enableRotate;
    this.controls.screenSpacePanning = profile.screenSpacePanning;
    this.controls.minPolarAngle = profile.minPolarAngle;
    this.controls.maxPolarAngle = profile.maxPolarAngle;
    Object.assign(this.controls.mouseButtons, profile.mouseButtons);
    Object.assign(this.controls.touches, profile.touches);
    this.host.dataset["cameraNavigation"] = mode;
    cameraControlsHint.textContent =
      mode === "top-down"
        ? "Drag to pan · Scroll or pinch to zoom"
        : "Drag to orbit · Scroll to zoom · Right-drag to pan";
  }

  private discardControlMomentum(): void {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    this.enforceTopDownNavigationPlane();
  }

  private enforceTopDownNavigationPlane(): void {
    if (
      this.cameraNavigationMode !== "top-down" ||
      this.topDownTargetY === null ||
      this.cameraTransition !== null
    ) {
      return;
    }
    const distance = Math.max(
      this.camera.position.distanceTo(this.controls.target),
      0.01,
    );
    this.controls.target.y = this.topDownTargetY;
    this.camera.position.set(
      this.controls.target.x,
      this.topDownTargetY + distance,
      this.controls.target.z,
    );
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(this.controls.target);
    this.camera.updateMatrixWorld(true);
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
    const entity = this.pick({
      x: event.clientX,
      y: event.clientY,
    });
    const handled =
      this.onPointerSelection?.(entity, {
        additive: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
      }) ?? false;
    if (!handled) this.select(entity);
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
    const buildingHit = this.buildingLayer?.pick({
      origin: this.raycaster.ray.origin,
      direction: this.raycaster.ray.direction,
    }).hit;
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

  private select(
    entity: SceneEntity | null,
    showDetails = true,
  ): void {
    if (entity !== null && showDetails) {
      viewerWorkspace.showDetails({ intent: "passive" });
    } else if (entity === null) {
      viewerWorkspace.closeDetails();
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
        const findingSummary = designSmellBuildingSummaryText(
          building.id,
        );
        return {
          id: encodeSceneEntityKey(entity),
          text: building.name,
          ...(findingSummary === undefined
            ? {}
            : {
                accessibleText:
                  `${building.name}; ${findingSummary}`,
              }),
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

function exportOrthographicCamera(
  size: THREE.Vector3,
  aspect: number,
  near: number,
  far: number,
  orientation: CameraOrientation,
): THREE.OrthographicCamera {
  const viewHeight = orthographicViewHeightForOrientedBounds(
    size,
    aspect,
    orientation.direction,
    orientation.up,
  );
  const halfHeight = viewHeight / 2;
  const halfWidth = halfHeight * aspect;
  return new THREE.OrthographicCamera(
    -halfWidth,
    halfWidth,
    halfHeight,
    -halfHeight,
    near,
    far,
  );
}

class UnavailableCityScene {
  public constructor(host: HTMLDivElement, reason: string) {
    host.dataset["webglAvailable"] = "false";
    host.setAttribute("role", "alert");
    const fallback = document.createElement("section");
    fallback.className = "webgl-unavailable";
    const title = document.createElement("h2");
    title.textContent = "3D viewer unavailable";
    const description = document.createElement("p");
    description.textContent =
      "This browser could not start WebGL. Hardware acceleration or WebGL support may be disabled. Project data and non-visual exports remain available.";
    const detail = document.createElement("p");
    detail.className = "webgl-unavailable-detail";
    detail.textContent = reason;
    fallback.append(title, description, detail);
    host.replaceChildren(fallback);
    imageExportOpenButton.disabled = true;
    imageExportOpenButton.title =
      "Image export requires an available WebGL context.";
    cameraFitCityButton.disabled = true;
    cameraFocusSelectionButton.disabled = true;
  }

  public get projection(): CameraProjection {
    return "perspective";
  }

  public get navigationMode(): CameraNavigationMode {
    return "orbit";
  }

  public get selectedEntityAvailable(): boolean {
    return false;
  }

  public fitCity(_animate = true): boolean {
    return false;
  }

  public focusSelectedEntity(_animate = true): boolean {
    return false;
  }

  public load(
    _model: CityModel,
    _effectiveBase: CityBase | undefined,
    _externalNodes: readonly ExternalSceneNode[],
    _frame = true,
  ): void {}

  public setProjection(_projection: CameraProjection): void {}

  public applyCameraPreset(
    _preset: CameraPreset,
    _animate = true,
  ): boolean {
    return false;
  }

  public async exportPng(
    _request: ImageExportRequest,
    _overlay: Omit<ImageExportOverlay, "labels" | "legend"> & {
      readonly legend: readonly ImageExportLegendEntry[];
    },
  ): Promise<SceneImageExport> {
    throw new Error(
      "Image export is unavailable because WebGL could not be started.",
    );
  }

  public showCityLayout(_frame = true): void {}

  public setVisualization(
    _colorsByBuildingId: ReadonlyMap<string, string>,
    _label: string,
  ): void {}

  public showEvolutionTransition(
    _transition: EvolutionTransition,
    _reducedMotion: boolean,
  ): void {}

  public finishEvolutionTransition(): void {}

  public showPrintPlate(_plate: ProjectedPrintPlate): void {}

  public resetSelection(): void {}

  public setBuildingGroupHighlight(
    _buildingIds: readonly string[],
    _visible: boolean,
    _color?: string,
  ): void {}

  public get buildingSelectionIsolated(): boolean {
    return false;
  }

  public focusBuildings(_buildingIds: readonly string[]): boolean {
    return false;
  }

  public isolateBuildings(
    _buildingIds: readonly string[],
    _focus = true,
  ): boolean {
    return false;
  }

  public replaceDependencyRoutes(
    _routes: readonly DependencyOverlayRoute[],
  ): void {}

  public replaceDistrictDependencyRoutes(
    _routes: readonly DependencyOverlayRoute[],
  ): void {}

  public selectBuilding(
    _id: string,
    _focus = false,
    _showDetails = true,
  ): boolean {
    return false;
  }

  public selectDistrict(
    _id: string,
    _focus = false,
    _showDetails = true,
  ): boolean {
    return false;
  }

  public selectExternalNode(_id: string, _focus = false): boolean {
    return false;
  }

  public showAllBuildings(_frame = true): void {}

  public assertBuildingCapability(_buildingCount: number): void {}

  public performanceDiagnostics(): ViewerPerformanceDiagnostics {
    return Object.freeze({
      buildingRenderMode: null,
      buildingBatchCount: 0,
      visibleBuildingCount: 0,
      buildingVisibilityMaskActive: false,
      objectCount: 0,
      renderCalls: 0,
      camera: Object.freeze({
        position: Object.freeze([0, 0, 0] as const),
        target: Object.freeze([0, 0, 0] as const),
        up: Object.freeze([0, 1, 0] as const),
        projection: "perspective",
        navigationMode: "orbit",
        zoom: 1,
        viewHeight: 0,
      }),
      evolutionRemovals: null,
      evolutionRemovalAnimated: false,
      dependencyRoutes: EMPTY_DEPENDENCY_ROUTE_DIAGNOSTICS,
      districtDependencyRoutes: EMPTY_DEPENDENCY_ROUTE_DIAGNOSTICS,
      designSmells: EMPTY_DESIGN_SMELL_DIAGNOSTICS,
      pickBenchmark: Object.freeze({
        count: 0,
        p95Milliseconds: 0,
        maximumAabbTests: 0,
      }),
    });
  }
}

function createCityScene(): CityScene | UnavailableCityScene {
  try {
    return new CityScene(
      sceneHost,
      synchronizeExplorerState,
      () => requestCityPresentation(),
      (entity, intent) => {
        if (advancedQueryPanel === undefined) return false;
        if (entity?.kind === "building") {
          advancedQueryPanel.selectFromScene(entity.id, {
            ...intent,
            orderedBuildingIds: activeBuildingSelectionOrder,
          });
          return (
            intent.additive ||
            intent.range ||
            (viewerWorkspace.activeView === "analyze" &&
              viewerWorkspace.activeAnalyzeView === "queries")
          );
        }
        advancedQueryPanel.clearSelection();
        return false;
      },
    );
  } catch (error) {
    return new UnavailableCityScene(sceneHost, messageOf(error));
  }
}

let activeModel: CityModel = DEMO_MODEL;
let activeModelSource: ModelSource = { label: "Built-in demo" };
let safeExtensionBaseModel: CityModel = activeModel;
let activeSafeExtensionEvaluation: ExtensionEvaluation | undefined;
let suppressSafeExtensionRestore = false;
let sourceRequest:
  | Readonly<{
      buildingId: string;
      controller: AbortController;
      promise: Promise<BuildingSource>;
    }>
  | undefined;
let aiGuidanceRequest: AbortController | undefined;
let aiGuidanceGeneration = 0;
let loadedBuildingSource:
  | { readonly buildingId: string; readonly source: BuildingSource }
  | undefined;
let visualizationMode: ViewerVisualizationMode = "semantic";
let activeVisualizationLabel = "Semantic groups";
let activeLegendEntries: readonly ImageExportLegendEntry[] = [];
let activeDesignSmellFindings: readonly DesignSmellFinding[] =
  Object.freeze([]);
let activeDesignSmellVisualization: DesignSmellBuildingVisualization =
  createDesignSmellBuildingVisualization(
    activeModel.buildings.map(({ id }) => id),
    activeDesignSmellFindings,
  );
let activeDesignSmellDiagnostics = designSmellBuildingDiagnostics(
  activeDesignSmellVisualization,
  false,
);
let previewPrinterProfile: PrinterProfile | undefined;
let printVisualizationContextActive = false;
let evolutionWorker = new EvolutionTimelineWorkerClient();
let evolutionLoadController: AbortController | undefined;
let evolutionGeneration = 0;
const evolutionSeekController = new EvolutionDeferredSeekController({
  currentIndex: () => activeEvolutionIndex,
  request: (fromIndex, targetIndex) =>
    evolutionWorker.seek(fromIndex, targetIndex),
  cancelRequest: () => evolutionWorker.cancel(),
  render: () => renderEvolutionTimeline(),
});
let evolutionPlaybackTimer: number | undefined;
let evolutionTransitionTimer: number | undefined;
let activeEvolutionFrames: readonly EvolutionFrameSummary[] = [];
let activeEvolutionHistories = new Map<string, EvolutionBuildingHistory>();
let activeEvolutionLineageSelection:
  | EvolutionBuildingLineageSelection
  | undefined;
let activeEvolutionAnalysis: EvolutionVisualizationData | undefined;
let activeEvolutionTransition: EvolutionTransition | undefined;
let activeEvolutionQueryChanges:
  | ReadonlyMap<string, ReadonlySet<AdvancedQueryChangeKind>>
  | undefined;
let activeEvolutionDependencyChanges:
  | EvolutionDependencyChanges
  | undefined;
let activeEvolutionTargetDependencyIds: ReadonlySet<string> = new Set();
let activeEvolutionIndex = 0;
let codeInspectionFrameAccessState: "terminal" | "historical" | "busy" =
  "terminal";
let evolutionPlaying = false;
let evolutionLoading = false;
let activeBuildingsById = new Map(
  DEMO_MODEL.buildings.map((building) => [building.id, building]),
);
let activeBuildingSelectionOrder = Object.freeze(
  DEMO_MODEL.buildings.map(({ id }) => id),
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
let executableUnitQuery = "";
let executableUnitSort: ExecutableUnitSort = "complexity";
// Kept separate from the legacy executable-unit table: opening more source
// declarations must never change the normal file metrics presentation.
let fineDetailVisibleLimit = FINE_DETAIL_INITIAL_LIMIT;
let fineDetailDrilledBuildingId: string | undefined;
let expandedFineDetailTypeIds = new Set<string>();
let selectedSourceDeclaration:
  | { readonly buildingId: string; readonly node: FineDetailNode }
  | undefined;
let codeInspectionFocus: CodeInspectionFocus | undefined;
let codeInspectionBuildingId: string | undefined;
let decisionSiteVisibleLimit = INITIAL_DECISION_SITE_VISIBLE_LIMIT;
let explorerState = resetExplorerState();
let activeExternalLayout = createExternalDependencyLayout(DEMO_MODEL);
let activeExternalNodes: readonly ExternalSceneNode[] =
  activeExternalLayout.nodes;
let requestCityPresentation = (): void => {};
let advancedQueryPanel: AdvancedQueryPanelController | undefined;
let safeExtensionPanel: SafeExtensionPanelController | undefined;
let activeDesignSmellQueryFacts:
  | {
      readonly ruleIdsByBuildingId: ReadonlyMap<
        string,
        ReadonlySet<string>
      >;
      readonly availableRuleIdsByBuildingId: ReadonlyMap<
        string,
        ReadonlySet<string>
      >;
    }
  | undefined;
let applyingAdvancedSelection = false;
const cityScene = createCityScene();
let designSmellWorkspaceActive =
  viewerWorkspace.activeView === "analyze" &&
  viewerWorkspace.activeAnalyzeView === "findings";
synchronizeFindingsWorkspace = (state): void => {
  const nextActive =
    state.activeView === "analyze" &&
    state.activeAnalyzeView === "findings";
  if (nextActive === designSmellWorkspaceActive) return;
  designSmellWorkspaceActive = nextActive;
  imageExportDialog.invalidate();
  applyVisualization();
  const selected = explorerState.selectedEntity;
  if (selected?.kind === "building") {
    const building = activeBuildingsById.get(selected.id);
    if (building !== undefined) {
      selectionStatus.textContent = buildingSelectionStatus(building);
    }
  }
  schedulePerformanceDiagnostics();
};
const repositoryHierarchyTree = installRepositoryHierarchyTree({
  tree: repositoryTree,
  status: repositoryTreeStatus,
  model: DEMO_MODEL,
  projectKey: repositoryHierarchyProjectKey(
    DEMO_MODEL,
    activeModelSource.label,
  ),
  onActivate: activateRepositoryTreeEntity,
});
synchronizeHierarchyWorkspace = (state): void => {
  if (
    state.activeView === "explore" &&
    state.sheetState !== "collapsed"
  ) {
    repositoryHierarchyTree.reveal();
  }
};
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
const aiProviderDiscovery = new AiProviderDiscoveryController(() =>
  sourceApi.aiGuidanceProviders(),
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
    aiProviderDiscovery.invalidate();
    scrubBuildingSource();
    automaticModelLoadGate.invalidate();
    activateImportedModel(DEMO_MODEL, { label: "Built-in demo" });
  },
  onAuthorizationLost: () => {
    aiProviderDiscovery.invalidate();
    scrubBuildingSource();
  },
  onAuthenticated: () => {
    aiProviderDiscovery.invalidate();
    const building = selectedInspectionBuilding();
    scrubBuildingSource();
    if (building !== undefined) {
      codeInspectionBuildingId = building.id;
      setCodeInspectionFocus(building, fileInspectionFocus(building.id));
      inspectorFields.sourceSummary.textContent =
        sourceIsBoundToCurrentEvolutionFrame() ? "Not loaded" : "Historical frame";
      inspectorFields.sourceStatus.textContent = sourceAvailabilityMessage();
      synchronizeSourceOpenAvailability(building);
      discoverAiGuidanceCapability(building);
    }
  },
  onResultRemoved: (jobId) => {
    markActiveSourceResultRemoved(jobId);
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
    if (!printVisualizationContextActive) return;
    const modeChanged = synchronizeVisualizationModeOptions();
    if (modeChanged || visualizationMode === "print") {
      applyVisualization();
    }
  },
});
const imageExportDialog = installImageExportDialog({
  context: () => {
    const frame = currentEvolutionExportFrame();
    return {
      projection: cityScene.projection,
      selectedEntityAvailable: cityScene.selectedEntityAvailable,
      ...(frame === undefined ? {} : { evolutionFrame: frame }),
    };
  },
  exportImage: async (request): Promise<PreparedImageExport> => {
    if (evolutionLoading || evolutionSeekController.busy) {
      throw new Error(
        "Wait for the active evolution frame to finish loading before exporting.",
      );
    }
    stopEvolutionPlayback();
    settleEvolutionTransition();
    const frame = request.includeEvolutionFrame
      ? currentEvolutionExportFrame()
      : undefined;
    const title =
      activeModel.identity?.title ??
      activeModel.repositories[0]?.name ??
      "Code City";
    const rendered = await cityScene.exportPng(request, {
      title,
      ...(frame === undefined
        ? {}
        : { subtitle: frame.label }),
      legendTitle: activeVisualizationLabel,
      legend: activeLegendEntries,
    });
    return {
      blob: rendered.blob,
      resolution: rendered.resolution,
      fileName: imageExportFileName(
        title,
        request,
        frame?.sha,
      ),
    };
  },
});
const metricMappingPanel = installMetricMappingPanel(
  element<HTMLElement>("metric-mapping-panel"),
  {
    onModelChange: (model) => {
      setSafeExtensionProject(model);
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
advancedQueryPanel = installAdvancedQueryPanel(
  element<HTMLElement>("advanced-query-panel"),
  {
    context: advancedQueryPanelContext,
    onSelectionChange: applyAdvancedSelection,
    onFocus: (buildingIds) => {
      cityScene.focusBuildings(buildingIds);
    },
    onInspect: () => {
      viewerWorkspace.showDetails({ intent: "explicit", focus: true });
    },
    onIsolate: (buildingIds) => {
      applyingAdvancedSelection = true;
      try {
        if (cityScene.buildingSelectionIsolated) {
          cityScene.showAllBuildings();
        } else {
          cityScene.isolateBuildings(buildingIds);
        }
      } finally {
        applyingAdvancedSelection = false;
      }
    },
  },
);
advancedQueryPanel.setProject(activeModel);
const designSmellPanel = installDesignSmellPanel(
  element<HTMLElement>("design-smell-panel"),
  {
    onNavigate: (finding) => {
      viewerWorkspace.showDetails({
        intent: "explicit",
        focus: true,
      });
      selectBuildingFromExplorer(finding.buildingId);
      const building = activeBuildingsById.get(finding.buildingId);
      if (building !== undefined) {
        const focus = Object.freeze({
          kind: "smell" as const,
          buildingId: finding.buildingId,
          findingId: finding.id,
          ruleId: finding.ruleId,
          ...(finding.evidence.line === undefined
            ? {}
            : {
              range: Object.freeze({
                startLine: finding.evidence.line,
                endLine:
                  finding.evidence.endLine ?? finding.evidence.line,
              }),
            }),
        });
        if (focus.range === undefined) {
          setCodeInspectionFocus(building, focus);
          if (loadedBuildingSource?.buildingId === building.id) {
            renderSourceCode(building, loadedBuildingSource.source);
          }
        } else {
          revealBuildingSource(building, focus);
        }
      }
    },
    onVisibleFindingsChange: (findings) => {
      activeDesignSmellFindings = Object.freeze([...findings]);
      activeDesignSmellVisualization =
        createDesignSmellBuildingVisualization(
          activeModel.buildings.map(({ id }) => id),
          activeDesignSmellFindings,
        );
      activeDesignSmellDiagnostics = designSmellBuildingDiagnostics(
        activeDesignSmellVisualization,
        designSmellWorkspaceActive,
      );
      if (designSmellWorkspaceActive) {
        imageExportDialog.invalidate();
        applyVisualization();
        const selected = explorerState.selectedEntity;
        if (selected?.kind === "building") {
          const building = activeBuildingsById.get(selected.id);
          if (building !== undefined) {
            selectionStatus.textContent = buildingSelectionStatus(building);
          }
        }
      }
      schedulePerformanceDiagnostics();
    },
    onQueryFactsChange: updateAdvancedQueryDesignSmells,
  },
);
safeExtensionPanel = installSafeExtensionPanel(
  element<HTMLElement>("safe-extension-panel"),
  {
    onPreview: (review) => {
      const projected = applySafeExtensionEvaluation(
        safeExtensionBaseModel,
        review.evaluation,
        review.application,
      );
      activeSafeExtensionEvaluation = review.evaluation;
      if (projected === activeModel) {
        printExportDialog.invalidate();
        imageExportDialog.invalidate();
        printPlateToolbar.setPlan(undefined);
        applyVisualization();
        return;
      }
      applyModel(projected, activeModelSource, {
        preserveView: true,
        preserveSelection: true,
      });
    },
    onInvalidate: () => {
      activeSafeExtensionEvaluation = undefined;
      if (
        !suppressSafeExtensionRestore &&
        activeModel !== safeExtensionBaseModel
      ) {
        applyModel(safeExtensionBaseModel, activeModelSource, {
          preserveView: true,
          preserveSelection: true,
        });
      } else if (!suppressSafeExtensionRestore) {
        printExportDialog.invalidate();
        imageExportDialog.invalidate();
        printPlateToolbar.setPlan(undefined);
        applyVisualization();
      }
    },
  },
);
setSafeExtensionProject(activeModel);

visualizationModeSelect.addEventListener("change", () => {
  const selected = visualizationModeSelect.value;
  const availableModes = availableViewerVisualizationModes(
    {
      evolution: activeEvolutionAnalysis !== undefined,
      printProfile:
        printVisualizationContextActive &&
        previewPrinterProfile !== undefined,
    },
    activeModel,
  );
  if (!availableModes.includes(selected as ViewerVisualizationMode)) {
    visualizationModeSelect.value = visualizationMode;
    return;
  }
  visualizationMode = selected as ViewerVisualizationMode;
  applyVisualization();
  imageExportDialog.invalidate();
});

cameraFitCityButton.addEventListener("click", () => {
  if (cityScene.fitCity()) {
    imageExportDialog.invalidate();
  }
});
cameraFocusSelectionButton.addEventListener("click", () => {
  if (!cityScene.focusSelectedEntity()) {
    showError("Select an entity before focusing the camera.");
    return;
  }
  imageExportDialog.invalidate();
});
imageExportOpenButton.addEventListener("click", () => {
  exportActionsMenu.open = false;
  stopEvolutionPlayback(false);
  if (!evolutionLoading && !evolutionSeekController.busy) {
    settleEvolutionTransition();
  }
  imageExportDialog.open();
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
  const targetIndex = Number(evolutionRange.value);
  stopEvolutionPlayback(false);
  void seekEvolution(targetIndex);
});

fileOpenButton.addEventListener("click", () => {
  projectActionsMenu.open = false;
  projectActionsSummary.focus({ preventScroll: true });
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
  projectActionsMenu.open = false;
  projectActionsSummary.focus({ preventScroll: true });
  automaticModelLoadGate.invalidate();
  activateImportedModel(DEMO_MODEL, { label: "Built-in demo" });
});

printExportOpenButton.addEventListener("click", () => {
  exportActionsMenu.open = false;
  printVisualizationContextActive = true;
  synchronizeVisualizationModeOptions();
});

projectActionsMenu.addEventListener("toggle", () => {
  if (projectActionsMenu.open) exportActionsMenu.open = false;
});

exportActionsMenu.addEventListener("toggle", () => {
  if (exportActionsMenu.open) projectActionsMenu.open = false;
});

advancedProjectSettingsOpen.addEventListener("click", () => {
  projectActionsMenu.open = false;
  advancedProjectSettingsDialog.showModal();
});

advancedProjectSettingsClose.addEventListener("click", () => {
  advancedProjectSettingsDialog.close();
});

advancedProjectSettingsDialog.addEventListener("click", (event) => {
  if (event.target === advancedProjectSettingsDialog) {
    advancedProjectSettingsDialog.close();
  }
});

advancedProjectSettingsDialog.addEventListener("close", () => {
  restoreDisclosureFocus(projectActionsSummary);
});

element<HTMLDialogElement>("image-export-dialog").addEventListener(
  "close",
  () => restoreDisclosureFocus(exportActionsSummary),
);
element<HTMLDialogElement>("print-export-dialog").addEventListener(
  "close",
  () => restoreDisclosureFocus(exportActionsSummary),
);

clearSelectionButton.addEventListener("click", () => {
  viewerWorkspace.closeDetails({ focusTab: true });
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
inspectorFields.unitsSearch.addEventListener("input", () => {
  const selectedBuildingId =
    selectedExplorerBuildingId(explorerState);
  const building = selectedBuildingId
    ? activeBuildingsById.get(selectedBuildingId)
    : undefined;
  if (!building) return;
  executableUnitQuery = inspectorFields.unitsSearch.value;
  executableUnitVisibleLimit =
    INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT;
  renderExecutableUnits(building);
});
inspectorFields.unitsSort.addEventListener("change", () => {
  const selectedBuildingId =
    selectedExplorerBuildingId(explorerState);
  const building = selectedBuildingId
    ? activeBuildingsById.get(selectedBuildingId)
    : undefined;
  if (!building) return;
  executableUnitSort =
    inspectorFields.unitsSort.value === "source"
      ? "source"
      : "complexity";
  executableUnitVisibleLimit =
    INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT;
  renderExecutableUnits(building);
});
inspectorFields.sourceStructureShowMore.addEventListener("click", () => {
  const building = selectedExplorerBuildingId(explorerState)
    ? activeBuildingsById.get(selectedExplorerBuildingId(explorerState)!)
    : undefined;
  if (!building) return;
  fineDetailVisibleLimit = nextBoundedResultLimit(
    fineDetailVisibleLimit,
    FINE_DETAIL_MAXIMUM_LIMIT,
    FINE_DETAIL_INITIAL_LIMIT,
  );
  renderSourceStructure(building);
});
inspectorFields.sourceOpen.addEventListener("click", () => {
  const building = selectedInspectionBuilding();
  if (!building) return;
  revealBuildingSource(building, fileInspectionFocus(building.id));
});
inspectorFields.decisionSitesShowMore.addEventListener("click", () => {
  const building = selectedInspectionBuilding();
  if (!building) return;
  decisionSiteVisibleLimit = nextBoundedResultLimit(
    decisionSiteVisibleLimit,
    MAXIMUM_DECISION_SITE_VISIBLE_LIMIT,
    INITIAL_DECISION_SITE_VISIBLE_LIMIT,
  );
  renderDecisionEvidence(building);
});
inspectorFields.sourceStructureReturn.addEventListener("click", () => {
  const building = selectedInspectionBuilding();
  if (building === undefined) return;
  const sourceScrollTop = inspectorFields.sourceCode.scrollTop;
  codeInspectionFocus = fileInspectionFocus(building.id);
  inspectorFields.sourceStructureReturn.hidden = true;
  fineDetailDrilledBuildingId = undefined;
  selectedSourceDeclaration = undefined;
  inspectorFields.decisionEvidence.hidden = true;
  inspectorFields.decisionSites.replaceChildren();
  for (const current of inspectorFields.sourceStructure.querySelectorAll(
    '[aria-current="location"]',
  )) {
    current.removeAttribute("aria-current");
  }
  for (const current of inspectorFields.sourceCode.querySelectorAll(
    ".source-line-highlight, .source-column-aware, .source-range-highlight, .source-decision-marker, .source-decision-marker-selected",
  )) {
    current.classList.remove(
      "source-line-highlight",
      "source-column-aware",
      "source-range-highlight",
      "source-decision-marker",
      "source-decision-marker-selected",
    );
  }
  inspectorFields.sourceCode.scrollTop = sourceScrollTop;
  clearAiGuidanceResult();
  renderAiGuidanceCapability(building);
  const outlineSummary =
    inspectorFields.sourceStructureDetails.querySelector<HTMLElement>("summary");
  if (outlineSummary !== null) restoreDisclosureFocus(outlineSummary);
  setStatus("Cleared declaration focus; the selected building and view are unchanged.");
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
    document.activeElement.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      }),
    );
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

dismissErrorButton.addEventListener("click", hideError);

window.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    document.querySelector("dialog[open]") === null
  ) {
    viewerWorkspace.closeDetails({ focusTab: true });
    clearBuildingSelection();
    hideError();
  }
});
window.addEventListener("beforeunload", () => {
  resetEvolutionTimeline(false);
  viewerWorkspace.dispose();
  repositoryHierarchyTree.dispose();
  printPlateToolbar.dispose();
  projectImportDialog.dispose();
  metricMappingPanel.dispose();
  advancedQueryPanel?.dispose();
  imageExportDialog.dispose();
  designSmellPanel.dispose();
  safeExtensionPanel?.dispose();
  logoLoadGate.invalidate();
  loadedModelLogo?.dispose();
  loadedModelLogo = undefined;
});

let performanceDiagnosticsGeneration = 0;
const initialParameters = new URL(window.location.href).searchParams;
if (initialParameters.get("fixture") === LARGE_CITY_FIXTURE_NAME) {
  try {
    const fixture = createLargeCityFixture();
    activateImportedModel(fixture, {
      label: "Built-in 25k performance fixture",
    });
    if (initialParameters.get("evolution-removals") === "1") {
      cityScene.showEvolutionTransition(
        largeCityRemovalTransition(fixture),
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
    }
  } catch (error) {
    activateImportedModel(DEMO_MODEL, { label: "Built-in demo" });
    showError(messageOf(error));
  }
} else {
  activateImportedModel(DEMO_MODEL, { label: "Built-in demo" });
  void loadModelFromQuery();
}

function largeCityRemovalTransition(
  model: CityModel,
): EvolutionTransition {
  return Object.freeze({
    fromIndex: 0,
    toIndex: 1,
    addedBuildingIds: Object.freeze([]),
    removedBuildings: Object.freeze(
      model.buildings.map((building) =>
        Object.freeze({
          id: building.id,
          name: building.name,
          districtId: building.districtId,
          position: building.position,
          size: building.size,
        }),
      ),
    ),
    renamedBuildingIds: Object.freeze([]),
    resizedBuildingIds: Object.freeze([]),
    changedBuildingIds: Object.freeze([]),
    interpolatedBuildings: Object.freeze([]),
    dependencyChanges: Object.freeze({
      added: Object.freeze([]),
      removed: Object.freeze([]),
      changed: Object.freeze([]),
      retargeted: Object.freeze([]),
      affectedEndpoints: Object.freeze([]),
      affectedRouteKeys: Object.freeze([]),
    }),
  });
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
  setSafeExtensionProject(model);
  applyModel(model, source);
  void startEvolutionTimeline(source);
}

function setSafeExtensionProject(model: CityModel): void {
  activeSafeExtensionEvaluation = undefined;
  safeExtensionBaseModel = model;
  suppressSafeExtensionRestore = true;
  try {
    safeExtensionPanel?.setProject(model);
  } finally {
    suppressSafeExtensionRestore = false;
  }
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
  const preservedBuildingSelectionIsolation =
    options.preserveSelection &&
    cityScene.buildingSelectionIsolated;
  const preservedDependencyRouteState = dependencyRouteState;
  const preservedDependencyRouteVisibleLimit = dependencyRouteVisibleLimit;
  const preservedDistrictDependencyFilters = districtDependencyFilters;
  const preservedDistrictDependencyRoutesVisible =
    districtDependencyRoutesVisible;
  const preservedDistrictRouteVisibleLimit = districtRouteVisibleLimit;
  const preservedDistrictDependencyBundleId =
    selectedDistrictDependencyBundleId;
  const preservedBuildingSearch = options.preserveSelection
    ? buildingSearch.value
    : "";
  const preservedSearchResultLimit = options.preserveSelection
    ? searchResultLimit
    : DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT;
  printExportDialog.invalidate();
  imageExportDialog.invalidate();
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
  synchronizeVisualizationModeOptions();
  activeModelSource = source;
  scrubBuildingSource();
  activeBuildingsById = buildingsById;
  activeBuildingSelectionOrder = Object.freeze(
    model.buildings.map(({ id }) => id),
  );
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
  repositoryHierarchyTree.setModel(
    model,
    repositoryHierarchyProjectKey(
      model,
      source.jobId ?? source.label,
    ),
  );
  explorerState = resetExplorerState();
  activeExternalLayout = nextExternalLayout;
  activeExternalNodes = nextExternalLayout.nodes;
  buildingSearch.value = preservedBuildingSearch;
  searchResultLimit = preservedSearchResultLimit;
  synchronizeExplorerState(explorerState);
  renderBuildingSearch();
  cityScene.load(
    model,
    nextExternalLayout.base,
    nextExternalLayout.nodes,
    !options.preserveView,
  );
  // Re-evaluate after the active model and 3D building layer have both been
  // replaced so the worker result colors only the current model's buildings.
  designSmellPanel.setProject(model);
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
  applyingAdvancedSelection = true;
  try {
    if (preservedSelection?.kind === "building") {
      cityScene.selectBuilding(preservedSelection.id);
    } else if (preservedSelection?.kind === "district") {
      cityScene.selectDistrict(preservedSelection.id);
    } else if (preservedSelection?.kind === "external") {
      cityScene.selectExternalNode(preservedSelection.id);
    }
  } finally {
    applyingAdvancedSelection = false;
  }
  advancedQueryPanel?.setProject(model, {
    preserveContext: options.preserveSelection === true,
  });
  if (
    preservedBuildingSelectionIsolation &&
    advancedQueryPanel !== undefined
  ) {
    const retainedBuildingIds =
      advancedQueryPanel.selection.buildingIds.filter((id) =>
        activeBuildingsById.has(id),
    );
    if (retainedBuildingIds.length === 0) {
      cityScene.showAllBuildings(false);
    } else {
      cityScene.isolateBuildings(retainedBuildingIds, false);
    }
  }
  if (options.preserveSelection) {
    if (
      preservedSelection?.kind === "building" &&
      selectedExplorerBuildingId(explorerState) ===
        preservedSelection.id
    ) {
      dependencyRouteState = preservedDependencyRouteState;
      dependencyRouteVisibleLimit =
        preservedDependencyRouteVisibleLimit;
    }
    districtDependencyFilters = preservedDistrictDependencyFilters;
    districtDependencyRoutesVisible =
      preservedDistrictDependencyRoutesVisible;
    districtRouteVisibleLimit = preservedDistrictRouteVisibleLimit;
    selectedDistrictDependencyBundleId =
      preservedDistrictDependencyBundleId;
    // Scene loading clears both overlay objects. Re-render only after the
    // target model and selection have settled so route geometry
    // is rebuilt from the target frame without losing user controls.
    renderDependencyExplorer();
    renderDistrictDependencyExplorer();
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
  activeEvolutionLineageSelection = undefined;
  activeEvolutionAnalysis = undefined;
  activeEvolutionTransition = undefined;
  activeEvolutionQueryChanges = undefined;
  activeEvolutionDependencyChanges = undefined;
  activeEvolutionTargetDependencyIds = new Set();
  activeEvolutionIndex = 0;
  codeInspectionFrameAccessState = "terminal";
  evolutionLoading = false;
  imageExportDialog.invalidate();
  evolutionTimeline.hidden = true;
  evolutionRange.max = "0";
  evolutionRange.value = "0";
  if (synchronizeVisualizationModeOptions()) {
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
    synchronizeVisualizationModeOptions();
    activeEvolutionIndex = 0;
    evolutionRange.max = String(Math.max(0, loaded.frames.length - 1));
    evolutionLoading = false;
    imageExportDialog.invalidate();
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
    imageExportDialog.invalidate();
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

function evolutionTargetDependencyIds(
  changes: EvolutionDependencyChanges | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();
  changes?.added.forEach(({ dependencyId }) => ids.add(dependencyId));
  changes?.changed.forEach(({ dependencyId }) => ids.add(dependencyId));
  changes?.retargeted.forEach(({ dependencyId }) =>
    ids.add(dependencyId),
  );
  return ids;
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
  const generation = evolutionGeneration;
  return evolutionSeekController.seek(
    targetIndex,
    ({ result }) => {
      if (generation !== evolutionGeneration) return;
      const selected = explorerState.selectedEntity;
      const selectedBuilding =
        selected?.kind === "building"
          ? activeBuildingsById.get(selected.id)
          : undefined;
      const lineageSelection =
        selectedBuilding === undefined
          ? activeEvolutionLineageSelection
          : createEvolutionBuildingLineageSelection(selectedBuilding);
      activeEvolutionIndex = targetIndex;
      activeEvolutionAnalysis = evolutionVisualizationData(result.analysis);
      synchronizeVisualizationModeOptions();
      activeEvolutionTransition = initial ? undefined : result.transition;
      activeEvolutionQueryChanges = initial
        ? undefined
        : evolutionQueryChanges(result.transition);
      activeEvolutionDependencyChanges = initial
        ? undefined
        : result.transition.dependencyChanges;
      activeEvolutionTargetDependencyIds = evolutionTargetDependencyIds(
        activeEvolutionDependencyChanges,
      );
      setSafeExtensionProject(result.model);
      applyModel(result.model, activeModelSource, {
        preserveView: true,
        preserveSelection: true,
      });
      const retainedAdvancedPrimaryBuildingId =
        advancedQueryPanel?.selection.primaryBuildingId ?? null;
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
        lineageSelection !== undefined &&
        (retainedAdvancedPrimaryBuildingId === null ||
          retainedAdvancedPrimaryBuildingId === lineageSelection.id)
      ) {
        const history = activeEvolutionHistories.get(
          lineageSelection.id,
        );
        const resolution =
          history === undefined
            ? undefined
            : resolveEvolutionBuildingLineage(
                lineageSelection,
                history,
                targetIndex,
                activeBuildingsById.get(lineageSelection.id),
              );
        if (
          resolution !== undefined &&
          "building" in resolution
        ) {
          activeEvolutionLineageSelection = undefined;
          cityScene.selectBuilding(resolution.building.id);
        } else if (resolution !== undefined) {
          activeEvolutionLineageSelection = resolution.selection;
          showUnavailableEvolutionBuilding(
            resolution.selection.lastKnownBuilding,
            resolution.state,
          );
        } else {
          activeEvolutionLineageSelection = undefined;
        }
      } else if (retainedAdvancedPrimaryBuildingId !== null) {
        // setProject() may promote a surviving member when the previous
        // primary does not exist in the target frame. Keep that shared
        // selection authoritative instead of restoring a stale tombstone
        // over its inspector/source context.
        activeEvolutionLineageSelection = undefined;
      }
    },
  );
}

function renderEvolutionTimeline(): void {
  const frame = activeEvolutionFrames[activeEvolutionIndex];
  const lastIndex = Math.max(0, activeEvolutionFrames.length - 1);
  const busy = evolutionLoading || evolutionSeekController.busy;
  const frameAccessState = evolutionSeekController.busy
    ? "busy"
    : sourceIsBoundToCurrentEvolutionFrame()
      ? "terminal"
      : "historical";
  if (frameAccessState !== codeInspectionFrameAccessState) {
    codeInspectionFrameAccessState = frameAccessState;
    refreshSelectedCodeInspectionFrameAccess();
  }
  evolutionRange.value = String(
    evolutionSeekController.targetIndex ?? activeEvolutionIndex,
  );
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
  const dependencyChanges = activeEvolutionDependencyChanges;
  const dependencyChangeText =
    dependencyChanges === undefined
      ? []
      : [
          dependencyTransitionCount(
            dependencyChanges.added.length,
            "added",
          ),
          dependencyTransitionCount(
            dependencyChanges.removed.length,
            "removed",
          ),
          dependencyTransitionCount(
            dependencyChanges.changed.length,
            "changed",
          ),
          dependencyTransitionCount(
            dependencyChanges.retargeted.length,
            "retargeted",
          ),
        ].filter((value): value is string => value !== undefined);
  const buildingChangeText =
    transition === undefined
      ? []
      : [
          `${transition.addedBuildingIds.length} added`,
          `${transition.removedBuildings.length} removed`,
          `${transition.renamedBuildingIds.length} renamed`,
          `${transition.resizedBuildingIds.length} resized`,
        ];
  const changeText = [
    ...buildingChangeText,
    ...dependencyChangeText,
  ].join(" \u00b7 ");
  evolutionStatus.textContent =
    evolutionSeekController.busy
      ? "Seeking\u2026"
      : evolutionSeekController.failure ??
        `${new Date(frame.committedAt).toLocaleString()}${changeText ? ` \u00b7 ${changeText}` : ""}`;
}

function dependencyTransitionCount(
  count: number,
  action: "added" | "changed" | "removed" | "retargeted",
): string | undefined {
  if (count === 0) return undefined;
  return `${count} ${count === 1 ? "dependency" : "dependencies"} ${action}`;
}

function startEvolutionPlayback(): void {
  if (
    activeEvolutionFrames.length < 2 ||
    evolutionLoading ||
    evolutionSeekController.busy
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

function stopEvolutionPlayback(cancelSeek = true): void {
  evolutionPlaying = false;
  if (cancelSeek) evolutionSeekController.cancel();
  if (evolutionPlaybackTimer !== undefined) {
    window.clearTimeout(evolutionPlaybackTimer);
    evolutionPlaybackTimer = undefined;
  }
  evolutionPlay?.setAttribute("aria-pressed", "false");
  if (evolutionPlay) evolutionPlay.textContent = "\u25b6";
}

function settleEvolutionTransition(): void {
  const hadTransition =
    activeEvolutionTransition !== undefined ||
    evolutionTransitionTimer !== undefined;
  if (evolutionTransitionTimer !== undefined) {
    window.clearTimeout(evolutionTransitionTimer);
    evolutionTransitionTimer = undefined;
  }
  activeEvolutionTransition = undefined;
  cityScene.finishEvolutionTransition();
  if (hadTransition) {
    applyVisualization();
    renderEvolutionTimeline();
  }
}

function currentEvolutionExportFrame():
  | {
      readonly label: string;
      readonly sha: string;
    }
  | undefined {
  const frame = activeEvolutionFrames[activeEvolutionIndex];
  if (frame === undefined) return undefined;
  return {
    sha: frame.sha,
    label:
      `Frame ${activeEvolutionIndex + 1}/${activeEvolutionFrames.length}` +
      ` \u00b7 ${frame.sha.slice(0, 10)} \u00b7 ${frame.committedAt}`,
  };
}

function synchronizeCameraFocusControl(): void {
  cameraFocusSelectionButton.hidden = !cityScene.selectedEntityAvailable;
  cameraFocusSelectionButton.disabled =
    sceneHost.dataset["webglAvailable"] !== "true";
}

function showUnavailableEvolutionBuilding(
  building: CityBuilding,
  state: Exclude<
    EvolutionBuildingLineageState,
    { readonly kind: "present" }
  >,
): void {
  scrubBuildingSource();
  const referenceFrameIndex =
    state.kind === "not-yet-created"
      ? state.creationFrame
      : state.removalFrame;
  const referenceFrame = activeEvolutionFrames[referenceFrameIndex];
  const referenceCommit =
    referenceFrame?.sha.slice(0, 10) ??
    `frame ${referenceFrameIndex + 1}`;
  const referenceContext = evolutionFrameReference(
    referenceFrameIndex,
  );
  inspectorEmpty.hidden = true;
  inspectorContent.hidden = false;
  districtInspectorContent.hidden = true;
  externalInspectorContent.hidden = true;
  clearSelectionButton.hidden = false;
  selectionKind.textContent =
    state.kind === "not-yet-created"
      ? "Not yet created"
      : "Removed building";
  selectionName.textContent = building.name;
  inspectorFields.name.textContent = building.name;
  inspectorFields.repository.textContent =
    state.kind === "not-yet-created"
      ? `Introduced by ${referenceCommit}`
      : `Removed by ${referenceCommit}`;
  inspectorFields.module.textContent = "Historical selection";
  inspectorFields.path.textContent = building.path;
  inspectorFields.language.textContent = languageLabel(building.language);
  inspectorFields.metricPresentation.hidden = false;
  inspectorFields.metricTechnicalDetails.open = false;
  renderBuildingMetrics(building);
  inspectorFields.hotspotsSection.hidden = true;
  inspectorFields.metricExplanation.hidden = false;
  inspectorFields.metricExplanation.textContent =
    state.kind === "not-yet-created"
      ? `The selected lineage is not present at this commit. It is introduced by commit ${referenceContext}.`
      : `The selected lineage was removed by commit ${referenceContext}. Its last known facts remain visible.`;
  inspectorFields.codeInspection.hidden = true;
  inspectorFields.unitsDetails.hidden = true;
  inspectorFields.unitsEmpty.hidden = true;
  inspectorFields.sourceDetails.hidden = true;
  inspectorFields.aiDetails.hidden = true;
  inspectorFields.sourceStructureDetails.hidden = true;
  renderBuildingEvolutionHistory(building.id);
  selectionStatus.textContent =
    state.kind === "not-yet-created"
      ? `Selected lineage ${building.name} is not yet created at this commit; it is introduced by commit ${referenceCommit}.`
      : `Selected lineage ${building.name} was removed by commit ${referenceCommit}.`;
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
      evolutionFrameIndex: activeEvolutionIndex,
      ...diagnostics,
      designSmells: activeDesignSmellDiagnostics,
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
      viewerWorkspace.showDetails({
        intent: "explicit",
        focus: true,
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
  const visibleBuildingOrder = results.flatMap((entry) =>
    entry.kind === "building" ? [entry.result.buildingId] : [],
  );
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
      button.setAttribute(
        "aria-pressed",
        String(
          advancedQueryPanel?.selection.buildingIds.includes(
            result.buildingId,
          ) ?? false,
        ),
      );
      if (
        result.buildingId === selectedExplorerBuildingId(explorerState)
      ) {
        button.setAttribute("aria-current", "true");
      }
      button.addEventListener("click", (event) => {
        const additive = event.ctrlKey || event.metaKey;
        const range = event.shiftKey;
        if (advancedQueryPanel !== undefined) {
          advancedQueryPanel.selectFromScene(result.buildingId, {
            additive,
            range,
            orderedBuildingIds: visibleBuildingOrder,
          });
          if (additive || range) return;
        }
        viewerWorkspace.showDetails({
          intent: "explicit",
          focus: true,
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
        viewerWorkspace.showDetails({
          intent: "explicit",
          focus: true,
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

function activateRepositoryTreeEntity(
  entity: SceneEntity,
  intent: AdvancedSelectionIntent,
): void {
  if (entity.kind === "building") {
    if (advancedQueryPanel !== undefined) {
      advancedQueryPanel.selectFromScene(entity.id, {
        ...intent,
        orderedBuildingIds:
          intent.orderedBuildingIds ?? activeBuildingSelectionOrder,
      });
      if (intent.additive || intent.range) return;
    }
    const next = selectExplorerBuilding(
      explorerState,
      activeModel,
      entity.id,
    );
    if (selectedExplorerBuildingId(next) === entity.id) {
      cityScene.selectBuilding(entity.id, true, true);
    }
  } else if (entity.kind === "district") {
    const next = selectExplorerDistrict(
      explorerState,
      activeModel,
      entity.id,
    );
    if (selectedExplorerDistrictId(next) === entity.id) {
      cityScene.selectDistrict(entity.id, true, true);
    }
  }
}

function clearBuildingSelection(): void {
  activeEvolutionLineageSelection = undefined;
  if (
    advancedQueryPanel !== undefined &&
    advancedQueryPanel.selection.buildingIds.length > 0
  ) {
    advancedQueryPanel.clearSelection();
    return;
  }
  cityScene.resetSelection();
  showInspector(null);
}

function advancedQueryPanelContext() {
  const primaryBuildingId =
    advancedQueryPanel?.selection.primaryBuildingId ??
    selectedExplorerBuildingId(explorerState) ??
    undefined;
  const primaryDistrictId =
    primaryBuildingId === undefined
      ? undefined
      : activeBuildingsById.get(primaryBuildingId)?.districtId;
  const selectedDistrictId =
    primaryDistrictId ??
    selectedExplorerDistrictId(explorerState) ??
    undefined;
  return {
    ...(primaryBuildingId === undefined
      ? {}
      : { selectedBuildingId: primaryBuildingId }),
    ...(selectedDistrictId === undefined
      ? {}
      : { selectedDistrictId }),
    queryContext: activeAdvancedQueryContext(),
  };
}

function activeAdvancedQueryContext(): AdvancedQueryContext {
  return {
    ...(activeEvolutionQueryChanges === undefined
      ? {}
      : { changesByBuildingId: activeEvolutionQueryChanges }),
    ...(activeDesignSmellQueryFacts === undefined
      ? {}
      : {
          smellRuleIdsByBuildingId:
            activeDesignSmellQueryFacts.ruleIdsByBuildingId,
          availableSmellRuleIdsByBuildingId:
            activeDesignSmellQueryFacts.availableRuleIdsByBuildingId,
          ruleSchemaVersion: DESIGN_SMELL_PROTOCOL_VERSION,
        }),
  };
}

function updateAdvancedQueryDesignSmells(
  evaluation: DesignSmellEvaluation | undefined,
): void {
  const next =
    evaluation === undefined
      ? undefined
      : {
          ruleIdsByBuildingId: new Map<string, Set<string>>(),
          availableRuleIdsByBuildingId:
            new Map<string, Set<string>>(),
        };
  if (evaluation !== undefined) {
    for (const finding of evaluation.visibleFindings) {
      const ruleIds = next!.ruleIdsByBuildingId.get(
        finding.buildingId,
      );
      if (ruleIds === undefined) {
        next!.ruleIdsByBuildingId.set(
          finding.buildingId,
          new Set([finding.ruleId]),
        );
      } else {
        ruleIds.add(finding.ruleId);
      }
    }
    for (const building of activeModel.buildings) {
      const available = new Set<string>();
      for (const result of evaluation.results) {
        if (
          result.enabled &&
          result.languageAvailability[building.language]
            .availability === "available" &&
          !(
            result.rule.id === "high-complexity-method" &&
            building.units === undefined
          )
        ) {
          available.add(result.rule.id);
        }
      }
      next!.availableRuleIdsByBuildingId.set(
        building.id,
        available,
      );
    }
  }
  if (
    equalDesignSmellQueryFacts(
      activeDesignSmellQueryFacts,
      next,
    )
  ) {
    return;
  }
  activeDesignSmellQueryFacts = next;
  advancedQueryPanel?.refreshContext();
}

function equalDesignSmellQueryFacts(
  left:
    | {
        readonly ruleIdsByBuildingId: ReadonlyMap<
          string,
          ReadonlySet<string>
        >;
        readonly availableRuleIdsByBuildingId: ReadonlyMap<
          string,
          ReadonlySet<string>
        >;
      }
      | undefined,
  right:
    | {
        readonly ruleIdsByBuildingId: ReadonlyMap<
          string,
          ReadonlySet<string>
        >;
        readonly availableRuleIdsByBuildingId: ReadonlyMap<
          string,
          ReadonlySet<string>
        >;
      }
      | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    equalRuleIdsByBuilding(
      left.ruleIdsByBuildingId,
      right.ruleIdsByBuildingId,
    ) &&
    equalRuleIdsByBuilding(
      left.availableRuleIdsByBuildingId,
      right.availableRuleIdsByBuildingId,
    )
  );
}

function equalRuleIdsByBuilding(
  left: ReadonlyMap<string, ReadonlySet<string>>,
  right: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [buildingId, rightRuleIds] of right) {
    const leftRuleIds = left.get(buildingId);
    if (
      leftRuleIds === undefined ||
      leftRuleIds.size !== rightRuleIds.size
    ) {
      return false;
    }
    for (const ruleId of rightRuleIds) {
      if (!leftRuleIds.has(ruleId)) return false;
    }
  }
  return true;
}

function evolutionQueryChanges(
  transition: EvolutionTransition,
): ReadonlyMap<string, ReadonlySet<AdvancedQueryChangeKind>> {
  const changes = new Map<
    string,
    Set<AdvancedQueryChangeKind>
  >();
  const add = (
    ids: readonly string[],
    kind: AdvancedQueryChangeKind,
  ): void => {
    for (const id of ids) {
      const existing = changes.get(id);
      if (existing === undefined) changes.set(id, new Set([kind]));
      else existing.add(kind);
    }
  };
  add(transition.addedBuildingIds, "added");
  add(transition.changedBuildingIds, "changed");
  add(
    transition.removedBuildings.map(({ id }) => id),
    "removed",
  );
  return changes;
}

function applyAdvancedSelection(
  selection: AdvancedSelectionState,
): void {
  applyingAdvancedSelection = true;
  try {
    cityScene.setBuildingGroupHighlight(
      selection.buildingIds,
      selection.overlayVisible,
    );
    if (cityScene.buildingSelectionIsolated) {
      if (selection.buildingIds.length === 0) {
        cityScene.showAllBuildings(false);
      } else {
        cityScene.isolateBuildings(selection.buildingIds, false);
      }
    }
    if (
      selection.primaryBuildingId !== null &&
      activeBuildingsById.has(selection.primaryBuildingId)
    ) {
      cityScene.selectBuilding(
        selection.primaryBuildingId,
        false,
        false,
      );
    } else if (selectedExplorerBuildingId(explorerState) !== null) {
      cityScene.resetSelection();
      showInspector(null);
    }
  } finally {
    applyingAdvancedSelection = false;
  }
  synchronizeAdvancedSelectionMembership(selection.buildingIds);
  renderDependencyExplorer();
  const selectedFindingBuilding =
    designSmellWorkspaceActive &&
    selection.buildingIds.length === 1 &&
    selection.primaryBuildingId !== null
      ? activeBuildingsById.get(selection.primaryBuildingId)
      : undefined;
  if (selectedFindingBuilding !== undefined) {
    selectionStatus.textContent = buildingSelectionStatus(
      selectedFindingBuilding,
    );
  } else {
    selectionStatus.textContent =
      selection.buildingIds.length === 0
        ? "Selection cleared."
        : `${selection.buildingIds.length.toLocaleString()} ${
            selection.buildingIds.length === 1
              ? "building"
              : "buildings"
          } selected.`;
  }
}

function synchronizeAdvancedSelectionMembership(
  buildingIds: readonly string[],
): void {
  const selected = new Set(buildingIds);
  for (const button of searchResultButtons()) {
    const buildingId = button.dataset["buildingId"];
    if (buildingId !== undefined) {
      button.setAttribute(
        "aria-pressed",
        String(selected.has(buildingId)),
      );
    }
  }
  repositoryHierarchyTree.synchronize(explorerState, buildingIds);
}

function synchronizeExplorerState(state: ExplorerState): void {
  const previousSelectedBuildingId =
    selectedExplorerBuildingId(explorerState);
  explorerState = state;
  synchronizeAdvancedQueryIsolationControl();
  if (state.selectedEntity !== null) {
    activeEvolutionLineageSelection = undefined;
  }
  repositoryHierarchyTree.synchronize(
    state,
    advancedQueryPanel?.selection.buildingIds,
  );
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
  synchronizeCameraFocusControl();
  imageExportDialog.invalidate();
  for (const button of searchResultButtons()) {
    if (
      button.dataset["buildingId"] === selectedBuildingId ||
      button.dataset["districtId"] === selectedDistrictId
    ) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
    const buildingId = button.dataset["buildingId"];
    if (buildingId !== undefined) {
      button.setAttribute(
        "aria-pressed",
        String(
          advancedQueryPanel?.selection.buildingIds.includes(
            buildingId,
          ) ?? false,
        ),
      );
    }
  }
  if (
    !applyingAdvancedSelection &&
    selectedBuildingId !== null &&
    advancedQueryPanel !== undefined &&
    advancedQueryPanel.selection.primaryBuildingId !== selectedBuildingId
  ) {
    advancedQueryPanel.selectFromScene(selectedBuildingId);
  } else if (
    !applyingAdvancedSelection &&
    selectedBuildingId === null &&
    state.selectedEntity !== null &&
    advancedQueryPanel !== undefined &&
    advancedQueryPanel.selection.buildingIds.length > 0
  ) {
    advancedQueryPanel.clearSelection();
  }
  repositoryHierarchyTree.synchronize(
    state,
    advancedQueryPanel?.selection.buildingIds,
  );
  renderExternalNodeList();
  renderDependencyExplorer();
  renderDistrictDependencyExplorer();
  renderViewerOverview();
}

function synchronizeAdvancedQueryIsolationControl(): void {
  const active = cityScene.buildingSelectionIsolated;
  advancedQueryIsolateButton.textContent = active
    ? "Show all buildings"
    : "Isolate selection";
  advancedQueryIsolateButton.setAttribute(
    "aria-pressed",
    String(active),
  );
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
  );
  const initiallyVisibleBundles = summary.bundles.slice(
    0,
    districtRouteVisibleLimit,
  );
  const selectedBundle =
    selectedDistrictDependencyBundleId === null
      ? undefined
      : summary.bundles.find(
          ({ id }) => id === selectedDistrictDependencyBundleId,
        );
  const visibleBundles =
    selectedBundle !== undefined &&
    initiallyVisibleBundles.length > 0 &&
    !initiallyVisibleBundles.some(
      ({ id }) => id === selectedBundle.id,
    )
      ? [
          ...initiallyVisibleBundles.slice(0, -1),
          selectedBundle,
        ]
      : initiallyVisibleBundles;
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
      "No routes match the selected kinds.";
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
  const advancedIds =
    advancedQueryPanel?.selection.buildingIds ?? [];
  if (advancedIds.length > 1) {
    const summary = dependencyRoutesForBuildings(
      dependencyExplorerIndex,
      advancedIds,
    );
    const count =
      direction === "incoming"
        ? summary.incomingCount
        : summary.outgoingCount;
    if (count === 0) return;
    dependencyRouteState = toggleDependencyRouteDirection(
      dependencyRouteState,
      direction,
    );
    renderDependencyExplorer();
    return;
  }
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
  const advancedIds =
    advancedQueryPanel?.selection.buildingIds ?? [];
  if (advancedIds.length > 1) {
    renderMultiSelectionDependencyExplorer(advancedIds);
    return;
  }
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
    );
    overlayRoutes.push(dependencyOverlayRoute(route, projection));
    dependencyList.append(dependencyListItem(route));
  }
  cityScene.replaceDependencyRoutes(overlayRoutes);
}

function renderMultiSelectionDependencyExplorer(
  buildingIds: readonly string[],
): void {
  const summary = dependencyRoutesForBuildings(
    dependencyExplorerIndex,
    buildingIds,
    dependencyRouteState,
  );
  updateDependencyToggle(
    dependencyIncomingToggle,
    dependencyIncomingCount,
    summary.incomingCount,
    dependencyRouteState.incoming,
  );
  updateDependencyToggle(
    dependencyOutgoingToggle,
    dependencyOutgoingCount,
    summary.outgoingCount,
    dependencyRouteState.outgoing,
  );
  dependencyEmpty.hidden =
    summary.incomingCount + summary.outgoingCount > 0;
  dependencyList.hidden = summary.routes.length === 0;

  if (
    !dependencyRouteState.incoming &&
    !dependencyRouteState.outgoing
  ) {
    dependencyStatus.textContent =
      `${buildingIds.length.toLocaleString()} selected buildings; ` +
      `${summary.incomingCount.toLocaleString()} incoming and ` +
      `${summary.outgoingCount.toLocaleString()} outgoing routes hidden.`;
    cityScene.replaceDependencyRoutes([]);
    return;
  }

  const overlayRoutes: DependencyOverlayRoute[] = [];
  for (const { selectedBuildingId, route } of summary.routes) {
    const projection = projectDependencyRoute(
      dependencyExplorerIndex,
      selectedBuildingId,
      route,
    );
    overlayRoutes.push(dependencyOverlayRoute(route, projection));
    dependencyList.append(dependencyListItem(route));
  }
  const omittedCount = summary.totalCount - summary.routes.length;
  dependencyStatus.textContent =
    `Showing ${summary.routes.length.toLocaleString()} unique routes from ` +
    `${buildingIds.length.toLocaleString()} selected buildings` +
    (omittedCount > 0
      ? `; ${omittedCount.toLocaleString()} omitted by the global route limit.`
      : ".");
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
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "dependency-item";
  const sourceBuilding = activeBuildingsById.get(route.sourceBuildingId);

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
      viewerWorkspace.showDetails({
        intent: "explicit",
        focus: true,
      });
      cityScene.selectExternalNode(node.id);
    });
  } else if (route.counterpart.kind === "building") {
    const counterpartBuildingId = route.counterpart.buildingId;
    row.addEventListener("click", () => {
      viewerWorkspace.showDetails({
        intent: "explicit",
        focus: true,
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
    referenceCountLabel(route.weight);

  row.setAttribute(
    "aria-label",
    `${name.textContent}, ${
      isExternal ? "external provider" : role.toLowerCase()
    }, ${referenceCountLabel(route.weight)}`,
  );
  content.append(name, path, meta);
  row.append(direction, content);
  // Dependency navigation remains available on the route row. Analyzer data
  // has no exact dependency source range, so the client deliberately exposes
  // no AI action for this context.
  item.append(row);
  return item;
}

function dependencyOverlayRoute(
  route: SelectedDependencyRoute,
  projection: DependencyRouteProjection,
): DependencyOverlayRoute {
  const changedInEvolution =
    activeEvolutionTargetDependencyIds.has(route.dependencyId);
  return {
    id: `${route.dependencyId}:${route.direction}`,
    consumer: dependencyEndpointGeometry(projection.source),
    provider: dependencyEndpointGeometry(projection.target),
    direction: route.direction,
    weight: route.weight,
    externalProvider: route.counterpart.kind === "external",
    ...(changedInEvolution
      ? {
          color: EVOLUTION_DEPENDENCY_ROUTE_COLOR,
          emphasized: true,
        }
      : {}),
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
  const changedInEvolution = bundle.dependencyIds.some((dependencyId) =>
    activeEvolutionTargetDependencyIds.has(dependencyId),
  );
  return {
    id: bundle.id,
    consumer: geometry.consumer,
    provider: geometry.provider,
    direction: "outgoing",
    weight: bundle.weight,
    externalProvider,
    color: changedInEvolution
      ? EVOLUTION_DEPENDENCY_ROUTE_COLOR
      : districtDependencyRouteColor(bundle),
    emphasized:
      changedInEvolution ||
      bundle.id === selectedDistrictDependencyBundleId,
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
    case "external":
      return endpoint.target;
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
  activeLegendEntries = Object.freeze(
    groups.map(({ color, label }) =>
      Object.freeze({ color, label }),
    ),
  );

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

function synchronizeVisualizationModeOptions(): boolean {
  const availableModes = availableViewerVisualizationModes(
    {
      evolution: activeEvolutionAnalysis !== undefined,
      printProfile:
        printVisualizationContextActive &&
        previewPrinterProfile !== undefined,
    },
    activeModel,
  );
  const modeChanged = !availableModes.includes(visualizationMode);
  if (modeChanged) visualizationMode = "semantic";
  visualizationModeSelect.replaceChildren(
    ...availableModes.map((mode) => {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = viewerVisualizationModeLabel(mode, activeModel);
      return option;
    }),
  );
  visualizationModeField.hidden = availableModes.length === 1;
  visualizationModeSelect.value = visualizationMode;
  return modeChanged;
}

function applyVisualization(): void {
  const visualization = createViewerVisualization(
    activeModel,
    visualizationMode,
    previewPrinterProfile,
    activeEvolutionAnalysis,
  );
  let colors = new Map(visualization.colorsByBuildingId);
  const transition = activeEvolutionTransition;
  const dependencyChanges =
    transition?.dependencyChanges ??
    activeEvolutionDependencyChanges;
  const dependencyChangeCount =
    dependencyChanges === undefined
      ? 0
      : dependencyChanges.added.length +
        dependencyChanges.removed.length +
        dependencyChanges.changed.length +
        dependencyChanges.retargeted.length;
  if (dependencyChanges !== undefined && dependencyChangeCount > 0) {
    dependencyChanges.affectedEndpoints.forEach((endpoint) => {
      if (
        endpoint.kind === "entity" &&
        endpoint.entityKind === "building"
      ) {
        colors.set(endpoint.id, EVOLUTION_DEPENDENCY_ROUTE_COLOR);
      }
    });
  }
  if (transition !== undefined) {
    transition.changedBuildingIds.forEach((id) => colors.set(id, "#a78bfa"));
    transition.resizedBuildingIds.forEach((id) => colors.set(id, "#fbbf24"));
    transition.renamedBuildingIds.forEach((id) => colors.set(id, "#22d3ee"));
    transition.addedBuildingIds.forEach((id) => colors.set(id, "#4ade80"));
  }
  const extension = activeSafeExtensionEvaluation;
  extension?.application.buildings.forEach((building) => {
    if (building.color !== undefined) colors.set(building.id, building.color);
  });
  const baseVisualizationLabel =
    extension === undefined
      ? visualization.label
      : `Extension: ${extension.configuration.name}`;
  if (designSmellWorkspaceActive) {
    colors = new Map(activeDesignSmellVisualization.colorsByBuildingId);
  }
  const visualizationLabel = designSmellWorkspaceActive
    ? "Design smells · highest visible severity"
    : baseVisualizationLabel;
  cityScene.setVisualization(
    colors,
    visualizationLabel,
  );
  activeVisualizationLabel = visualizationLabel;
  activeDesignSmellDiagnostics = designSmellBuildingDiagnostics(
    activeDesignSmellVisualization,
    designSmellWorkspaceActive,
  );
  const transitionStatus =
    transition === undefined && dependencyChangeCount === 0
      ? ""
      : " Current-frame changes override the mode colors.";
  const extensionStatus =
    extension === undefined
      ? ""
      :
        ` Declarative extension preview applied ` +
        `(${extension.application.mappings.length} mappings, ` +
        `${extension.application.layouts.length} layouts, ` +
        `${extension.application.overlays.length} overlays).`;
  visualizationModeStatus.textContent = designSmellWorkspaceActive
    ? `Findings temporarily replace ${baseVisualizationLabel} colors. ` +
      "Each building shows its highest visible severity under the current " +
      "rules and filters; gray means no visible finding, not verified clean."
    : visualization.status + transitionStatus + extensionStatus;
  visualizationModeSelect.setAttribute(
    "aria-invalid",
    visualization.available ? "false" : "true",
  );
  legend.setAttribute(
    "aria-label",
    `${visualizationLabel} legend`,
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
      label: "Building data changed",
      color: "#a78bfa",
      priority: 101,
    });
  }
  if (dependencyChanges !== undefined && dependencyChangeCount > 0) {
    changeGroups.push({
      id: "evolution-dependency-changed",
      label:
        `${dependencyChangeCount.toLocaleString()} dependency route ` +
        `${dependencyChangeCount === 1 ? "change" : "changes"} ` +
        `(${dependencyChanges.added.length} added, ` +
        `${dependencyChanges.removed.length} removed, ` +
        `${dependencyChanges.changed.length} changed, ` +
        `${dependencyChanges.retargeted.length} retargeted)`,
      color: EVOLUTION_DEPENDENCY_ROUTE_COLOR,
      priority: 100,
    });
  }
  const extensionGroups: SemanticGroup[] = [];
  extension?.application.legends.forEach((entry, index) => {
    extensionGroups.push(
      {
        id: `extension-${entry.id}-minimum`,
        label: `${entry.label}: ${entry.minimum.toLocaleString("en-US")} (minimum)`,
        color: entry.minimumColor,
        priority: 130 - index * 2,
      },
      {
        id: `extension-${entry.id}-maximum`,
        label: `${entry.label}: ${entry.maximum.toLocaleString("en-US")} (maximum)`,
        color: entry.maximumColor,
        priority: 129 - index * 2,
      },
    );
  });
  extension?.application.overlays.forEach((entry, index) => {
    extensionGroups.push({
      id: `extension-${entry.id}-overlay`,
      label:
        `${entry.id} overlay · ` +
        `${entry.buildingIds.length.toLocaleString("en-US")} matches`,
      color: entry.color,
      priority: 160 - index,
    });
  });
  renderLegend(
    activeModel,
    designSmellWorkspaceActive
      ? DESIGN_SMELL_BUILDING_LEGEND
      : [
          ...extensionGroups,
          ...changeGroups,
          ...visualization.legend,
        ],
  );
}

function renderViewerOverview(): void {
  const summary = summarizeViewerOverview(activeModel);
  overviewFields.description.textContent =
    "Metrics for the whole city.";
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

function sourceIsBoundToCurrentEvolutionFrame(): boolean {
  return !evolutionSeekController.busy &&
    (activeEvolutionFrames.length === 0 ||
      activeEvolutionIndex === activeEvolutionFrames.length - 1);
}

function retainedSourceActionAvailable(): boolean {
  return activeModelSource.jobId !== undefined &&
    activeModelSource.sourceAvailability === "retained" &&
    sourceIsBoundToCurrentEvolutionFrame();
}

function sourceAvailabilityMessage(): string {
  if (
    activeModelSource.sourceAvailability === "retained" &&
    evolutionSeekController.busy
  ) {
    return "Retained source and AI guidance are temporarily unavailable while Code City changes repository history frames.";
  }
  if (
    activeModelSource.sourceAvailability === "retained" &&
    !sourceIsBoundToCurrentEvolutionFrame()
  ) {
    return "Retained source and AI guidance are unavailable for historical frames because this import binds source only to the latest revision. Return to the final frame to inspect source.";
  }
  if (activeModelSource.sourceAvailability === "retained") {
    return "Retained source is available. Select Open retained source above to load it, or use a source action.";
  }
  if (activeModelSource.sourceAvailability === "disabled") {
    return "Source retention is disabled for this deployment; provenance and metrics remain available.";
  }
  if (activeModelSource.sourceAvailability === "model-only") {
    return "This model-only import contains no retained source. Import the repository or a repository ZIP to enable source navigation.";
  }
  if (activeModelSource.sourceAvailability === "removed") {
    return "The retained source result was removed from the server.";
  }
  if (activeModelSource.sourceAvailability === "unavailable") {
    return "No retained source snapshot was captured for this imported result. Re-import the repository to enable source navigation.";
  }

  if (activeModelSource.sourceAvailability === "not-captured") {
    return "This model-only import did not capture source files; import a repository archive or remote repository to enable navigation.";
  }
  return "Source is unavailable for models opened directly in the viewer.";
}

function synchronizeSourceOpenAvailability(
  building?: CityBuilding,
): void {
  inspectorFields.sourceOpen.disabled = !retainedSourceActionAvailable();
  inspectorFields.sourceOpen.title = inspectorFields.sourceOpen.disabled
    ? sourceAvailabilityMessage()
    : building === undefined
      ? "Open the exact retained file for the selected building."
      : `Open the exact retained file for ${building.path}.`;
}

function refreshSelectedCodeInspectionFrameAccess(): void {
  const building = selectedInspectionBuilding();
  if (building === undefined) return;
  scrubBuildingSource(false);
  codeInspectionBuildingId = building.id;
  setCodeInspectionFocus(building, fileInspectionFocus(building.id));
  inspectorFields.sourceSummary.textContent = evolutionSeekController.busy
    ? "Changing frame"
    : sourceIsBoundToCurrentEvolutionFrame()
      ? "Not loaded"
      : "Historical frame";
  inspectorFields.sourceStatus.textContent = sourceAvailabilityMessage();
  synchronizeSourceOpenAvailability(building);
  const complexity = presentBuildingComplexity(building, {
    visibleLimit: executableUnitVisibleLimit,
    query: executableUnitQuery,
    sort: executableUnitSort,
  });
  renderComplexityHotspots(building, complexity);
  renderExecutableUnits(building, complexity);
  renderSourceStructure(building);
  if (sourceIsBoundToCurrentEvolutionFrame()) {
    discoverAiGuidanceCapability(building);
  }
}

function scrubBuildingSource(closeDetails = true): void {
  sourceRequest?.controller.abort();
  sourceRequest = undefined;
  loadedBuildingSource = undefined;
  if (closeDetails) inspectorFields.sourceDetails.open = false;
  inspectorFields.sourceSummary.textContent =
    activeModelSource.sourceAvailability === "retained" &&
      !sourceIsBoundToCurrentEvolutionFrame()
      ? "Historical frame"
      : activeModelSource.sourceAvailability === "retained"
      ? "Select a building"
      : "Unavailable";
  inspectorFields.sourceStatus.textContent =
    sourceAvailabilityMessage();
  synchronizeSourceOpenAvailability(selectedInspectionBuilding());
  inspectorFields.sourceCode.replaceChildren();
  resetAiGuidancePresentation();
  codeInspectionFocus = undefined;
  selectedSourceDeclaration = undefined;
  fineDetailDrilledBuildingId = undefined;
  decisionSiteVisibleLimit = INITIAL_DECISION_SITE_VISIBLE_LIMIT;
  inspectorFields.decisionEvidence.hidden = true;
  inspectorFields.decisionEvidenceEquation.textContent = "";
  inspectorFields.decisionEvidenceStatus.textContent = "";
  inspectorFields.decisionSites.replaceChildren();
  inspectorFields.decisionSitesShowMore.hidden = true;
  inspectorFields.sourceStructureReturn.hidden = true;
  inspectorFields.sourcePath.textContent = "";
  inspectorFields.sourceRevision.textContent = "";
  inspectorFields.sourceExternal.removeAttribute("href");
  inspectorFields.sourceEditor.removeAttribute("href");
  inspectorFields.sourceExternal.hidden = true;
  inspectorFields.sourceEditor.hidden = true;
  inspectorFields.sourceContent.hidden = true;
}

function resetAiGuidancePresentation(): void {
  aiGuidanceGeneration += 1;
  aiGuidanceRequest?.abort();
  aiGuidanceRequest = undefined;
  inspectorFields.aiDetails.open = false;
  inspectorFields.aiDetails.hidden = true;
  inspectorFields.aiSummary.textContent = "";
  inspectorFields.aiStatus.textContent = "";
  inspectorFields.aiPreview.hidden = true;
  inspectorFields.aiPreview.textContent = "";
  inspectorFields.aiPrepare.hidden = true;
  inspectorFields.aiPrepare.disabled = false;
  inspectorFields.aiPrepare.onclick = null;
  inspectorFields.aiRequest.hidden = true;
  inspectorFields.aiRequest.disabled = false;
  inspectorFields.aiRequest.onclick = null;
  inspectorFields.aiProviderLabel.hidden = true;
  inspectorFields.aiProvider.disabled = false;
  inspectorFields.aiProvider.onchange = null;
  inspectorFields.aiProvider.replaceChildren();
  inspectorFields.aiSuggestions.hidden = true;
  inspectorFields.aiSuggestions.replaceChildren();
}

function clearAiGuidanceResult(): void {
  aiGuidanceGeneration += 1;
  aiGuidanceRequest?.abort();
  aiGuidanceRequest = undefined;
  inspectorFields.aiPreview.hidden = true;
  inspectorFields.aiPreview.textContent = "";
  inspectorFields.aiRequest.hidden = true;
  inspectorFields.aiRequest.disabled = false;
  inspectorFields.aiRequest.onclick = null;
  inspectorFields.aiProvider.disabled = false;
  inspectorFields.aiPrepare.disabled = false;
  inspectorFields.aiSuggestions.hidden = true;
  inspectorFields.aiSuggestions.replaceChildren();
}

function selectedInspectionBuilding(): CityBuilding | undefined {
  const selectedId = selectedExplorerBuildingId(explorerState);
  return selectedId === null
    ? undefined
    : activeBuildingsById.get(selectedId);
}

function renderAiGuidanceCapability(building: CityBuilding): void {
  const capability = aiProviderDiscovery.capability;
  const wasOpen = inspectorFields.aiDetails.open;
  const selectedProvider = inspectorFields.aiProvider.value;
  clearAiGuidanceResult();
  if (
    capability.state !== "configured" ||
    selectedInspectionBuilding()?.id !== building.id
  ) {
    inspectorFields.aiDetails.hidden = true;
    inspectorFields.aiDetails.open = false;
    inspectorFields.aiProviderLabel.hidden = true;
    inspectorFields.aiPrepare.hidden = true;
    return;
  }

  if (!sourceIsBoundToCurrentEvolutionFrame()) {
    inspectorFields.aiDetails.hidden = true;
    inspectorFields.aiDetails.open = false;
    inspectorFields.aiSummary.textContent = "";
    inspectorFields.aiStatus.textContent = "";
    inspectorFields.aiProviderLabel.hidden = true;
    inspectorFields.aiProvider.replaceChildren();
    inspectorFields.aiPrepare.hidden = true;
    inspectorFields.aiPrepare.onclick = null;
    return;
  }

  inspectorFields.aiDetails.hidden = false;
  inspectorFields.aiDetails.open = wasOpen;
  inspectorFields.aiSummary.textContent = "Available";
  inspectorFields.aiProvider.replaceChildren();
  for (const provider of capability.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    inspectorFields.aiProvider.append(option);
  }
  if (capability.providers.some(({ id }) => id === selectedProvider)) {
    inspectorFields.aiProvider.value = selectedProvider;
  }
  inspectorFields.aiProviderLabel.hidden = false;
  const focus = codeInspectionFocus;
  const context = focus === undefined
    ? undefined
    : codeInspectionAiContext(building, focus);
  const eligible =
    retainedSourceActionAvailable() &&
    context !== undefined;
  inspectorFields.aiPrepare.hidden = !eligible;
  inspectorFields.aiStatus.textContent = eligible
    ? "Prepare an exact server-verified preview explicitly. No source is sent to the provider until you confirm the one-time send. Code City does not persist prompts; provider retention depends on your configured provider."
    : "AI guidance is available, but this focus has no exact server-resolvable retained-source context. Deterministic findings remain available.";
  inspectorFields.aiProvider.onchange = () => {
    clearAiGuidanceResult();
    inspectorFields.aiSummary.textContent = "Available";
    inspectorFields.aiPrepare.hidden = !eligible;
    inspectorFields.aiStatus.textContent = eligible
      ? "Provider changed. Prepare a new exact preview explicitly before sending."
      : "This focus has no exact server-resolvable retained-source context.";
  };
  inspectorFields.aiPrepare.onclick = eligible && context !== undefined
    ? () => prepareAiGuidancePreview(building, context)
    : null;
}

function discoverAiGuidanceCapability(building: CityBuilding): void {
  if (!sourceIsBoundToCurrentEvolutionFrame()) {
    renderAiGuidanceCapability(building);
    return;
  }
  inspectorFields.aiDetails.hidden = true;
  void aiProviderDiscovery.discover().then(() => {
    if (selectedInspectionBuilding()?.id === building.id) {
      renderAiGuidanceCapability(building);
    }
  });
}

function markActiveSourceResultRemoved(jobId: string): void {
  const nextSource = sourceOwnerAfterResultRemoval(
    activeModelSource,
    jobId,
  );
  if (nextSource === activeModelSource) return;
  activeModelSource = nextSource;
  scrubBuildingSource();
}

function renderSourceCode(
  building: CityBuilding,
  source: BuildingSource,
): void {
  const focus = codeInspectionFocus ?? fileInspectionFocus(building.id);
  const resolved = resolveCodeInspectionFocus(building, focus);
  if (resolved === undefined) {
    inspectorFields.sourceCode.replaceChildren();
    inspectorFields.sourceSummary.textContent = "No exact range";
    inspectorFields.sourceStatus.textContent =
      "The selected code focus has no current persisted source range. Choose Open retained source above to inspect the file.";
    return;
  }
  inspectorFields.sourceCode.replaceChildren();
  const {
    firstLine,
    lastLine,
    omittedBefore,
    omittedAfter,
    lines,
  } = extractSourceLineWindow(
    source.text,
    focus.kind === "unit" && focus.selectedSiteIndex !== undefined
      ? (resolved.exactRange?.startLine ?? resolved.contextualRange.startLine)
      : resolved.contextualRange.startLine,
    focus.kind === "unit" && focus.selectedSiteIndex !== undefined
      ? (resolved.exactRange?.endLine ?? resolved.contextualRange.endLine)
      : resolved.contextualRange.endLine,
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
  let remainingCharacters = SOURCE_RENDERED_CHARACTER_LIMIT;
  let remainingTokens = SOURCE_RENDERED_TOKEN_LIMIT;
  for (const sourceLine of lines) {
    const { lineNumber, text } = sourceLine;
    if (remainingCharacters === 0 || remainingTokens === 0) {
      appendOmitted(
        `Lines ${lineNumber.toLocaleString()}\u2013${lastLine.toLocaleString()} omitted at the viewer rendering limit`,
      );
      break;
    }
    const line = document.createElement("span");
    line.className = "source-line";
    line.dataset["line"] = String(lineNumber);
    if (
      lineNumber >= resolved.contextualRange.startLine &&
      lineNumber <= resolved.contextualRange.endLine
    ) {
      line.classList.add("source-line-highlight");
      if (resolved.exactRange !== undefined) {
        line.classList.add("source-column-aware");
      }
    }
    const markers = [
      ...resolved.decisionMarkers,
      ...(resolved.exactRange === undefined ||
      resolved.decisionMarkers.some(({ selected }) => selected)
        ? []
        : [{ id: "focus", range: resolved.exactRange, selected: true }]),
    ];
    const presentation = presentHighlightedSourceLine(
      text,
      lineNumber,
      markers,
      remainingCharacters,
      remainingTokens,
    );
    for (const token of presentation.tokens) {
      const span = document.createElement("span");
      if (token.kind !== "text") {
        span.classList.add(`source-token-${token.kind}`);
      }
      if (token.markerIds.length > 0) {
        span.classList.add("source-decision-marker");
      }
      if (token.selected) {
        span.classList.add("source-range-highlight");
        span.classList.add("source-decision-marker-selected");
      }
      span.textContent = token.text;
      line.append(span);
    }
    remainingCharacters -= presentation.text.length;
    remainingTokens -= presentation.tokens.length;
    if (presentation.omittedCharacters > 0) {
      const marker = document.createElement("span");
      marker.className = "source-line-truncated";
      marker.textContent =
        ` \u2026 [${presentation.omittedCharacters.toLocaleString()} characters omitted from this line at the viewer limit]`;
      line.append(marker);
    } else if (!presentation.syntaxHighlighted) {
      const marker = document.createElement("span");
      marker.className = "source-line-truncated";
      marker.textContent =
        " [syntax highlighting omitted at the viewer token limit]";
      line.append(marker);
    }
    if (text === "") line.append("\u200b");
    inspectorFields.sourceCode.append(line);
  }
  if (omittedAfter > 0) {
    appendOmitted(sourceOmissionMarker(omittedAfter, "later"));
  }
  inspectorFields.sourceCode
    .querySelector<HTMLElement>(`[data-line="${resolved.scrollLine}"]`)
    ?.scrollIntoView({ block: "center" });
}

function prepareAiGuidancePreview(
  building: CityBuilding,
  context: ViewerAiGuidanceContext,
): void {
  const jobId = activeModelSource.jobId;
  const focus = codeInspectionFocus;
  if (
    jobId === undefined ||
    !retainedSourceActionAvailable() ||
    focus === undefined ||
    codeInspectionAiContext(building, focus) === undefined
  ) return;
  clearAiGuidanceResult();
  const controller = new AbortController();
  aiGuidanceRequest = controller;
  inspectorFields.aiPrepare.disabled = true;
  const focusGeneration = ++aiGuidanceGeneration;
  const focusKey = codeInspectionFocusKey(focus);
  const stillCurrent = (): boolean =>
    !controller.signal.aborted &&
    aiGuidanceRequest === controller &&
    aiGuidanceGeneration === focusGeneration &&
    codeInspectionFocus !== undefined &&
    codeInspectionFocusKey(codeInspectionFocus) === focusKey;
  let previewRequest: AbortController | undefined;
  let previewGeneration = 0;
  controller.signal.addEventListener("abort", () => previewRequest?.abort(), { once: true });
  inspectorFields.aiSummary.textContent = "Preparing preview";
  inspectorFields.aiDetails.open = true;
  inspectorFields.aiStatus.textContent = "No source has been sent to an AI provider.";
  const loadPreview = (providerId: string): void => {
    previewRequest?.abort();
    const generation = ++previewGeneration;
    const previewController = new AbortController();
    previewRequest = previewController;
    if (controller.signal.aborted) previewController.abort();
    inspectorFields.aiRequest.hidden = true;
    inspectorFields.aiRequest.onclick = null;
    inspectorFields.aiPreview.hidden = true;
    inspectorFields.aiStatus.textContent = "Preparing exact server-verified preview…";
    void sourceApi.aiGuidancePreview(jobId, context, providerId, previewController.signal)
      .then((value) => {
        if (!stillCurrent() || previewController.signal.aborted || generation !== previewGeneration || inspectorFields.aiProvider.value !== providerId) return;
        const preview = value.preview;
        if (!preview.enabled) {
          resetAiGuidancePresentation();
          return;
        }
        if (preview.provider.id !== providerId) throw new Error("AI guidance preview was invalid.");
        if (preview.availability === "unavailable") {
          inspectorFields.aiSummary.textContent = "Context unavailable";
          inspectorFields.aiStatus.textContent = `${preview.reason} No source was sent to an AI provider.`;
          inspectorFields.aiPreview.textContent = JSON.stringify({ context: preview.context, availability: preview.availability, reason: preview.reason }, null, 2);
          inspectorFields.aiPreview.hidden = false;
          return;
        }
        const grant = preview.grant;
        if (preview.transmission.providerId !== providerId) throw new Error("AI guidance transmission did not match its provider.");
        inspectorFields.aiSummary.textContent = "Preview ready";
        inspectorFields.aiPrepare.disabled = false;
        inspectorFields.aiStatus.textContent = `This exact server-verified source and findings will be sent once to ${preview.provider.label} after you confirm.`;
        inspectorFields.aiPreview.textContent = JSON.stringify(preview.transmission, null, 2);
        inspectorFields.aiPreview.hidden = false;
        inspectorFields.aiRequest.hidden = false;
        inspectorFields.aiRequest.disabled = false;
        inspectorFields.aiRequest.onclick = () => {
          if (!stillCurrent() || generation !== previewGeneration || inspectorFields.aiProvider.value !== providerId) return;
          inspectorFields.aiRequest.onclick = null;
          inspectorFields.aiRequest.disabled = true;
          inspectorFields.aiProvider.disabled = true;
          inspectorFields.aiStatus.textContent = "Requesting optional suggestions…";
          const expectedTransmission = preview.transmission;
          void sourceApi.aiGuidanceRequest(
            grant,
            preview.limits.timeoutMs,
            controller.signal,
          )
          .then((result) => {
            if (!stillCurrent() || generation !== previewGeneration) return;
            if (
              result.result.provider.id !== providerId ||
              result.result.contextDigest !== expectedTransmission.contextDigest ||
              result.result.findingDigest !== expectedTransmission.findingDigest ||
              JSON.stringify(result.result.context) !== JSON.stringify(expectedTransmission.context) ||
              result.result.suggestions.some(({ citation }) => citation.path !== expectedTransmission.source.path || citation.startLine !== expectedTransmission.context.range.startLine || citation.endLine !== expectedTransmission.context.range.endLine)
            ) throw new Error("AI provider response did not match the selected context.");
            const suggestions = result.result.suggestions;
            inspectorFields.aiSuggestions.replaceChildren();
            for (const suggestion of suggestions) {
              if (typeof suggestion.title !== "string" || typeof suggestion.detail !== "string") continue;
              const item = document.createElement("li");
              const citation = suggestion.citation;
              item.textContent = `${suggestion.title}: ${suggestion.detail}` + (citation?.path === undefined ? "" : ` (${citation.path}:${citation.startLine}–${citation.endLine})`);
              inspectorFields.aiSuggestions.append(item);
            }
            inspectorFields.aiSuggestions.hidden = false;
            inspectorFields.aiRequest.hidden = true;
            inspectorFields.aiSummary.textContent = "Suggestions";
            inspectorFields.aiStatus.textContent = "Suggestions are optional; deterministic findings above are unchanged.";
          })
          .catch(() => {
            if (stillCurrent()) {
              clearAiGuidanceResult();
              inspectorFields.aiDetails.hidden = false;
              inspectorFields.aiDetails.open = true;
              inspectorFields.aiPrepare.hidden = false;
              inspectorFields.aiPrepare.disabled = false;
              inspectorFields.aiSummary.textContent = "Preview required";
              inspectorFields.aiStatus.textContent = "AI suggestions are unavailable; deterministic analysis and source navigation remain available.";
            }
          });
        };
      })
      .catch(() => {
        if (stillCurrent() && !previewController.signal.aborted && generation === previewGeneration) {
          clearAiGuidanceResult();
          inspectorFields.aiDetails.hidden = false;
          inspectorFields.aiDetails.open = true;
          inspectorFields.aiPrepare.hidden = false;
          inspectorFields.aiPrepare.disabled = false;
          inspectorFields.aiSummary.textContent = "Preview required";
          inspectorFields.aiStatus.textContent = "AI guidance preview is unavailable; retry requires another explicit preview.";
        }
      });
  };
  loadPreview(inspectorFields.aiProvider.value);
}

function revealBuildingSource(
  building: CityBuilding,
  focus: CodeInspectionFocus,
): void {
  setCodeInspectionFocus(building, focus);
  inspectorFields.sourceDetails.open = true;
  if (!sourceIsBoundToCurrentEvolutionFrame()) {
    inspectorFields.sourceSummary.textContent = "Historical frame";
    inspectorFields.sourceStatus.textContent = sourceAvailabilityMessage();
    inspectorFields.sourceContent.hidden = true;
    return;
  }
  if (loadedBuildingSource?.buildingId === building.id) {
    presentLoadedBuildingSource(building, loadedBuildingSource.source);
    return;
  }
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
  if (sourceRequest?.buildingId === building.id) return;
  sourceRequest?.controller.abort();
  sourceRequest = undefined;
  loadedBuildingSource = undefined;
  codeInspectionBuildingId = undefined;
  inspectorFields.sourceCode.replaceChildren();
  inspectorFields.sourceContent.hidden = true;
  const controller = new AbortController();
  inspectorFields.sourceSummary.textContent = "Loading";
  const provenance = activeModel.sourceProvenance?.repositories.find(
    ({ repositoryId }) => repositoryId === building.repositoryId,
  );
  if (provenance === undefined) {
    inspectorFields.sourceSummary.textContent = "Unavailable";
    inspectorFields.sourceStatus.textContent =
      "This building has no validated source provenance.";
    return;
  }
  inspectorFields.sourceStatus.textContent =
    `Loading ${building.path}…`;
  const promise = loadBuildingSource(
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
  );
  const request = Object.freeze({
    buildingId: building.id,
    controller,
    promise,
  });
  sourceRequest = request;
  void promise
    .then((source) => {
      if (
        controller.signal.aborted ||
        sourceRequest !== request ||
        selectedInspectionBuilding()?.id !== building.id
      ) {
        return;
      }
      sourceRequest = undefined;
      loadedBuildingSource = { buildingId: building.id, source };
      presentLoadedBuildingSource(building, source);
    })
    .catch((error: unknown) => {
      if (
        controller.signal.aborted ||
        sourceRequest !== request
      ) {
        return;
      }
      sourceRequest = undefined;
      loadedBuildingSource = undefined;
      inspectorFields.sourceCode.replaceChildren();
      inspectorFields.sourceContent.hidden = true;
      inspectorFields.sourceSummary.textContent = "Unavailable";
      inspectorFields.sourceStatus.textContent =
        error instanceof Error
          ? error.message
          : "Source code could not be loaded.";
    });
}

function presentLoadedBuildingSource(
  building: CityBuilding,
  source: BuildingSource,
): void {
  inspectorFields.sourceDetails.open = true;
  inspectorFields.sourceSummary.textContent = "Read only";
  inspectorFields.sourceStatus.textContent =
    `Showing the exact retained file for ${source.path}.`;
  inspectorFields.sourcePath.textContent = source.path;
  inspectorFields.sourceRevision.textContent =
    `${source.provenance.provider} · ${source.provenance.revision.value}`;
  inspectorFields.sourceExternal.hidden = source.externalUrl === undefined;
  if (source.externalUrl === undefined) {
    inspectorFields.sourceExternal.removeAttribute("href");
  } else {
    inspectorFields.sourceExternal.href = source.externalUrl;
  }
  inspectorFields.sourceEditor.hidden = source.editorUrl === undefined;
  if (source.editorUrl === undefined) {
    inspectorFields.sourceEditor.removeAttribute("href");
  } else {
    inspectorFields.sourceEditor.href = source.editorUrl;
  }
  inspectorFields.sourceContent.hidden = false;
  renderSourceCode(building, source);
  renderAiGuidanceCapability(building);
}

function setCodeInspectionFocus(
  building: CityBuilding,
  focus: CodeInspectionFocus,
): void {
  const previous = codeInspectionFocus;
  const changed = previous === undefined ||
    codeInspectionFocusKey(previous) !== codeInspectionFocusKey(focus);
  codeInspectionFocus = focus;
  selectedSourceDeclaration = undefined;
  if (focus.kind === "declaration") {
    const node = projectFineDetail(building, FINE_DETAIL_MAXIMUM_LIMIT).nodes
      .find(({ id, category }) =>
        id === focus.stableId && category === focus.category,
      );
    if (node !== undefined) {
      selectedSourceDeclaration = { buildingId: building.id, node };
    }
  }
  fineDetailDrilledBuildingId = focus.kind === "file"
    ? undefined
    : building.id;
  inspectorFields.sourceStructureReturn.hidden = focus.kind === "file";
  if (changed) {
    const sameUnit =
      previous?.kind === "unit" &&
      focus.kind === "unit" &&
      previous.unit.decisionEvidence?.unitId !== undefined &&
      previous.unit.decisionEvidence.unitId ===
        focus.unit.decisionEvidence?.unitId;
    if (!sameUnit) {
      decisionSiteVisibleLimit = INITIAL_DECISION_SITE_VISIBLE_LIMIT;
    }
    clearAiGuidanceResult();
  }
  renderDecisionEvidence(building);
  renderSourceStructure(building);
  renderAiGuidanceCapability(building);
}

function renderDecisionEvidence(building: CityBuilding): void {
  const focus = codeInspectionFocus;
  inspectorFields.decisionSites.replaceChildren();
  if (focus?.kind !== "unit" || focus.buildingId !== building.id) {
    inspectorFields.decisionEvidence.hidden = true;
    inspectorFields.decisionSitesShowMore.hidden = true;
    return;
  }
  const presentation = presentDecisionEvidence(focus.unit, {
    visibleLimit: decisionSiteVisibleLimit,
    ...(focus.selectedSiteIndex === undefined
      ? {}
      : { selectedSiteIndex: focus.selectedSiteIndex }),
  });
  inspectorFields.decisionEvidence.hidden = false;
  inspectorFields.decisionEvidence.dataset["state"] = presentation.state;
  inspectorFields.decisionEvidenceEquation.textContent =
    presentation.equation;
  inspectorFields.decisionEvidenceStatus.textContent =
    presentation.summary;
  for (const site of presentation.sites) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "decision-site-button";
    button.dataset["decisionSiteIndex"] = String(site.index);
    button.textContent =
      `${site.label} · +${site.contribution.toLocaleString()} CC`;
    if (site.selected) button.setAttribute("aria-current", "location");
    button.addEventListener("click", () => {
      const nextFocus = unitInspectionFocus(
        building.id,
        focus.unit,
        site.index,
        focus.localUnitIndex,
      );
      setCodeInspectionFocus(building, nextFocus);
      if (loadedBuildingSource?.buildingId === building.id) {
        renderSourceCode(building, loadedBuildingSource.source);
      }
      const replacement =
        inspectorFields.decisionSites.querySelector<HTMLButtonElement>(
          `[data-decision-site-index="${String(site.index)}"]`,
        );
      if (replacement !== null) restoreDisclosureFocus(replacement);
    });
    item.append(button);
    inspectorFields.decisionSites.append(item);
  }
  inspectorFields.decisionSitesShowMore.hidden =
    !presentation.canShowMore;
  if (presentation.canShowMore) {
    inspectorFields.decisionSitesShowMore.textContent =
      `Show ${Math.min(
        INITIAL_DECISION_SITE_VISIBLE_LIMIT,
        presentation.hiddenSiteCount,
      ).toLocaleString()} more decision sites`;
  }
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
  if (codeInspectionBuildingId !== building.id) {
    scrubBuildingSource();
    codeInspectionBuildingId = building.id;
  }
  codeInspectionFocus = fileInspectionFocus(building.id);
  inspectorFields.codeInspection.hidden = false;
  inspectorFields.unitsDetails.hidden = false;
  inspectorFields.sourceDetails.hidden = false;
  selectionKind.textContent = "Building";
  selectionName.textContent = building.name;
  inspectorFields.name.textContent = building.name;
  inspectorFields.repository.textContent = repository.name;
  inspectorFields.module.textContent = module.name;
  inspectorFields.path.textContent = building.path;
  inspectorFields.language.textContent = languageLabel(building.language);
  inspectorFields.metricExplanation.hidden = true;
  inspectorFields.metricExplanation.textContent = "";
  inspectorFields.metricPresentation.hidden = false;
  inspectorFields.metricTechnicalDetails.open = false;
  inspectorFields.hotspotsSection.hidden = false;
  renderBuildingMetrics(building);
  renderBuildingEvolutionHistory(building.id);
  inspectorFields.sourceDetails.open = false;
  inspectorFields.sourceSummary.textContent =
    activeModelSource.sourceAvailability === "retained" &&
      !sourceIsBoundToCurrentEvolutionFrame()
      ? "Historical frame"
      : activeModelSource.sourceAvailability === "retained"
      ? "Not loaded"
      : "Unavailable";
  inspectorFields.sourceStatus.textContent = sourceAvailabilityMessage();
  synchronizeSourceOpenAvailability(building);
  selectedSourceDeclaration = undefined;
  fineDetailDrilledBuildingId = undefined;
  executableUnitVisibleLimit =
    INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT;
  executableUnitQuery = "";
  executableUnitSort = "complexity";
  inspectorFields.unitsSearch.value = "";
  inspectorFields.unitsSort.value = "complexity";
  fineDetailVisibleLimit = FINE_DETAIL_INITIAL_LIMIT;
  expandedFineDetailTypeIds = new Set();
  inspectorFields.unitsDetails.open = false;
  inspectorFields.sourceStructureDetails.open = false;
  inspectorFields.sourceStructureReturn.hidden = true;
  const complexity = presentBuildingComplexity(building, {
    visibleLimit: executableUnitVisibleLimit,
    query: executableUnitQuery,
    sort: executableUnitSort,
  });
  renderComplexityHotspots(building, complexity);
  renderExecutableUnits(building, complexity);
  renderSourceStructure(building);
  renderDecisionEvidence(building);
  resetAiGuidancePresentation();
  discoverAiGuidanceCapability(building);
  selectionStatus.textContent = buildingSelectionStatus(building);
}

function buildingSelectionStatus(building: CityBuilding): string {
  const findingSummary = designSmellBuildingSummaryText(building.id);
  return (
    `Selected ${building.name}. Maximum cyclomatic complexity ` +
    `${building.metrics.maximumComplexity.toLocaleString()}.` +
    (findingSummary === undefined ? "" : ` ${findingSummary}.`)
  );
}

function designSmellBuildingSummaryText(
  buildingId: string,
): string | undefined {
  if (!designSmellWorkspaceActive) return undefined;
  const summary =
    activeDesignSmellVisualization.findingSummaryByBuildingId.get(
      buildingId,
    );
  if (summary === undefined) {
    return (
      "No visible design-smell finding under current rules and filters; " +
      "this is not a verified-clean result"
    );
  }
  return (
    `${summary.count.toLocaleString()} visible design-smell ` +
    `${summary.count === 1 ? "finding" : "findings"}; ` +
    `highest severity ${summary.highestSeverity}`
  );
}

function renderBuildingEvolutionHistory(buildingId: string): void {
  const history = activeEvolutionHistories.get(buildingId);
  inspectorFields.evolutionRow.hidden = history === undefined;
  if (!history) {
    inspectorFields.evolution.textContent = "";
    return;
  }
  const removed =
    history.removedAtFrame === undefined
      ? ""
      : ` Removed by ${evolutionFrameReference(
          history.removedAtFrame,
        )}.`;
  const kinds =
    history.changeKinds.length === 0
      ? ""
      : ` Changes: ${history.changeKinds.join(", ")}.`;
  inspectorFields.evolution.textContent =
    `First seen ${evolutionFrameReference(history.firstFrame)}; ` +
    `${history.changeCount.toLocaleString()} historical ` +
    `${history.changeCount === 1 ? "change" : "changes"}.` +
    removed +
    kinds;
}

function evolutionFrameReference(frameIndex: number): string {
  const frame = activeEvolutionFrames[frameIndex];
  return frame === undefined
    ? `frame ${frameIndex + 1}`
    : `${frame.sha.slice(0, 10)} at frame ${frameIndex + 1}`;
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
): { readonly label: string; readonly path: string } | undefined {
  const building = activeBuildingsById.get(sourceId);
  if (building) {
    return { label: building.name, path: building.path };
  }

  const module = activeModel.modules.find(({ id }) => id === sourceId);
  return module === undefined
    ? undefined
    : { label: module.name, path: module.path };
}

function renderBuildingMetrics(building: CityBuilding): void {
  const presentation = presentBuildingMetrics(activeModel, building);
  inspectorFields.metricRows.replaceChildren();
  inspectorFields.metricTechnical.replaceChildren();

  for (const metric of presentation.rows) {
    const item = document.createElement("div");
    item.className = "metric-presentation-row";
    item.dataset["metric"] = metric.id;
    item.dataset["state"] = metric.state;
    const label = document.createElement("dt");
    label.textContent = metric.label;
    const detail = document.createElement("dd");
    const value = document.createElement("strong");
    value.textContent = metric.value;
    const description = document.createElement("span");
    description.textContent = metric.description;
    detail.append(value, description);
    item.append(label, detail);
    inspectorFields.metricRows.append(item);
  }

  for (const entry of presentation.technical) {
    const item = document.createElement("div");
    const label = document.createElement("dt");
    label.textContent = entry.label;
    const value = document.createElement("dd");
    value.textContent = entry.value;
    item.append(label, value);
    inspectorFields.metricTechnical.append(item);
  }
}

function renderComplexityHotspots(
  building: CityBuilding,
  presentation = presentBuildingComplexity(building),
): void {
  inspectorFields.hotspots.replaceChildren();
  inspectorFields.hotspotsSourceNote.hidden =
    presentation.state === "inconsistent" ||
    (presentation.state === "available" &&
      presentation.hotspotCount === 0);

  if (presentation.state !== "available") {
    inspectorFields.hotspotsCount.textContent = "—";
    inspectorFields.hotspotsStatus.textContent = presentation.reason;
    return;
  }

  inspectorFields.hotspotsCount.textContent =
    presentation.hotspotCount.toLocaleString();
  const risk =
    building.risk === "very-high"
      ? "Very high"
      : building.risk[0]!.toUpperCase() + building.risk.slice(1);
  const hotspotLabel =
    presentation.hotspotCount === 1 ? "hotspot" : "hotspots";
  inspectorFields.hotspotsStatus.textContent =
    `${risk} complexity · ${presentation.hotspotCount.toLocaleString()} ${hotspotLabel} ` +
    `at or above CC ${presentation.threshold.toLocaleString()} · ` +
    `highest CC ${presentation.maximumComplexity.toLocaleString()}` +
    (presentation.hiddenHotspotCount > 0
      ? ` · showing the ${presentation.hotspots.length.toLocaleString()} most complex`
      : "");

  for (const hotspot of presentation.hotspots) {
    const item = document.createElement("li");
    item.className = "complexity-hotspot";
    item.dataset["severity"] = hotspot.severity;

    const content = document.createElement("div");
    content.className = "complexity-hotspot-content";
    const name = document.createElement("strong");
    name.className = "complexity-hotspot-name";
    name.textContent = hotspot.name;
    const facts = document.createElement("span");
    facts.className = "complexity-hotspot-facts";
    facts.textContent =
      `CC ${hotspot.complexity.toLocaleString()} · ` +
      `${severityLabel(hotspot.severity)} · ` +
      `threshold ${hotspot.threshold.toLocaleString()} · ` +
      formatExecutableUnitRange(hotspot.line, hotspot.endLine);
    content.append(name, facts);

    const jump = document.createElement("button");
    jump.className = "button button-compact complexity-hotspot-source";
    jump.type = "button";
    jump.textContent = "View source";
    jump.disabled = !sourceIsBoundToCurrentEvolutionFrame();
    jump.title =
      jump.disabled
        ? sourceAvailabilityMessage()
        : `Open ${hotspot.name} at ` +
          formatExecutableUnitRange(hotspot.line, hotspot.endLine);
    jump.setAttribute(
      "aria-label",
      `View source for ${hotspot.name}, ${formatExecutableUnitRange(hotspot.line, hotspot.endLine)}`,
    );
    jump.addEventListener("click", () => {
      revealBuildingSource(
        building,
        unitInspectionFocus(
          building.id,
          hotspot,
          undefined,
          hotspot.unitIndex,
        ),
      );
    });
    item.append(content, jump);
    inspectorFields.hotspots.append(item);
  }
}

function severityLabel(
  severity: "moderate" | "high" | "critical",
): string {
  return severity[0]!.toUpperCase() + severity.slice(1);
}

function formatExecutableUnitRange(
  line: number,
  endLine: number | undefined,
): string {
  const end = endLine ?? line;
  return end === line
    ? `line ${line.toLocaleString()}`
    : `lines ${line.toLocaleString()}–${end.toLocaleString()}`;
}

function renderExecutableUnits(
  building: CityBuilding,
  complexityPresentation?: BuildingComplexityPresentation,
): void {
  const fineDetail = projectFineDetail(
    building,
    executableUnitVisibleLimit,
  );
  const complexity =
    complexityPresentation ??
    presentBuildingComplexity(building, {
      visibleLimit: executableUnitVisibleLimit,
      query: executableUnitQuery,
      sort: executableUnitSort,
    });
  const presentation =
    complexity.state === "available"
      ? complexity.allUnits
      : null;
  const wasOpen = inspectorFields.unitsDetails.open;
  inspectorFields.units.replaceChildren();
  inspectorFields.unitsDetails.hidden =
    complexity.state !== "available" || presentation === null;
  inspectorFields.unitsEmpty.hidden =
    complexity.state === "available" && presentation !== null;
  inspectorFields.unitCount.hidden = presentation === null;
  inspectorFields.unitsShowMore.hidden =
    presentation === null ||
    !canRevealMoreExecutableUnits(presentation);

  if (!presentation) {
    inspectorFields.unitsDetails.open = false;
    inspectorFields.unitsEmpty.textContent =
      complexity.state === "available"
        ? "No executable units were recorded for this building."
        : complexity.reason;
    inspectorFields.unitCount.textContent = "";
    inspectorFields.unitsSummary.textContent = "";
    inspectorFields.unitsCaption.textContent = "";
    inspectorFields.unitsFilterStatus.textContent = "";
    inspectorFields.unitsShowMore.textContent = "Show more units";
    return;
  }

  const count = presentation.count.toLocaleString();
  const unitLabel = presentation.count === 1 ? "unit" : "units";
  const maximumComplexity =
    presentation.maximumComplexity.toLocaleString();
  inspectorFields.unitsDetails.open = wasOpen;
  inspectorFields.unitCount.textContent = count;
  inspectorFields.unitsSummary.textContent =
    `${count} ${unitLabel} · highest CC ${maximumComplexity}`;
  inspectorFields.unitsSummary.title =
    fineDetail.state === "unavailable"
      ? fineDetail.unavailable.join(" ")
      : `Progressive detail: ${fineDetail.nodes.length.toLocaleString()} of ${fineDetail.totalCount.toLocaleString()} functions projected. ${fineDetail.printable.reason}`;
  inspectorFields.unitsCaption.textContent =
    `All executable units for ${building.name}`;
  const sortLabel =
    presentation.sort === "complexity"
      ? "complexity, highest first"
      : "source order";
  inspectorFields.unitsFilterStatus.textContent =
    presentation.query.length === 0
      ? `Showing ${presentation.visibleCount.toLocaleString()} of ${presentation.matchingCount.toLocaleString()} units, sorted by ${sortLabel}.`
      : `${presentation.matchingCount.toLocaleString()} of ${presentation.count.toLocaleString()} units match. ` +
        `Showing ${presentation.visibleCount.toLocaleString()}, sorted by ${sortLabel}.`;
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
    jump.disabled = !sourceIsBoundToCurrentEvolutionFrame();
    jump.textContent = formatExecutableUnitRange(
      unit.line,
      unit.endLine,
    );
    jump.title =
      jump.disabled
        ? sourceAvailabilityMessage()
        : `Open ${unit.name} at ` +
          formatExecutableUnitRange(unit.line, unit.endLine);
    jump.setAttribute(
      "aria-label",
      `View source for ${unit.name}, ${formatExecutableUnitRange(unit.line, unit.endLine)}`,
    );
    jump.addEventListener("click", () => {
      revealBuildingSource(
        building,
        unitInspectionFocus(
          building.id,
          unit,
          undefined,
          building.units?.indexOf(unit),
        ),
      );
    });
    line.append(jump);

    row.append(name, complexity, line);
    inspectorFields.units.append(row);
  }
}

function renderSourceStructure(building: CityBuilding): void {
  const detail = projectFineDetail(building, fineDetailVisibleLimit);
  const wasOpen = inspectorFields.sourceStructureDetails.open;
  const drilled = fineDetailDrilledBuildingId === building.id;
  inspectorFields.sourceStructure.replaceChildren();
  // Unavailability is useful, user-facing analyzer provenance. Keep the
  // section mounted and accessible instead of silently removing it.
  inspectorFields.sourceStructureDetails.hidden = false;
  inspectorFields.sourceStructureDetails.open = wasOpen;
  inspectorFields.sourceStructureReturn.hidden = !drilled;
  inspectorFields.sourceStructureShowMore.hidden = !detail.canLoadMore;
  inspectorFields.sourceStructureStatus.textContent =
    detail.state === "unavailable"
      ? detail.unavailable.join(" ")
      : detail.unavailable.length === 0
        ? `${building.sourceStructure?.relations.length ?? 0} syntax-provenance relationships recorded; no unsupported edge is inferred.`
        : `${building.sourceStructure?.relations.length ?? 0} syntax-provenance relationships recorded. ${detail.unavailable.join(" ")}`;
  if (detail.terminalReason !== undefined) {
    inspectorFields.sourceStructureStatus.textContent += ` ${detail.terminalReason}`;
  }
  inspectorFields.sourceStructureSummary.textContent =
    detail.state === "unavailable"
      ? "Unavailable"
      : `${detail.totalCount.toLocaleString()} declarations${detail.omittedCount > 0 ? ` · ${detail.omittedCount.toLocaleString()} not loaded` : ""}`;
  if (detail.canLoadMore) inspectorFields.sourceStructureShowMore.textContent =
    `Show ${Math.min(FINE_DETAIL_INITIAL_LIMIT, detail.omittedCount).toLocaleString()} more declarations`;
  const byParent = new Map<string | undefined, typeof detail.nodes[number][]>();
  const visibleIds = new Set(detail.nodes.map(({ id }) => id));
  for (const node of detail.nodes) {
    const parentId = node.parentId !== undefined && visibleIds.has(node.parentId) ? node.parentId : undefined;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }
  const appendNodes = (container: HTMLOListElement, parentId?: string): void => {
    for (const node of byParent.get(parentId) ?? []) {
      const item = document.createElement("li");
      item.className = `source-structure-node source-structure-${node.category}`;
      const children = byParent.get(node.id) ?? [];
      const createSourceJump = (label?: string): HTMLButtonElement => {
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "unit-source-jump source-structure-source-jump";
        jump.disabled = !sourceIsBoundToCurrentEvolutionFrame();
        jump.dataset["sourceDeclarationId"] = node.id;
        jump.dataset["sourceDeclarationCategory"] = node.category;
        jump.dataset["sourceDeclarationKind"] = node.kind;
        if (node.unitIndex !== undefined) {
          jump.dataset["sourceUnitIndex"] = String(node.unitIndex);
        }
        jump.dataset["sourceDeclarationStartLine"] = String(node.startLine);
        jump.dataset["sourceDeclarationEndLine"] = String(node.endLine);
        if (node.startColumn !== undefined) {
          jump.dataset["sourceDeclarationStartColumn"] = String(node.startColumn);
        }
        if (node.endColumn !== undefined) {
          jump.dataset["sourceDeclarationEndColumn"] = String(node.endColumn);
        }
        const selectedDeclaration =
          selectedSourceDeclaration?.buildingId === building.id &&
          selectedSourceDeclaration.node.id === node.id;
        const selectedLegacyUnit =
          node.provenance === "persisted-executable-unit" &&
          node.unitIndex !== undefined &&
          codeInspectionFocus?.kind === "unit" &&
          codeInspectionFocus.buildingId === building.id &&
          codeInspectionFocus.localUnitIndex === node.unitIndex;
        if (selectedDeclaration || selectedLegacyUnit) {
          jump.setAttribute("aria-current", "location");
        }
        const columns = node.startColumn === undefined ? "" : `:${node.startColumn}`;
        jump.textContent = label ?? `${sourceStructureKindLabel(node.kind)} ${node.name} · ${node.startLine}${columns}`;
        jump.title = jump.disabled
          ? sourceAvailabilityMessage()
          : `${node.explanation} Open its exact persisted source range.`;
        jump.setAttribute("aria-label", `${sourceStructureKindLabel(node.kind)} ${node.name}. ${node.explanation} Starts line ${node.startLine}${columns}. Open its exact persisted source range.`);
        jump.addEventListener("click", () => {
          for (const current of inspectorFields.sourceStructure.querySelectorAll(
            '[aria-current="location"]',
          )) {
            current.removeAttribute("aria-current");
          }
          const legacyUnit = node.unitIndex === undefined
            ? undefined
            : building.units?.[node.unitIndex];
          const nextFocus =
            node.provenance === "persisted-executable-unit"
              ? legacyUnit === undefined
                ? undefined
                : unitInspectionFocus(
                    building.id,
                    legacyUnit,
                    undefined,
                    node.unitIndex,
                  )
              : Object.freeze({
                  kind: "declaration" as const,
                  buildingId: building.id,
                  category: node.category,
                  stableId: node.id,
                });
          if (nextFocus === undefined) return;
          revealBuildingSource(building, nextFocus);
          const replacement =
            inspectorFields.sourceStructure.querySelector<HTMLButtonElement>(
              `[data-source-declaration-id="${CSS.escape(node.id)}"][data-source-declaration-category="${CSS.escape(node.category)}"]`,
            );
          if (replacement !== null) restoreDisclosureFocus(replacement);
        });
        return jump;
      };
      if (node.category === "type" && children.length > 0) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "unit-source-jump source-structure-toggle";
        toggle.dataset["sourceStructureId"] = node.id;
        const expanded = expandedFineDetailTypeIds.has(node.id);
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.textContent = `${sourceStructureKindLabel(node.kind)} ${node.name} (${children.length.toLocaleString()})`;
        toggle.title = `${expanded ? "Collapse" : "Expand"} ${node.kind} ${node.name}. ${node.explanation}`;
        toggle.addEventListener("click", () => {
          if (expandedFineDetailTypeIds.has(node.id)) expandedFineDetailTypeIds.delete(node.id);
          else expandedFineDetailTypeIds.add(node.id);
          renderSourceStructure(building);
          inspectorFields.sourceStructure.querySelector<HTMLButtonElement>(`[data-source-structure-id="${CSS.escape(node.id)}"]`)?.focus();
        });
        item.append(toggle, createSourceJump(`Open ${node.kind} source · ${node.startLine}${node.startColumn === undefined ? "" : `:${node.startColumn}`}`));
        const childList = document.createElement("ol");
        childList.className = "source-structure-children";
        childList.hidden = !expanded;
        childList.setAttribute("aria-label", `${node.name} members`);
        appendNodes(childList, node.id);
        item.append(childList);
      } else {
        item.append(createSourceJump());
      }
      container.append(item);
    }
  };
  appendNodes(inspectorFields.sourceStructure);
}

function sourceStructureKindLabel(kind: import("../../../packages/core/src/model.js").SourceTypeFact["kind"] | import("../../../packages/core/src/model.js").SourceCallableFact["kind"] | "executable-unit"): string {
  return kind === "local-function" ? "Local function" : kind === "executable-unit" ? "Executable unit" : kind.charAt(0).toLocaleUpperCase("en-US") + kind.slice(1);
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

function restoreDisclosureFocus(target: HTMLElement): void {
  window.queueMicrotask(() => {
    if (
      target.isConnected &&
      document.querySelector("dialog[open]") === null
    ) {
      target.focus({ preventScroll: true });
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
