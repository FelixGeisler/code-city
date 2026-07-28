import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type {
  CityBuilding,
  CityModel,
  CityModule,
  CityRepository,
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
  type DependencyOverlayRoute,
  DependencyRouteOverlay,
} from "./dependency-overlay.js";
import {
  keyedBoundaryGateway,
  roofRoutePoint,
  type RoutePoint,
  type RouteRectangle,
} from "./dependency-route-layout.js";
import { DEMO_MODEL } from "./demo-model.js";
import {
  AutomaticModelLoadGate,
  assetRootFromResponseUrl,
  resolveAssetUrl,
  sortLegendGroups,
} from "./model-source.js";
import { validateCityModel } from "./model-validation.js";
import {
  clearExplorerSelection,
  createRepositoryExplorerIndex,
  type ExplorerState,
  isolateSelectedDistrict as isolateExplorerDistrict,
  resetExplorerState,
  searchRepositoryBuildings,
  selectExplorerBuilding,
  showAllDistricts,
} from "./repository-explorer.js";
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
const tooltip = element<HTMLDivElement>("tooltip");
const inspectorEmpty = element<HTMLDivElement>("inspector-empty");
const inspectorContent = element<HTMLDivElement>("inspector-content");
const clearSelectionButton =
  element<HTMLButtonElement>("clear-selection");
const legend = element<HTMLUListElement>("legend");
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
  private readonly buildingMeshes = new Map<
    string,
    THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  >();
  private readonly buildingContexts = new Map<string, BuildingContext>();
  private readonly districtGroups = new Map<string, THREE.Group>();
  private readonly resizeObserver: ResizeObserver;
  private grid: THREE.GridHelper | null = null;
  private hoveredId: string | null = null;
  private selectedId: string | null = null;
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

  public load(model: CityModel): void {
    this.clear();

    const repositories = new Map(
      model.repositories.map((item) => [item.id, item]),
    );
    const modules = new Map(model.modules.map((item) => [item.id, item]));
    const groups = new Map(
      model.semanticGroups.map((item) => [item.id, item]),
    );
    const base = cityBaseForModel(model);
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
      districtGroup.add(base);

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
    this.select(id);
    if (focus) {
      this.focusBuilding(id);
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
    if (focus) {
      this.frameObject(selectedGroup, true);
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
    this.dependencyOverlay.clear();
    this.isolatedDistrictId = null;
    this.cameraTransition = null;
    this.select(null);
    this.buildingMeshes.clear();
    this.buildingContexts.clear();
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
    const id = this.pick(event);
    this.hover(id);

    if (!id) {
      tooltip.hidden = true;
      return;
    }

    const context = this.buildingContexts.get(id);
    if (!context) {
      return;
    }

    tooltip.textContent = `${context.building.name} · CC ${context.building.metrics.maximumComplexity.toLocaleString()}`;
    tooltip.hidden = false;
    const bounds = this.host.getBoundingClientRect();
    const left = Math.min(
      event.clientX - bounds.left + 14,
      Math.max(8, bounds.width - 230),
    );
    const top = Math.min(
      event.clientY - bounds.top + 14,
      Math.max(8, bounds.height - 56),
    );
    tooltip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
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
    tooltip.hidden = true;
  };

  private pick(event: PointerEvent): string | null {
    if (this.buildingMeshes.size === 0) {
      return null;
    }

    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycaster.intersectObjects(
      [...this.buildingMeshes.values()].filter(
        (mesh) => mesh.parent?.visible !== false,
      ),
      false,
    )[0];
    const id = hit?.object.userData["buildingId"];
    return typeof id === "string" ? id : null;
  }

  private hover(id: string | null): void {
    if (id === this.hoveredId) {
      return;
    }
    const previous = this.hoveredId;
    this.hoveredId = id;
    this.updateHighlight(previous);
    this.updateHighlight(id);
    this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
  }

  private select(id: string | null): void {
    if (id === this.selectedId) {
      return;
    }
    const previous = this.selectedId;
    this.selectedId = id;
    this.updateHighlight(previous);
    this.updateHighlight(id);
    const context = id ? this.buildingContexts.get(id) ?? null : null;
    showInspector(context);
    this.emitState();
  }

  private emitState(): void {
    this.onStateChange({
      selectedBuildingId: this.selectedId,
      isolatedDistrictId: this.isolatedDistrictId,
    });
  }

  private updateHighlight(id: string | null): void {
    if (!id) {
      return;
    }
    const mesh = this.buildingMeshes.get(id);
    if (!mesh) {
      return;
    }
    const selected = id === this.selectedId;
    const hovered = id === this.hoveredId;
    mesh.material.emissive.copy(mesh.material.color);
    mesh.material.emissiveIntensity =
      selected && hovered ? 0.62 : selected ? 0.45 : hovered ? 0.26 : 0;
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
let repositoryExplorerIndex = createRepositoryExplorerIndex(DEMO_MODEL);
let explorerState = resetExplorerState();
const cityScene = new CityScene(sceneHost, synchronizeExplorerState);
const automaticModelLoadGate = new AutomaticModelLoadGate();

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
  const buildingsById = new Map(
    model.buildings.map((building) => [building.id, building]),
  );
  const districtsById = new Map(
    model.districts.map((district) => [district.id, district]),
  );
  const nextDependencyExplorerIndex =
    createDependencyExplorerIndex(model);
  const nextRepositoryExplorerIndex =
    createRepositoryExplorerIndex(model);

  activeModel = model;
  activeBuildingsById = buildingsById;
  activeDistrictsById = districtsById;
  dependencyExplorerIndex = nextDependencyExplorerIndex;
  dependencyRouteState = resetDependencyRouteState();
  repositoryExplorerIndex = nextRepositoryExplorerIndex;
  explorerState = resetExplorerState();
  buildingSearch.value = "";
  synchronizeExplorerState(explorerState);
  renderBuildingSearch();
  cityScene.load(model);
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
    if (result.buildingId === explorerState.selectedBuildingId) {
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
  if (next.selectedBuildingId === buildingId) {
    cityScene.selectBuilding(buildingId, true);
  }
}

function clearBuildingSelection(): void {
  if (clearExplorerSelection(explorerState) !== explorerState) {
    cityScene.resetSelection();
  }
}

function synchronizeExplorerState(state: ExplorerState): void {
  const previousSelectedBuildingId = explorerState.selectedBuildingId;
  explorerState = state;
  if (
    previousSelectedBuildingId !== null &&
    state.selectedBuildingId === null
  ) {
    dependencyRouteState = resetDependencyRouteState();
  }
  const selected = state.selectedBuildingId
    ? activeModel.buildings.find(
        ({ id }) => id === state.selectedBuildingId,
      )
    : undefined;
  isolateDistrictButton.disabled =
    !selected ||
    state.isolatedDistrictId === selected.districtId;
  showWholeCityButton.disabled = state.isolatedDistrictId === null;
  for (const button of searchResultButtons()) {
    if (button.dataset["buildingId"] === state.selectedBuildingId) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  renderDependencyExplorer();
}

function toggleDependencyDirection(
  direction: DependencyRouteDirection,
): void {
  const selectedBuildingId = explorerState.selectedBuildingId;
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
  const selectedBuildingId = explorerState.selectedBuildingId;
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
  const row = isExternal
    ? document.createElement("div")
    : document.createElement("button");
  row.className = "dependency-result-button";
  row.dataset["direction"] = route.direction;
  if (isExternal) {
    row.dataset["external"] = "true";
  } else if (
    row instanceof HTMLButtonElement &&
    route.counterpart.kind === "building"
  ) {
    const counterpartBuildingId = route.counterpart.buildingId;
    row.type = "button";
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

  if (!isExternal) {
    row.setAttribute(
      "aria-label",
      `${name.textContent}, ${role.toLowerCase()}, ` +
        referenceCountLabel(route.weight),
    );
  }
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
    consumer: dependencyEndpointPoint(projection.source),
    provider: dependencyEndpointPoint(projection.target),
    direction: route.direction,
    weight: route.weight,
    externalProvider: route.counterpart.kind === "external",
    gatewayAt:
      projection.source.kind === "district-boundary"
        ? "source"
        : projection.target.kind === "building"
          ? null
          : "target",
  };
}

function dependencyEndpointPoint(
  endpoint: DependencyRouteEndpoint,
): RoutePoint {
  switch (endpoint.kind) {
    case "building": {
      const building = activeBuildingsById.get(endpoint.buildingId);
      if (!building) {
        throw new Error(
          `Dependency route references unknown building "${endpoint.buildingId}".`,
        );
      }
      return roofRoutePoint(building);
    }
    case "district-boundary": {
      const district = activeDistrictsById.get(endpoint.districtId);
      if (!district) {
        throw new Error(
          `Dependency route references unknown district "${endpoint.districtId}".`,
        );
      }
      return {
        x: endpoint.position.x,
        y: district.position.y + district.size.y * 0.5 + 0.22,
        z: endpoint.position.z,
      };
    }
    case "external": {
      const scope = dependencyRouteScope();
      return keyedBoundaryGateway(
        scope.rectangle,
        endpoint.target,
        scope.y,
      );
    }
  }
}

function dependencyRouteScope(): {
  readonly rectangle: RouteRectangle;
  readonly y: number;
} {
  if (explorerState.isolatedDistrictId !== null) {
    const district = activeDistrictsById.get(
      explorerState.isolatedDistrictId,
    );
    if (!district) {
      throw new Error(
        `Unknown isolated district "${explorerState.isolatedDistrictId}".`,
      );
    }
    return {
      rectangle: {
        centerX: district.position.x,
        centerZ: district.position.z,
        sizeX: district.size.x,
        sizeZ: district.size.z,
      },
      y: district.position.y + district.size.y * 0.5 + 0.22,
    };
  }

  const base = cityBaseForModel(activeModel);
  if (!base) {
    throw new Error("Dependency routes require a city footprint.");
  }
  return {
    rectangle: {
      centerX: base.position.x,
      centerZ: base.position.z,
      sizeX: base.size.x,
      sizeZ: base.size.z,
    },
    y: base.position.y + base.size.y * 0.5 + 0.22,
  };
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
  const groups = sortLegendGroups(model.semanticGroups);

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
  clearSelectionButton.hidden = context === null;
  if (!context) {
    selectionStatus.textContent = "Building selection cleared.";
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
