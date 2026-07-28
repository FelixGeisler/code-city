import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type {
  CityBuilding,
  CityModel,
  CityModule,
  CityRepository,
} from "../../../packages/core/src/model.js";
import { DEMO_MODEL } from "./demo-model.js";
import {
  AutomaticModelLoadGate,
  assetRootFromResponseUrl,
  resolveAssetUrl,
  sortLegendGroups,
} from "./model-source.js";
import { validateCityModel } from "./model-validation.js";
import {
  DEFAULT_FOG_DENSITY,
  fogDensityForCameraDistance,
} from "./scene-environment.js";
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
const legend = element<HTMLDivElement>("legend");
const errorBanner = element<HTMLDivElement>("error-banner");
const errorMessage = element<HTMLSpanElement>("error-message");
const dismissErrorButton = element<HTMLButtonElement>("dismiss-error");

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
  units: element<HTMLElement>("building-units"),
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
  private readonly buildingMeshes = new Map<
    string,
    THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  >();
  private readonly buildingContexts = new Map<string, BuildingContext>();
  private readonly resizeObserver: ResizeObserver;
  private grid: THREE.GridHelper | null = null;
  private hoveredId: string | null = null;
  private selectedId: string | null = null;
  private pointerStart: PointerPosition | null = null;

  public constructor(private readonly host: HTMLDivElement) {
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

    for (const district of model.districts) {
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
      this.city.add(base);

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({
          color: "#42688d",
          transparent: true,
          opacity: 0.72,
        }),
      );
      outline.position.copy(base.position);
      this.city.add(outline);
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
      this.city.add(mesh);
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

    this.replaceGrid(this.bounds());
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

  private readonly render = (): void => {
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
    this.select(null);
    this.buildingMeshes.clear();
    this.buildingContexts.clear();

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
    const bounds = this.bounds();
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const maximumDimension = Math.max(size.x, size.y, size.z, 1);
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const distance = (maximumDimension * 0.72) / Math.tan(halfFov);
    const direction = new THREE.Vector3(1, 0.78, -1).normalize();

    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(distance / 1_000, 0.01);
    this.camera.far = Math.max(distance * 20, maximumDimension * 20);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.maxDistance = Math.max(distance * 5, 20);
    this.controls.update();
    this.updateFog();
  }

  private replaceGrid(bounds: THREE.Box3): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      disposeObject(this.grid);
    }

    const size = bounds.getSize(new THREE.Vector3());
    const gridSize = Math.max(
      40,
      Math.ceil((Math.max(size.x, size.z) * 1.8) / 10) * 10,
    );
    const divisions = Math.min(100, Math.max(20, Math.round(gridSize / 2)));
    this.grid = new THREE.GridHelper(
      gridSize,
      divisions,
      "#274867",
      "#14283c",
    );
    this.grid.position.y = 0;
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
      [...this.buildingMeshes.values()],
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
    showInspector(id ? this.buildingContexts.get(id) ?? null : null);
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

const cityScene = new CityScene(sceneHost);
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
  cityScene.resetSelection();
});

dismissErrorButton.addEventListener("click", hideError);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    cityScene.resetSelection();
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
    const item = document.createElement("div");
    item.className = "legend-item";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = group.color;

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
    return;
  }

  const { building, repository, module } = context;
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
  inspectorFields.units.textContent =
    building.units
      ?.map(
        (unit) =>
          `${unit.name} (CC ${unit.complexity.toLocaleString()}, line ${unit.line.toLocaleString()})`,
      )
      .join(" · ") ?? "Not recorded";
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
