import {
  createCityScene,
  type BuildingContext,
  type DistrictContext,
  type ExternalSceneNode,
  type ViewerPerformanceDiagnostics,
} from "./city-scene.js";

import {
  EXTERNAL_DEPENDENCY_COLOR,
  layoutExternalDependencies,
  resolveExternalDependencyNode,
  selectExternalDependencies,
  type ExternalDependencyLayout,
} from "../../../packages/core/src/external-dependencies.js";
import type {
  CityBuilding,
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
} from "../../../packages/core/src/district-dependencies.js";
import {
  districtBoundaryAnchor,
  type DistrictDependencyFootprint,
  districtRouteEndpoints,
} from "./district-dependency-layout.js";
import type {
  DependencyOverlayRoute,
} from "./dependency-overlay.js";
import {
  buildingRouteEndpoint,
  type RouteEndpointGeometry,
} from "./dependency-route-layout.js";
import { DEMO_MODEL } from "./demo-model.js";
import { presentExternalDependency } from "./external-dependency-inspector.js";
import {
  imageExportFileName,
  type ImageExportLegendEntry,
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
  type DesignSmellBuildingVisualization,
} from "./design-smell-visualization.js";
import {
  installSafeExtensionPanel,
  type SafeExtensionPanelController,
} from "./safe-extension-panel.js";
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
import { AiProviderDiscoveryController } from "./ai-provider-discovery.js";
import { AiGuidanceController } from "./ai-guidance-controller.js";
import { RetainedSourceController } from "./retained-source-controller.js";
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
import type { SceneEntity } from "./scene-entity.js";
import {
  installViewerWorkspace,
  nextBoundedResultLimit,
  type ViewerWorkspaceState,
} from "./viewer-workspace.js";
import { summarizeViewerOverview } from "./viewer-overview.js";
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

let activeModel: CityModel = DEMO_MODEL;
let activeModelSource: ModelSource = { label: "Built-in demo" };
let safeExtensionBaseModel: CityModel = activeModel;
let activeSafeExtensionEvaluation: ExtensionEvaluation | undefined;
let suppressSafeExtensionRestore = false;
const retainedSourceController = new RetainedSourceController();
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
let activeEvolutionPlaybackStartIndex = 0;
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
const cityScene = createCityScene({
  host: sceneHost,
  controls: {
    imageExportOpenButton,
    cameraFitCityButton,
    cameraFocusSelectionButton,
    synchronizeCameraFocusControl,
  },
  onStateChange: synchronizeExplorerState,
  requestCityPresentation: () => requestCityPresentation(),
  onPointerSelection: (entity, intent) => {
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
  designSmellBuildingSummaryText: (buildingId) =>
    designSmellBuildingSummaryText(buildingId),
  cameraControlsHint,
  schedulePerformanceDiagnostics,
  showDetails: () => viewerWorkspace.showDetails({ intent: "passive" }),
  closeDetails: () => viewerWorkspace.closeDetails(),
  showInspector,
  showDistrictInspector,
  showExternalInspector,
});
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
const aiGuidanceController = new AiGuidanceController({
  elements: {
    details: inspectorFields.aiDetails,
    summary: inspectorFields.aiSummary,
    status: inspectorFields.aiStatus,
    providerLabel: inspectorFields.aiProviderLabel,
    provider: inspectorFields.aiProvider,
    prepare: inspectorFields.aiPrepare,
    preview: inspectorFields.aiPreview,
    request: inspectorFields.aiRequest,
    suggestions: inspectorFields.aiSuggestions,
  },
  api: sourceApi,
  providerDiscovery: aiProviderDiscovery,
  selectedBuilding: () => selectedInspectionBuilding(),
  currentJobId: () => activeModelSource.jobId,
  sourceAvailable: () => retainedSourceActionAvailable(),
  sourceBoundToCurrentFrame: () => sourceIsBoundToCurrentEvolutionFrame(),
  contextFor: (building) => {
    const focus = codeInspectionFocus;
    return focus === undefined ? undefined : codeInspectionAiContext(building, focus);
  },
  focusKey: () =>
    codeInspectionFocus === undefined
      ? undefined
      : codeInspectionFocusKey(codeInspectionFocus),
});
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
          const loadedSource = retainedSourceController.sourceFor(building.id);
          if (loadedSource !== undefined) {
            renderSourceCode(building, loadedSource);
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
  activeEvolutionPlaybackStartIndex = 0;
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
    activeEvolutionPlaybackStartIndex = loaded.playbackStartIndex;
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
  evolutionFirst.setAttribute(
    "aria-label",
    activeEvolutionPlaybackStartIndex > 0
      ? "Reveal technical Git baseline"
      : "First commit",
  );
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
  const projectStartLabel =
    activeEvolutionPlaybackStartIndex > 0 &&
    activeEvolutionIndex < activeEvolutionPlaybackStartIndex
      ? "Technical pre-project baseline \u00b7 "
      : activeEvolutionPlaybackStartIndex > 0 &&
          activeEvolutionIndex === activeEvolutionPlaybackStartIndex
        ? "Project start \u00b7 "
        : "";
  evolutionCommit.textContent =
    projectStartLabel +
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
    const reset = await seekEvolution(activeEvolutionPlaybackStartIndex);
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
  retainedSourceController.clear();
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

function selectedInspectionBuilding(): CityBuilding | undefined {
  const selectedId = selectedExplorerBuildingId(explorerState);
  return selectedId === null
    ? undefined
    : activeBuildingsById.get(selectedId);
}

function resetAiGuidancePresentation(): void {
  aiGuidanceController.reset();
}

function clearAiGuidanceResult(): void {
  aiGuidanceController.clearResult();
}

function renderAiGuidanceCapability(building: CityBuilding): void {
  aiGuidanceController.render(building);
}

function discoverAiGuidanceCapability(building: CityBuilding): void {
  aiGuidanceController.discover(building);
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
  const loadedSource = retainedSourceController.sourceFor(building.id);
  if (loadedSource !== undefined) {
    presentLoadedBuildingSource(building, loadedSource);
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
  if (retainedSourceController.isLoading(building.id)) return;
  retainedSourceController.clear();
  codeInspectionBuildingId = undefined;
  inspectorFields.sourceCode.replaceChildren();
  inspectorFields.sourceContent.hidden = true;
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
  retainedSourceController.load(
    building.id,
    (signal) => loadBuildingSource(
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
      (requestedJobId, requestedBuildingId, requestSignal) =>
        sourceApi.buildingSource(
          requestedJobId,
          requestedBuildingId,
          requestSignal,
        ),
      signal,
    ),
    () => selectedInspectionBuilding()?.id === building.id,
    {
      loaded: (source) => presentLoadedBuildingSource(building, source),
      failed: (error) => {
        inspectorFields.sourceCode.replaceChildren();
        inspectorFields.sourceContent.hidden = true;
        inspectorFields.sourceSummary.textContent = "Unavailable";
        inspectorFields.sourceStatus.textContent =
          error instanceof Error
            ? error.message
            : "Source code could not be loaded.";
      },
    },
  );
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
      const loadedSource = retainedSourceController.sourceFor(building.id);
      if (loadedSource !== undefined) {
        renderSourceCode(building, loadedSource);
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
