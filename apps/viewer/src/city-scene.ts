import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type {
  CityBase,
  CityBuilding,
  CityDistrict,
  CityModel,
  CityModule,
  CityRepository,
} from "../../../packages/core/src/model.js";
import {
  EXTERNAL_DEPENDENCY_COLOR,
  type ExternalDependencyLayoutNode,
} from "../../../packages/core/src/external-dependencies.js";
import type { AdvancedSelectionIntent } from "./advanced-selection.js";
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
import { cityBaseForModel } from "./city-surface.js";
import {
  type DependencyOverlayRoute,
  type DependencyRouteOverlayDiagnostics,
  DependencyRouteOverlay,
} from "./dependency-overlay.js";
import {
  EvolutionRemovalLayer,
  type EvolutionRemovalDiagnostics,
} from "./evolution-removal-layer.js";
import {
  drawImageExportOverlay,
  flipRgbaRows,
  validateImageExportLegend,
  validateImageExportResolution,
  type ImageExportLegendEntry,
  type ImageExportOverlay,
  type ImageExportProjectedLabel,
  type ImageExportRequest,
  type ValidatedImageExportResolution,
} from "./image-export.js";
import {
  type ProjectedPrintPlate,
  viewerPrintMeshBatches,
} from "./print-plate-preview.js";
import type { ExplorerState } from "./repository-explorer.js";
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
  assertViewerBuildingCapability,
  ViewerBuildingLayer,
  type ViewerBuildingDefinition,
  type ViewerBuildingRenderMode,
} from "./viewer-building-layer.js";
import { ViewerFramePicker } from "./viewer-frame-picker.js";
import { supportsViewerInstancing } from "./viewer-render-capability.js";
import type { DesignSmellBuildingDiagnostics } from "./design-smell-visualization.js";
import type { EvolutionTransition } from "./evolution-timeline.js";

export interface BuildingContext {
  readonly building: CityBuilding;
  readonly repository: CityRepository;
  readonly module: CityModule;
}

export interface DistrictContext {
  readonly district: CityDistrict;
  readonly repository: CityRepository;
  readonly module: CityModule;
  readonly buildingCount: number;
}

export type ExternalSceneNode = ExternalDependencyLayoutNode;

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

export interface SceneImageExport {
  readonly blob: Blob;
  readonly resolution: ValidatedImageExportResolution;
}

interface ExportCameraFrame {
  readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  readonly target: THREE.Vector3;
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

export interface ViewerPerformanceDiagnostics {
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

export interface CitySceneControls {
  readonly imageExportOpenButton: HTMLButtonElement;
  readonly cameraFitCityButton: HTMLButtonElement;
  readonly cameraFocusSelectionButton: HTMLButtonElement;
  readonly synchronizeCameraFocusControl: () => void;
}

export interface CitySceneOptions {
  readonly host: HTMLDivElement;
  readonly controls: CitySceneControls;
  readonly onStateChange: (state: ExplorerState) => void;
  readonly requestCityPresentation: () => void;
  readonly onPointerSelection?: (
    entity: SceneEntity | null,
    intent: AdvancedSelectionIntent,
  ) => boolean;
  readonly designSmellBuildingSummaryText: (
    buildingId: string,
  ) => string | undefined;
  readonly cameraControlsHint: HTMLElement;
  readonly schedulePerformanceDiagnostics: () => void;
  readonly showDetails: () => void;
  readonly closeDetails: () => void;
  readonly showInspector: (context: BuildingContext | null) => void;
  readonly showDistrictInspector: (context: DistrictContext) => void;
  readonly showExternalInspector: (node: ExternalSceneNode) => void;
}

function createViewerRenderer(): THREE.WebGLRenderer {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  if (context === null) {
    throw new Error(
      "WebGL 2 is required by the current Three.js renderer, but this browser or GPU did not provide it.",
    );
  }
  return new THREE.WebGLRenderer({
    canvas,
    context,
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
}

export class CityScene {
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
  private readonly renderer = createViewerRenderer();
  private readonly instancingSupported = supportsViewerInstancing(
    this.renderer.getContext() as WebGL2RenderingContext,
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

  private readonly host: HTMLDivElement;
  private readonly uiControls: CitySceneControls;
  private readonly onStateChange: (state: ExplorerState) => void;
  private readonly requestCityPresentation: () => void;
  private readonly onPointerSelection: CitySceneOptions["onPointerSelection"];
  private readonly designSmellBuildingSummaryText: CitySceneOptions["designSmellBuildingSummaryText"];
  private readonly cameraControlsHint: HTMLElement;
  private readonly schedulePerformanceDiagnostics: () => void;
  private readonly showDetails: () => void;
  private readonly closeDetails: () => void;
  private readonly showInspector: CitySceneOptions["showInspector"];
  private readonly showDistrictInspector: CitySceneOptions["showDistrictInspector"];
  private readonly showExternalInspector: CitySceneOptions["showExternalInspector"];

  public constructor(options: CitySceneOptions) {
    this.host = options.host;
    this.uiControls = options.controls;
    this.onStateChange = options.onStateChange;
    this.requestCityPresentation = options.requestCityPresentation;
    this.onPointerSelection = options.onPointerSelection;
    this.designSmellBuildingSummaryText = options.designSmellBuildingSummaryText;
    this.cameraControlsHint = options.cameraControlsHint;
    this.schedulePerformanceDiagnostics = options.schedulePerformanceDiagnostics;
    this.showDetails = options.showDetails;
    this.closeDetails = options.closeDetails;
    this.showInspector = options.showInspector;
    this.showDistrictInspector = options.showDistrictInspector;
    this.showExternalInspector = options.showExternalInspector;
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
        this.uiControls.imageExportOpenButton.disabled = true;
        this.uiControls.imageExportOpenButton.title =
          "Image export is unavailable while the WebGL context is lost.";
        this.uiControls.cameraFitCityButton.disabled = true;
        this.uiControls.cameraFocusSelectionButton.disabled = true;
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
        this.uiControls.imageExportOpenButton.disabled = false;
        this.uiControls.imageExportOpenButton.title = "";
        this.uiControls.cameraFitCityButton.disabled = false;
        this.uiControls.synchronizeCameraFocusControl();
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
    this.controls.addEventListener(
      "end",
      this.schedulePerformanceDiagnostics,
    );

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
    this.schedulePerformanceDiagnostics();
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
    this.schedulePerformanceDiagnostics();
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
    this.schedulePerformanceDiagnostics();
  }

  public replaceDistrictDependencyRoutes(
    routes: readonly DependencyOverlayRoute[],
  ): void {
    this.districtDependencyOverlay.replace(routes);
    if (this.prePrintOverlayVisibility !== undefined) {
      this.prePrintOverlayVisibility.districtDependencies =
        routes.length > 0;
    }
    this.schedulePerformanceDiagnostics();
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
    this.schedulePerformanceDiagnostics();
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
    this.schedulePerformanceDiagnostics();
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
    this.cameraControlsHint.textContent =
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
      this.showDetails();
    } else if (entity === null) {
      this.closeDetails();
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
      this.showInspector(building);
    } else if (district) {
      this.showDistrictInspector(district);
    } else if (external) {
      this.showExternalInspector(external);
    } else {
      this.showInspector(null);
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
        const findingSummary = this.designSmellBuildingSummaryText(
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

export class UnavailableCityScene {
  private readonly uiControls: CitySceneControls;

  public constructor(
    host: HTMLDivElement,
    reason: string,
    controls: CitySceneControls,
  ) {
    this.uiControls = controls;
    host.dataset["webglAvailable"] = "false";
    host.setAttribute("role", "alert");
    const fallback = document.createElement("section");
    fallback.className = "webgl-unavailable";
    const title = document.createElement("h2");
    title.textContent = "3D viewer unavailable";
    const description = document.createElement("p");
    description.textContent =
      "This browser could not start WebGL 2. Use a current browser and GPU with hardware acceleration enabled. Project data and non-visual exports remain available.";
    const detail = document.createElement("p");
    detail.className = "webgl-unavailable-detail";
    detail.textContent = reason;
    fallback.append(title, description, detail);
    host.replaceChildren(fallback);
    this.uiControls.imageExportOpenButton.disabled = true;
    this.uiControls.imageExportOpenButton.title =
      "Image export requires an available WebGL 2 context.";
    this.uiControls.cameraFitCityButton.disabled = true;
    this.uiControls.cameraFocusSelectionButton.disabled = true;
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


export function createCityScene(
  options: CitySceneOptions,
): CityScene | UnavailableCityScene {
  try {
    return new CityScene(options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return new UnavailableCityScene(options.host, reason, options.controls);
  }
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

