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
} from "../../../packages/core/src/model.js";
import { presentExecutableUnits } from "./building-inspector.js";
import { cityBaseForModel } from "./city-surface.js";
import {
  createDependencyExplorerIndex,
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
import { installPrintExportDialog } from "./print-export-dialog.js";
import {
  AutomaticModelLoadGate,
  assetRootFromResponseUrl,
  resolveAssetUrl,
  sortLegendGroups,
} from "./model-source.js";
import { validateCityModel } from "./model-validation.js";
import {
  createRepositoryExplorerIndex,
  type ExplorerState,
  isolateSelectedDistrict as isolateExplorerDistrict,
  resetExplorerState,
  searchRepositoryBuildings,
  selectedExplorerBuildingId,
  selectedExplorerExternalId,
  selectExplorerBuilding,
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
import { cameraDistanceForBounds } from "./scene-navigation.js";
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
}

const sceneHost = element<HTMLDivElement>("scene");
const fileInput = element<HTMLInputElement>("model-file");
const demoButton = element<HTMLButtonElement>("demo-button");
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
const legend = element<HTMLUListElement>("legend");
const externalZone = element<HTMLElement>("external-zone");
const externalList = element<HTMLUListElement>("external-list");
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
const findPanel = element<HTMLElement>("find-panel");
const buildingSearch = element<HTMLInputElement>("building-search");
const searchStatus = element<HTMLParagraphElement>("search-status");
const searchResults = element<HTMLUListElement>("search-results");
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
  unitCount: element<HTMLElement>("building-unit-count"),
  unitsEmpty: element<HTMLParagraphElement>("building-units-empty"),
  unitsDetails: element<HTMLDetailsElement>("building-units-details"),
  unitsSummary: element<HTMLElement>("building-units-summary"),
  unitsCaption: element<HTMLTableCaptionElement>("building-units-caption"),
  units: element<HTMLTableSectionElement>("building-units"),
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
  private readonly controls = new OrbitControls(
    this.camera,
    this.renderer.domElement,
  );
  private readonly raycaster = new THREE.Raycaster();
  private readonly city = new THREE.Group();
  private readonly dependencyOverlay = new DependencyRouteOverlay(this.scene);
  private readonly districtDependencyOverlay = new DependencyRouteOverlay(
    this.scene,
    "code-city:district-dependency-routes",
  );
  private readonly sceneLabelOverlay = new SceneLabelOverlay(this.scene);
  private readonly buildingMeshes = new Map<
    string,
    THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  >();
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
  private grid: THREE.GridHelper | null = null;
  private hoveredEntity: SceneEntity | null = null;
  private selectedEntity: SceneEntity | null = null;
  private isolatedDistrictId: string | null = null;
  private cameraTransition: CameraTransition | null = null;
  private fullCityMaxDistance = 20;
  private fullCityFar = 100;
  private pointerStart: PointerPosition | null = null;

  public constructor(
    private readonly host: HTMLDivElement,
    private readonly onStateChange: (state: ExplorerState) => void,
  ) {
    this.scene.background = new THREE.Color("#07111f");
    this.scene.fog = this.fog;
    this.scene.add(this.city);

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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.renderer.setAnimationLoop(this.render);
  }

  public load(
    model: CityModel,
    effectiveBase: CityBase | undefined,
    externalNodes: readonly ExternalSceneNode[],
  ): void {
    this.clear();

    const repositories = new Map(
      model.repositories.map((item) => [item.id, item]),
    );
    const modules = new Map(model.modules.map((item) => [item.id, item]));
    const groups = new Map(
      model.semanticGroups.map((item) => [item.id, item]),
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
      const semanticGroup = groups.get(building.semanticGroupId);
      const repository = repositories.get(building.repositoryId);
      const module = modules.get(building.moduleId);
      if (!semanticGroup || !repository || !module) {
        throw new Error(
          `Building "${building.id}" has invalid model references`,
        );
      }

      const geometry = new THREE.BoxGeometry(
        building.size.x,
        building.size.y,
        building.size.z,
      );
      const material = new THREE.MeshStandardMaterial({
        color: semanticGroup.color,
        roughness: 0.58,
        metalness: 0.08,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        building.position.x,
        building.position.y,
        building.position.z,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData["buildingId"] = building.id;
      mesh.userData["sceneEntityKey"] = encodeSceneEntityKey(
        createSceneEntity("building", building.id),
      );
      const districtGroup = this.districtGroups.get(building.districtId);
      if (!districtGroup) {
        throw new Error(
          `Building "${building.id}" references an unknown district`,
        );
      }
      districtGroup.add(mesh);
      this.buildingMeshes.set(building.id, mesh);
      this.buildingContexts.set(building.id, {
        building,
        repository,
        module,
      });
    }

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
    this.frame();
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
  }

  public replaceDistrictDependencyRoutes(
    routes: readonly DependencyOverlayRoute[],
  ): void {
    this.districtDependencyOverlay.replace(routes);
  }

  public selectBuilding(id: string, focus = false): boolean {
    const context = this.buildingContexts.get(id);
    if (!context) {
      return false;
    }
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
    if (
      this.isolatedDistrictId !== null &&
      this.isolatedDistrictId !== id
    ) {
      this.applyDistrictIsolation(id, false);
    }
    this.select(createSceneEntity("district", id));
    if (focus) {
      this.frameIsolatedDistrict(group, true);
    }
    return true;
  }

  public selectExternalNode(id: string, focus = false): boolean {
    const mesh = this.externalMeshes.get(id);
    if (!mesh) {
      return false;
    }
    this.select(createSceneEntity("external", id));
    if (focus) {
      this.frameObject(mesh, true);
    }
    return true;
  }

  public isolateDistrict(id: string, focus = true): boolean {
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
      this.frameIsolatedDistrict(selectedGroup, true);
    }
    return true;
  }

  public showWholeCity(): void {
    for (const group of this.districtGroups.values()) {
      group.visible = true;
    }
    this.isolatedDistrictId = null;
    this.frameObject(this.city, true);
    this.emitState();
  }

  private readonly render = (): void => {
    this.updateCameraTransition();
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
    this.hover(null);
    this.sceneLabelOverlay.clear();
    this.dependencyOverlay.clear();
    this.districtDependencyOverlay.clear();
    this.isolatedDistrictId = null;
    this.cameraTransition = null;
    this.select(null);
    this.buildingMeshes.clear();
    this.buildingContexts.clear();
    this.districtMeshes.clear();
    this.districtContexts.clear();
    this.externalMeshes.clear();
    this.externalNodes.clear();
    this.districtGroups.clear();

    for (const child of [...this.city.children]) {
      this.city.remove(child);
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

  private frameIsolatedDistrict(
    district: THREE.Object3D,
    animate: boolean,
  ): void {
    const bounds = new THREE.Box3().setFromObject(district);
    for (const mesh of this.externalMeshes.values()) {
      bounds.expandByObject(mesh);
    }
    if (!bounds.isEmpty()) {
      this.frameBounds(bounds, animate);
    }
  }

  private focusBuilding(id: string): void {
    const mesh = this.buildingMeshes.get(id);
    if (mesh) {
      this.frameObject(mesh, true);
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
    this.controls.maxDistance = this.fullCityMaxDistance;
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
    this.pointerStart = { x: event.clientX, y: event.clientY };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.hover(this.pick(event));
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (
      !start ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
    ) {
      return;
    }
    this.select(this.pick(event));
  };

  private readonly onPointerLeave = (): void => {
    this.pointerStart = null;
    this.hover(null);
  };

  private pick(event: PointerEvent): SceneEntity | null {
    if (
      this.buildingMeshes.size === 0 &&
      this.districtMeshes.size === 0 &&
      this.externalMeshes.size === 0
    ) {
      return null;
    }

    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycaster.intersectObjects(
      [
        ...[...this.buildingMeshes.values()].filter(
          (mesh) => mesh.parent?.visible !== false,
        ),
        ...[...this.districtMeshes.values()].filter(
          (mesh) => mesh.parent?.visible !== false,
        ),
        ...this.externalMeshes.values(),
      ],
      false,
    )[0];
    return decodeSceneEntityKey(hit?.object.userData["sceneEntityKey"]);
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

  private select(entity: SceneEntity | null): void {
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
        return this.buildingMeshes.get(entity.id);
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
    this.renderer.domElement.setAttribute(
      "aria-label",
      sceneLabelAccessibleName(labels),
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
let activeBuildingsById = new Map(
  DEMO_MODEL.buildings.map((building) => [building.id, building]),
);
let activeDistrictsById = new Map(
  DEMO_MODEL.districts.map((district) => [district.id, district]),
);
let dependencyExplorerIndex = createDependencyExplorerIndex(DEMO_MODEL);
let dependencyRouteState: DependencyRouteToggleState =
  resetDependencyRouteState();
let districtDependencyExplorerIndex =
  createDistrictDependencyExplorerIndex(DEMO_MODEL);
let districtDependencyFilters: DistrictDependencyFilters =
  resetDistrictDependencyFilters();
let districtDependencyRoutesVisible = false;
let selectedDistrictDependencyBundleId: string | null = null;
let visibleDistrictDependencyBundlesById = new Map<
  string,
  DistrictDependencyBundle
>();
let districtDependencyFootprintsById =
  createDistrictDependencyFootprints(DEMO_MODEL);
let repositoryExplorerIndex = createRepositoryExplorerIndex(DEMO_MODEL);
let explorerState = resetExplorerState();
let activeExternalLayout = createExternalDependencyLayout(DEMO_MODEL);
let activeExternalNodes: readonly ExternalSceneNode[] =
  activeExternalLayout.nodes;
const cityScene = new CityScene(
  sceneHost,
  synchronizeExplorerState,
);
const automaticModelLoadGate = new AutomaticModelLoadGate();
const printExportDialog = installPrintExportDialog({
  getModel: () => activeModel,
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
    const parsed: unknown = JSON.parse(await file.text());
    applyModel(validateCityModel(parsed), { label: file.name });
  } catch (error) {
    showError(messageOf(error));
  }
});

demoButton.addEventListener("click", () => {
  automaticModelLoadGate.invalidate();
  applyModel(DEMO_MODEL, { label: "Built-in demo" });
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
districtRoutesToggle.addEventListener("click", () => {
  districtDependencyRoutesVisible = !districtDependencyRoutesVisible;
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
  isolateDistrictDependencyEndpoint("consumer");
});
districtRouteIsolateProvider.addEventListener("click", () => {
  isolateDistrictDependencyEndpoint("provider");
});

buildingSearch.addEventListener("input", renderBuildingSearch);
buildingSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && buildingSearch.value !== "") {
    event.preventDefault();
    event.stopPropagation();
    buildingSearch.value = "";
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

dismissErrorButton.addEventListener("click", hideError);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearBuildingSelection();
    hideError();
  }
});

applyModel(DEMO_MODEL, { label: "Built-in demo" });
void loadModelFromQuery();

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
    if (modelUrl.protocol !== "http:" && modelUrl.protocol !== "https:") {
      throw new Error("the model URL must use HTTP or HTTPS");
    }

    setStatus(`Fetching ${modelUrl.href}…`);
    const response = await fetch(modelUrl, {
      cache: "no-store",
      signal: attempt.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const parsed: unknown = await response.json();
    if (!attempt.isCurrent()) {
      return;
    }
    applyModel(validateCityModel(parsed), {
      label: response.url,
      assetRoot: assetRootFromResponseUrl(response.url),
    });
  } catch (error) {
    if (attempt.isCurrent()) {
      showError(messageOf(error));
    }
  } finally {
    attempt.finish();
  }
}

function applyModel(model: CityModel, source: ModelSource): void {
  printExportDialog.invalidate();
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

  activeModel = model;
  activeBuildingsById = buildingsById;
  activeDistrictsById = districtsById;
  dependencyExplorerIndex = nextDependencyExplorerIndex;
  dependencyRouteState = resetDependencyRouteState();
  districtDependencyExplorerIndex =
    nextDistrictDependencyExplorerIndex;
  districtDependencyFilters = resetDistrictDependencyFilters();
  districtDependencyRoutesVisible = false;
  selectedDistrictDependencyBundleId = null;
  visibleDistrictDependencyBundlesById = new Map();
  districtDependencyFootprintsById =
    nextDistrictDependencyFootprints;
  repositoryExplorerIndex = nextRepositoryExplorerIndex;
  explorerState = resetExplorerState();
  activeExternalLayout = nextExternalLayout;
  activeExternalNodes = nextExternalLayout.nodes;
  buildingSearch.value = "";
  synchronizeExplorerState(explorerState);
  renderBuildingSearch();
  cityScene.load(model, nextExternalLayout.base, nextExternalLayout.nodes);
  renderExternalNodeList();
  const title =
    model.identity?.title ??
    (model.repositories.length === 1
      ? model.repositories[0]?.name
      : undefined) ??
    source.label;
  modelNameElement.textContent = title;
  modelNameElement.title = `Source: ${source.label}`;
  applyLogo(model, source);
  const version = model.identity?.version
    ? `${model.identity.version} · `
    : "";
  setStatus(
    `${version}${model.districts.length.toLocaleString()} districts · ${model.buildings.length.toLocaleString()} buildings`,
  );
  renderLegend(model);
  hideError();
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
      if (cityScene.selectExternalNode(node.id)) {
        externalInspectorContent.focus({ preventScroll: true });
      }
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
  findPanel.classList.remove("has-results");
  buildingSearch.disabled = activeModel.buildings.length === 0;
  if (activeModel.buildings.length === 0) {
    searchStatus.textContent = "This model has no buildings.";
    return;
  }

  const search = searchRepositoryBuildings(
    repositoryExplorerIndex,
    buildingSearch.value,
  );
  if (search.state === "empty-query") {
    searchStatus.textContent = "Type to find a building.";
    return;
  }
  if (search.state === "no-matches") {
    searchStatus.textContent = `No buildings match “${search.query}”.`;
    return;
  }

  const visibleCount = search.results.length;
  const totalCount = search.totalCount;
  findPanel.classList.add("has-results");
  searchStatus.textContent =
    `${totalCount.toLocaleString()} ${totalCount === 1 ? "building" : "buildings"} found` +
    (visibleCount < totalCount
      ? ` · showing ${visibleCount.toLocaleString()}`
      : "");

  for (const result of search.results) {
    const item = document.createElement("li");
    item.className = "search-result";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result-button";
    button.dataset["buildingId"] = result.buildingId;
    button.title = result.path;
    if (
      result.buildingId === selectedExplorerBuildingId(explorerState)
    ) {
      button.setAttribute("aria-current", "true");
    }
    button.addEventListener("click", () => {
      selectBuildingFromExplorer(result.buildingId);
    });

    const name = document.createElement("span");
    name.className = "search-result-name";
    name.textContent = result.name;

    const path = document.createElement("span");
    path.className = "search-result-path";
    path.textContent = result.path;

    const metadata = document.createElement("span");
    metadata.className = "search-result-meta";
    metadata.textContent =
      `${result.moduleName} · Max CC ${result.maximumComplexity.toLocaleString()}`;

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

function clearBuildingSelection(): void {
  cityScene.resetSelection();
}

function synchronizeExplorerState(state: ExplorerState): void {
  const previousSelectedBuildingId =
    selectedExplorerBuildingId(explorerState);
  explorerState = state;
  const selectedBuildingId = selectedExplorerBuildingId(state);
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
  const selected = selectedBuildingId
    ? activeModel.buildings.find(
        ({ id }) => id === selectedBuildingId,
      )
    : undefined;
  isolateDistrictButton.disabled =
    !selected ||
    state.isolatedDistrictId === selected.districtId;
  showWholeCityButton.disabled = state.isolatedDistrictId === null;
  for (const button of searchResultButtons()) {
    if (button.dataset["buildingId"] === selectedBuildingId) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  renderExternalNodeList();
  renderDependencyExplorer();
  renderDistrictDependencyExplorer();
}

function toggleDistrictDependencyFilter(kind: DependencyKind): void {
  districtDependencyFilters = toggleDistrictDependencyKind(
    districtDependencyFilters,
    kind,
  );
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
    summary.bundles.map((bundle) => [bundle.id, bundle]),
  );

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
  districtRoutesList.hidden = summary.bundles.length === 0;
  if (!hasEnabledKind) {
    districtRoutesStatus.textContent = "No route kinds selected.";
  } else if (summary.totalBundleCount === 0) {
    districtRoutesStatus.textContent =
      explorerState.isolatedDistrictId === null
        ? "No routes match the selected kinds."
        : "No matching routes touch this district.";
  } else {
    districtRoutesStatus.textContent =
      `Showing ${summary.visibleBundleCount.toLocaleString()} of ` +
      `${routeCountLabel(summary.totalBundleCount)} · ` +
      `${summary.visibleReferenceWeight.toLocaleString()} of ` +
      `${referenceCountLabel(summary.totalReferenceWeight)}` +
      (summary.hiddenBundleCount > 0
        ? ` · ${summary.hiddenBundleCount.toLocaleString()} bundles hidden by limit`
        : "");
  }

  const overlayRoutes: DependencyOverlayRoute[] = [];
  for (const bundle of summary.bundles) {
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
  cityScene.isolateDistrict(districtId);
  if (cityScene.selectDistrict(districtId)) {
    districtInspectorContent.focus({ preventScroll: true });
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
  renderDependencyExplorer();
}

function renderDependencyExplorer(): void {
  dependencyList.replaceChildren();
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

  const visibleRoutes = [
    ...(dependencyRouteState.incoming ? summary.incoming.routes : []),
    ...(dependencyRouteState.outgoing ? summary.outgoing.routes : []),
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

  const hiddenCount = activeSummaries.reduce(
    (total, direction) => total + direction.hiddenCount,
    0,
  );
  const visibleWeight = activeSummaries.reduce(
    (total, direction) => total + direction.visibleWeight,
    0,
  );
  const hiddenWeight = activeSummaries.reduce(
    (total, direction) => total + direction.hiddenWeight,
    0,
  );
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
      if (node && cityScene.selectExternalNode(node.id)) {
        externalInspectorContent.focus({ preventScroll: true });
      }
    });
  } else if (route.counterpart.kind === "building") {
    const counterpartBuildingId = route.counterpart.buildingId;
    row.addEventListener("click", () => {
      selectBuildingFromExplorer(counterpartBuildingId);
      inspectorContent.focus({ preventScroll: true });
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

function applyLogo(model: CityModel, source: ModelSource): void {
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
    modelLogoPlaceholder.textContent = initials(
      model.identity?.title ?? "Code City",
    );
    modelLogoPlaceholder.title = `${alt}: ${logo.relativePath}`;
    modelLogoPlaceholder.hidden = false;
    return;
  }

  modelLogo.src = resolveAssetUrl(
    logo.relativePath,
    source.assetRoot,
  ).href;
  modelLogo.hidden = false;
  modelLogo.onerror = () => {
    modelLogo.hidden = true;
    modelLogoPlaceholder.textContent = initials(
      model.identity?.title ?? "Code City",
    );
    modelLogoPlaceholder.title = `${alt}: ${logo.relativePath}`;
    modelLogoPlaceholder.hidden = false;
  };
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

function renderLegend(model: CityModel): void {
  legend.replaceChildren();
  const semanticGroups = [...model.semanticGroups];
  if (
    activeExternalNodes.length > 0 &&
    !semanticGroups.some(({ id }) => id === "external")
  ) {
    semanticGroups.push({
      id: "external",
      label: "External dependencies",
      color: EXTERNAL_DEPENDENCY_COLOR,
      priority: 55,
      mergeInto: "base",
    });
  }
  const groups = sortLegendGroups(semanticGroups);

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

function showInspector(context: BuildingContext | null): void {
  inspectorEmpty.hidden = context !== null;
  inspectorContent.hidden = context === null;
  districtInspectorContent.hidden = true;
  externalInspectorContent.hidden = true;
  clearSelectionButton.hidden = context === null;
  if (!context) {
    selectionStatus.textContent = "Selection cleared.";
    return;
  }

  const { building, repository, module } = context;
  inspectorContent.scrollTop = 0;
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
  renderExecutableUnits(building);
  selectionStatus.textContent =
    `Selected ${building.name}. Maximum cyclomatic complexity ` +
    `${building.metrics.maximumComplexity.toLocaleString()}.`;
}

function showDistrictInspector(context: DistrictContext): void {
  const { district, repository, module, buildingCount } = context;
  inspectorEmpty.hidden = true;
  inspectorContent.hidden = true;
  districtInspectorContent.hidden = false;
  externalInspectorContent.hidden = true;
  clearSelectionButton.hidden = false;
  districtInspectorContent.scrollTop = 0;
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
  const presentation = presentExternalDependency(
    node,
    externalConsumerIdentity,
  );

  inspectorEmpty.hidden = true;
  inspectorContent.hidden = true;
  districtInspectorContent.hidden = true;
  externalInspectorContent.hidden = false;
  clearSelectionButton.hidden = false;
  externalInspectorContent.scrollTop = 0;
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
  const presentation = presentExecutableUnits(building.units);
  inspectorFields.units.replaceChildren();
  inspectorFields.unitsDetails.open = false;
  inspectorFields.unitsDetails.hidden = presentation === null;
  inspectorFields.unitsEmpty.hidden = presentation !== null;
  inspectorFields.unitCount.hidden = presentation === null;

  if (!presentation) {
    inspectorFields.unitCount.textContent = "";
    inspectorFields.unitsSummary.textContent = "";
    inspectorFields.unitsCaption.textContent = "";
    return;
  }

  const count = presentation.count.toLocaleString();
  const unitLabel = presentation.count === 1 ? "unit" : "units";
  const maximumComplexity =
    presentation.maximumComplexity.toLocaleString();
  inspectorFields.unitsDetails.open = presentation.count <= 10;
  inspectorFields.unitCount.textContent = count;
  inspectorFields.unitsSummary.textContent =
    `${count} ${unitLabel} · highest complexity ${maximumComplexity}`;
  inspectorFields.unitsCaption.textContent =
    `Executable units for ${building.name}`;

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
    line.textContent = unit.line.toLocaleString();

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
