import { promises as fs } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  analyzeViewForNavigation,
  initialViewerWorkspaceState,
  installViewerWorkspace,
  nextBoundedResultLimit,
  parseViewerWorkspaceWidth,
  VIEWER_WORKSPACE_MAX_WIDTH,
  VIEWER_WORKSPACE_MIN_WIDTH,
  VIEWER_ANALYZE_VIEWS,
  VIEWER_WORKSPACE_VIEWS,
  VIEWER_WORKSPACE_WIDTH_STORAGE_KEY,
  type ViewerAnalyzeView,
  type ViewerWorkspaceState,
  type ViewerWorkspaceView,
  viewerWorkspaceMaximumWidth,
  viewerWorkspaceRuntimeWidth,
  workspaceStateForAnalyze,
  workspaceStateForShow,
  workspaceViewForNavigation,
} from "../apps/viewer/src/viewer-workspace.js";

const viewerRoot = path.resolve("apps/viewer");
let html = "";
let css = "";

beforeAll(async () => {
  [html, css] = await Promise.all([
    fs.readFile(path.join(viewerRoot, "index.html"), "utf8"),
    fs.readFile(path.join(viewerRoot, "src/styles.css"), "utf8"),
  ]);
});

class FakeStyle {
  readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }
}

class FakeElement extends EventTarget {
  readonly dataset: DOMStringMap = {} as DOMStringMap;
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  readonly ownerDocument: {
    readonly defaultView: FakeWindow;
    activeElement: FakeElement | null;
  };
  hidden = false;
  scrollTop = 0;
  tabIndex = 0;
  textContent = "";
  focusCount = 0;
  private readonly childrenBySelector = new Map<
    string,
    readonly FakeElement[]
  >();
  private readonly children = new Set<FakeElement>();

  constructor(ownerWindow: FakeWindow) {
    super();
    this.ownerDocument = {
      defaultView: ownerWindow,
      activeElement: null,
    };
  }

  setChildren(selector: string, children: readonly FakeElement[]): void {
    this.childrenBySelector.set(selector, children);
    for (const child of children) {
      this.children.add(child);
      Object.defineProperty(child, "ownerDocument", {
        configurable: true,
        value: this.ownerDocument,
      });
    }
  }

  querySelectorAll<T>(selector: string): T[] {
    return [...(this.childrenBySelector.get(selector) ?? [])] as T[];
  }

  querySelector<T>(selector: string): T | null {
    return (this.childrenBySelector.get(selector)?.[0] ?? null) as T | null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    for (const child of this.children) {
      if (child.contains(candidate)) return true;
    }
    return false;
  }

  focus(): void {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  setPointerCapture(_pointerId: number): void {}
}

class FakeWindow extends EventTarget {
  readonly storageValues = new Map<string, string>();
  readonly localStorage = {
    getItem: (key: string): string | null =>
      this.storageValues.get(key) ?? null,
    setItem: vi.fn((key: string, value: string): void => {
      this.storageValues.set(key, value);
    }),
  };

  constructor(public innerWidth: number) {
    super();
  }
}

interface WorkspaceFixture {
  readonly root: FakeElement;
  readonly scrollOwner: FakeElement;
  readonly tabs: ReadonlyMap<ViewerWorkspaceView, FakeElement>;
  readonly panels: ReadonlyMap<ViewerWorkspaceView, FakeElement>;
  readonly analyzeTabs: ReadonlyMap<ViewerAnalyzeView, FakeElement>;
  readonly analyzePanels: ReadonlyMap<ViewerAnalyzeView, FakeElement>;
  readonly details: FakeElement;
  readonly detailsBack: FakeElement;
  readonly toggle: FakeElement;
  readonly resizer: FakeElement;
  readonly hostWindow: FakeWindow;
}

function workspaceFixture(width: number): WorkspaceFixture {
  const hostWindow = new FakeWindow(width);
  const root = new FakeElement(hostWindow);
  const scrollOwner = new FakeElement(hostWindow);
  const toggle = new FakeElement(hostWindow);
  const toggleIcon = new FakeElement(hostWindow);
  const resizer = new FakeElement(hostWindow);
  const tabs = new Map<ViewerWorkspaceView, FakeElement>();
  const panels = new Map<ViewerWorkspaceView, FakeElement>();
  const analyzeTabs = new Map<ViewerAnalyzeView, FakeElement>();
  const analyzePanels = new Map<ViewerAnalyzeView, FakeElement>();
  const details = new FakeElement(hostWindow);
  const detailsBack = new FakeElement(hostWindow);

  for (const view of VIEWER_WORKSPACE_VIEWS) {
    const tab = new FakeElement(hostWindow);
    tab.dataset["workspaceView"] = view;
    tabs.set(view, tab);
    const panel = new FakeElement(hostWindow);
    panel.dataset["workspacePanel"] = view;
    panels.set(view, panel);
  }
  for (const view of VIEWER_ANALYZE_VIEWS) {
    const tab = new FakeElement(hostWindow);
    tab.dataset["analyzeView"] = view;
    analyzeTabs.set(view, tab);
    const panel = new FakeElement(hostWindow);
    panel.dataset["analyzePanel"] = view;
    analyzePanels.set(view, panel);
  }
  details.dataset["workspaceContext"] = "details";
  toggle.setChildren("[aria-hidden='true']", [toggleIcon]);
  root.setChildren(
    '[role="tab"][data-workspace-view]',
    [...tabs.values()],
  );
  root.setChildren(
    '[role="tabpanel"][data-workspace-panel]',
    [...panels.values()],
  );
  root.setChildren(
    '[role="tab"][data-analyze-view]',
    [...analyzeTabs.values()],
  );
  root.setChildren(
    '[role="tabpanel"][data-analyze-panel]',
    [...analyzePanels.values()],
  );
  root.setChildren('[data-workspace-context="details"]', [details]);
  root.setChildren("[data-workspace-details-back]", [detailsBack]);
  root.setChildren("[data-workspace-toggle]", [toggle]);
  root.setChildren("[data-workspace-resizer]", [resizer]);

  return {
    root,
    scrollOwner,
    tabs,
    panels,
    analyzeTabs,
    analyzePanels,
    details,
    detailsBack,
    toggle,
    resizer,
    hostWindow,
  };
}

function fakeEvent(
  type: string,
  properties: Readonly<Record<string, unknown>> = {},
): Event {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { value });
  }
  return event;
}

describe("viewer workspace navigation", () => {
  it("keeps the primary choice small and groups analysis tools", () => {
    expect(VIEWER_WORKSPACE_VIEWS).toEqual(["explore", "analyze"]);
    expect(VIEWER_ANALYZE_VIEWS).toEqual([
      "findings",
      "routes",
      "queries",
    ]);
  });

  it("reveals bounded result chunks without crossing hard caps", () => {
    expect(nextBoundedResultLimit(8, 24, 8)).toBe(16);
    expect(nextBoundedResultLimit(16, 24, 8)).toBe(24);
    expect(nextBoundedResultLimit(24, 24, 8)).toBe(24);
    expect(() => nextBoundedResultLimit(8, 24, 0)).toThrow(
      RangeError,
    );
  });

  it("wraps predictably and supports Home and End", () => {
    expect(workspaceViewForNavigation("explore", "ArrowLeft")).toBe(
      "analyze",
    );
    expect(workspaceViewForNavigation("analyze", "ArrowRight")).toBe(
      "explore",
    );
    expect(workspaceViewForNavigation("analyze", "Home")).toBe(
      "explore",
    );
    expect(workspaceViewForNavigation("explore", "End")).toBe(
      "analyze",
    );
    expect(analyzeViewForNavigation("findings", "ArrowLeft")).toBe(
      "queries",
    );
    expect(analyzeViewForNavigation("queries", "ArrowRight")).toBe(
      "findings",
    );
    expect(analyzeViewForNavigation("routes", "Home")).toBe(
      "findings",
    );
    expect(analyzeViewForNavigation("routes", "End")).toBe(
      "queries",
    );
  });

  it("moves through every view in stable order", () => {
    let view: ViewerWorkspaceView = VIEWER_WORKSPACE_VIEWS[0];
    const visited: ViewerWorkspaceView[] = [view];
    for (
      let index = 1;
      index < VIEWER_WORKSPACE_VIEWS.length;
      index += 1
    ) {
      view = workspaceViewForNavigation(view, "ArrowRight");
      visited.push(view);
    }
    expect(visited).toEqual(VIEWER_WORKSPACE_VIEWS);
  });
});

describe("viewer workspace state", () => {
  it("starts in Explore and only peeks on compact screens", () => {
    expect(initialViewerWorkspaceState(false)).toEqual({
      activeView: "explore",
      activeAnalyzeView: "findings",
      detailsOpen: false,
      sheetState: "expanded",
    });
    expect(initialViewerWorkspaceState(true)).toEqual({
      activeView: "explore",
      activeAnalyzeView: "findings",
      detailsOpen: false,
      sheetState: "peek",
    });
  });

  it("keeps passive compact details unobtrusive", () => {
    const compact = initialViewerWorkspaceState(true);
    expect(
      workspaceStateForShow(compact, "details", {
        compact: true,
        intent: "passive",
      }),
    ).toEqual({
      activeView: "explore",
      activeAnalyzeView: "findings",
      detailsOpen: true,
      sheetState: "peek",
    });
    expect(
      workspaceStateForShow(
        { ...compact, sheetState: "expanded" },
        "details",
        { compact: true, intent: "passive" },
      ),
    ).toEqual({
      activeView: "explore",
      activeAnalyzeView: "findings",
      detailsOpen: true,
      sheetState: "expanded",
    });
  });

  it("expands explicit compact views and preserves nested analysis state", () => {
    const collapsed = {
      activeView: "explore",
      activeAnalyzeView: "findings",
      detailsOpen: false,
      sheetState: "collapsed",
    } as const;
    expect(
      workspaceStateForAnalyze(collapsed, "routes", {
        compact: true,
        intent: "explicit",
      }),
    ).toEqual({
      activeView: "analyze",
      activeAnalyzeView: "routes",
      detailsOpen: false,
      sheetState: "expanded",
    });
    expect(
      workspaceStateForShow(collapsed, "details", {
        compact: false,
        intent: "passive",
      }).sheetState,
    ).toBe("expanded");
  });

  it("restores each view's scroll position and suppresses passive focus", () => {
    const fixture = workspaceFixture(900);
    const controller = installViewerWorkspace(
      fixture.root as unknown as HTMLElement,
      fixture.scrollOwner as unknown as HTMLElement,
      {
        window: fixture.hostWindow as unknown as Window,
        storage: fixture.hostWindow.localStorage,
      },
    );

    expect(controller.activeView).toBe("explore");
    expect(controller.activeAnalyzeView).toBe("findings");
    expect(controller.sheetState).toBe("peek");
    fixture.scrollOwner.scrollTop = 73;
    controller.showAnalyze("routes");
    fixture.scrollOwner.scrollTop = 21;
    controller.show("explore");
    expect(fixture.scrollOwner.scrollTop).toBe(73);
    controller.showAnalyze("routes");
    expect(fixture.scrollOwner.scrollTop).toBe(21);

    controller.setSheetState("collapsed");
    controller.showDetails({
      intent: "passive",
      focus: true,
    });
    expect(controller.sheetState).toBe("peek");
    expect(fixture.details.focusCount).toBe(0);
    controller.showAnalyze("queries", {
      intent: "explicit",
      focus: true,
    });
    expect(controller.sheetState).toBe("expanded");
    expect(fixture.analyzeTabs.get("queries")!.focusCount).toBe(1);
  });

  it("never lets passive intent steal focus, including on desktop", () => {
    const fixture = workspaceFixture(1300);
    const controller = installViewerWorkspace(
      fixture.root as unknown as HTMLElement,
      fixture.scrollOwner as unknown as HTMLElement,
      {
        window: fixture.hostWindow as unknown as Window,
        storage: fixture.hostWindow.localStorage,
      },
    );

    controller.showDetails({
      intent: "passive",
      focus: true,
    });
    expect(controller.sheetState).toBe("expanded");
    expect(fixture.details.focusCount).toBe(0);
  });

  it("returns from contextual details to the prior workspace", () => {
    const fixture = workspaceFixture(1300);
    const controller = installViewerWorkspace(
      fixture.root as unknown as HTMLElement,
      fixture.scrollOwner as unknown as HTMLElement,
      {
        window: fixture.hostWindow as unknown as Window,
        storage: fixture.hostWindow.localStorage,
      },
    );

    controller.showAnalyze("routes");
    controller.showDetails({ intent: "explicit", focus: true });
    expect(controller.detailsOpen).toBe(true);
    expect(fixture.details.focusCount).toBe(1);
    expect(
      fixture.tabs.get("analyze")!.getAttribute("aria-selected"),
    ).toBe("true");
    expect(fixture.tabs.get("analyze")!.tabIndex).toBe(0);
    expect(
      fixture.analyzeTabs.get("routes")!.getAttribute("aria-selected"),
    ).toBe("true");
    fixture.detailsBack.dispatchEvent(fakeEvent("click"));
    expect(controller.detailsOpen).toBe(false);
    expect(controller.activeView).toBe("analyze");
    expect(controller.activeAnalyzeView).toBe("routes");
    expect(fixture.tabs.get("analyze")!.focusCount).toBe(0);
    expect(fixture.analyzeTabs.get("routes")!.focusCount).toBe(1);
  });

  it("uses peek when entering compact mode and expands on desktop", () => {
    const fixture = workspaceFixture(1100);
    const controller = installViewerWorkspace(
      fixture.root as unknown as HTMLElement,
      fixture.scrollOwner as unknown as HTMLElement,
      {
        window: fixture.hostWindow as unknown as Window,
        storage: fixture.hostWindow.localStorage,
      },
    );

    fixture.hostWindow.innerWidth = 1099;
    fixture.hostWindow.dispatchEvent(fakeEvent("resize"));
    expect(controller.compact).toBe(true);
    expect(controller.sheetState).toBe("peek");
    fixture.hostWindow.innerWidth = 1100;
    fixture.hostWindow.dispatchEvent(fakeEvent("resize"));
    expect(controller.compact).toBe(false);
    expect(controller.sheetState).toBe("expanded");
  });

  it("reports initial, view, sheet, and responsive state changes", () => {
    const fixture = workspaceFixture(1300);
    const states: ViewerWorkspaceState[] = [];
    const controller = installViewerWorkspace(
      fixture.root as unknown as HTMLElement,
      fixture.scrollOwner as unknown as HTMLElement,
      {
        window: fixture.hostWindow as unknown as Window,
        storage: fixture.hostWindow.localStorage,
        onStateChange: (state) => states.push(state),
      },
    );

    expect(states).toEqual([
      {
        activeView: "explore",
        activeAnalyzeView: "findings",
        detailsOpen: false,
        sheetState: "expanded",
      },
    ]);
    expect(Object.isFrozen(states[0])).toBe(true);
    controller.show("explore");
    controller.setSheetState("collapsed");
    fixture.hostWindow.innerWidth = 900;
    fixture.hostWindow.dispatchEvent(fakeEvent("resize"));
    expect(states.slice(1)).toEqual([
      {
        activeView: "explore",
        activeAnalyzeView: "findings",
        detailsOpen: false,
        sheetState: "expanded",
      },
      {
        activeView: "explore",
        activeAnalyzeView: "findings",
        detailsOpen: false,
        sheetState: "collapsed",
      },
      {
        activeView: "explore",
        activeAnalyzeView: "findings",
        detailsOpen: false,
        sheetState: "collapsed",
      },
    ]);
  });

  it("exposes visible peek content truthfully and relocates owned focus", () => {
    const fixture = workspaceFixture(900);
    const controller = installViewerWorkspace(
      fixture.root as unknown as HTMLElement,
      fixture.scrollOwner as unknown as HTMLElement,
      {
        window: fixture.hostWindow as unknown as Window,
        storage: fixture.hostWindow.localStorage,
      },
    );

    expect(fixture.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(fixture.toggle.getAttribute("aria-label")).toBe(
      "Expand viewer tools fully",
    );
    fixture.tabs.get("explore")!.focus();
    controller.setSheetState("collapsed");
    expect(fixture.toggle.focusCount).toBe(1);
    expect(fixture.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(fixture.toggle.getAttribute("aria-label")).toBe(
      "Show viewer tools",
    );
    controller.setSheetState("expanded");
    expect(fixture.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(fixture.toggle.getAttribute("aria-label")).toBe(
      "Collapse viewer tools",
    );
  });
});

describe("viewer workspace dock width", () => {
  it("accepts only finite persisted widths in the versioned range", () => {
    expect(parseViewerWorkspaceWidth("320")).toBe(320);
    expect(parseViewerWorkspaceWidth("640")).toBe(640);
    expect(parseViewerWorkspaceWidth("319")).toBeUndefined();
    expect(parseViewerWorkspaceWidth("641")).toBeUndefined();
    expect(parseViewerWorkspaceWidth("Infinity")).toBeUndefined();
    expect(parseViewerWorkspaceWidth("")).toBeUndefined();
    expect(parseViewerWorkspaceWidth(null)).toBeUndefined();
  });

  it("caps runtime width without overwriting the preference", () => {
    expect(viewerWorkspaceMaximumWidth(1100)).toBe(620);
    expect(viewerWorkspaceRuntimeWidth(640, 1100)).toBe(620);
    expect(viewerWorkspaceRuntimeWidth(640, 1300)).toBe(640);
    expect(viewerWorkspaceRuntimeWidth(Number.NaN, 1300)).toBe(420);
  });

  it("resizes by pointer and keyboard with complete ARIA state", () => {
    const fixture = workspaceFixture(1300);
    fixture.hostWindow.storageValues.set(
      VIEWER_WORKSPACE_WIDTH_STORAGE_KEY,
      "500",
    );
    const controller = installViewerWorkspace(
      fixture.root as unknown as HTMLElement,
      fixture.scrollOwner as unknown as HTMLElement,
      {
        window: fixture.hostWindow as unknown as Window,
        storage: fixture.hostWindow.localStorage,
      },
    );

    expect(
      fixture.root.style.getPropertyValue(
        "--viewer-workspace-width",
      ),
    ).toBe("500px");
    expect(fixture.resizer.getAttribute("role")).toBe("separator");
    expect(fixture.resizer.getAttribute("aria-valuemin")).toBe(
      String(VIEWER_WORKSPACE_MIN_WIDTH),
    );
    expect(fixture.resizer.getAttribute("aria-valuemax")).toBe(
      String(VIEWER_WORKSPACE_MAX_WIDTH),
    );
    expect(fixture.resizer.getAttribute("aria-valuenow")).toBe("500");

    fixture.resizer.dispatchEvent(
      fakeEvent("pointerdown", {
        button: 0,
        clientX: 600,
        pointerId: 1,
      }),
    );
    fixture.hostWindow.dispatchEvent(
      fakeEvent("pointermove", { clientX: 550, pointerId: 1 }),
    );
    fixture.hostWindow.dispatchEvent(
      fakeEvent("pointerup", { clientX: 550, pointerId: 1 }),
    );
    expect(
      fixture.root.style.getPropertyValue(
        "--viewer-workspace-width",
      ),
    ).toBe("550px");
    expect(fixture.hostWindow.localStorage.setItem).toHaveBeenCalledWith(
      VIEWER_WORKSPACE_WIDTH_STORAGE_KEY,
      "550",
    );

    fixture.resizer.dispatchEvent(
      fakeEvent("keydown", { key: "Home" }),
    );
    expect(fixture.resizer.getAttribute("aria-valuenow")).toBe("320");
    fixture.resizer.dispatchEvent(
      fakeEvent("keydown", { key: "End" }),
    );
    expect(fixture.resizer.getAttribute("aria-valuenow")).toBe("640");

    controller.dispose();
    fixture.resizer.dispatchEvent(
      fakeEvent("keydown", { key: "Home" }),
    );
    expect(fixture.resizer.getAttribute("aria-valuenow")).toBe("640");
    fixture.tabs.get("explore")!.dispatchEvent(fakeEvent("click"));
    fixture.toggle.dispatchEvent(fakeEvent("click"));
    fixture.hostWindow.innerWidth = 900;
    fixture.hostWindow.dispatchEvent(fakeEvent("resize"));
    expect(controller.activeView).toBe("explore");
    expect(controller.sheetState).toBe("expanded");
    expect(controller.compact).toBe(false);
  });

  it("keeps a persisted preference while viewport caps come and go", () => {
    const fixture = workspaceFixture(1100);
    fixture.hostWindow.storageValues.set(
      VIEWER_WORKSPACE_WIDTH_STORAGE_KEY,
      "640",
    );
    const controller = installViewerWorkspace(
      fixture.root as unknown as HTMLElement,
      fixture.scrollOwner as unknown as HTMLElement,
      {
        window: fixture.hostWindow as unknown as Window,
        storage: fixture.hostWindow.localStorage,
      },
    );

    expect(
      fixture.root.style.getPropertyValue(
        "--viewer-workspace-width",
      ),
    ).toBe("620px");
    expect(fixture.hostWindow.localStorage.setItem).not.toHaveBeenCalled();
    fixture.hostWindow.innerWidth = 1300;
    fixture.hostWindow.dispatchEvent(fakeEvent("resize"));
    expect(
      fixture.root.style.getPropertyValue(
        "--viewer-workspace-width",
      ),
    ).toBe("640px");
    expect(fixture.hostWindow.localStorage.setItem).not.toHaveBeenCalled();

    fixture.hostWindow.innerWidth = 900;
    fixture.hostWindow.dispatchEvent(fakeEvent("resize"));
    expect(controller.compact).toBe(true);
    expect(fixture.resizer.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("viewer workspace markup", () => {
  it("provides two primary tabs and grouped analysis tabs", () => {
    for (const view of VIEWER_WORKSPACE_VIEWS) {
      expect(html).toContain(`id="viewer-tab-${view}"`);
      expect(html).toContain(`data-workspace-view="${view}"`);
      expect(html).toContain(`id="viewer-view-${view}"`);
      expect(html).toContain(`data-workspace-panel="${view}"`);
      expect(html).toMatch(
        new RegExp(
          `id="viewer-view-${view}"[\\s\\S]*?role="tabpanel"[\\s\\S]*?aria-labelledby="viewer-tab-${view}"`,
          "u",
        ),
      );
    }
    for (const view of VIEWER_ANALYZE_VIEWS) {
      expect(html).toContain(`id="analyze-tab-${view}"`);
      expect(html).toContain(`data-analyze-view="${view}"`);
      expect(html).toContain(`id="analyze-view-${view}"`);
      expect(html).toContain(`data-analyze-panel="${view}"`);
      expect(html).toMatch(
        new RegExp(
          `id="analyze-view-${view}"[\\s\\S]*?role="tabpanel"[\\s\\S]*?aria-labelledby="analyze-tab-${view}"`,
          "u",
        ),
      );
    }
    expect(html).toContain('data-workspace-context="details"');
    expect(html).toContain("data-workspace-details-back");
    expect(html).toContain('id="viewer-workspace-toggle"');
    expect(html).toContain('aria-controls="viewer-workspace-scroll"');
    expect(html).toContain("data-workspace-resizer");
  });

  it("keeps every eagerly required integration element exactly once", () => {
    const requiredIds = [
      "find-panel",
      "building-search",
      "search-status",
      "search-results",
      "isolate-district",
      "show-whole-city",
      "district-routes-toggle",
      "district-routes-list",
      "district-routes-show-more",
      "district-route-details",
      "inspector-empty",
      "inspector-content",
      "district-inspector-content",
      "external-inspector-content",
      "clear-selection",
      "dependency-list",
      "dependency-show-more",
      "building-units",
      "building-units-show-more",
      "legend",
      "external-zone",
      "external-list",
      "print-export-open",
      "print-export-dialog",
    ];

    for (const id of requiredIds) {
      expect(
        html.match(new RegExp(`id="${id}"`, "gu"))?.length ?? 0,
        id,
      ).toBe(1);
    }
  });

  it("uses one workspace scroll owner and no nested panel scrollers", () => {
    expect(css).toMatch(
      /\.viewer-workspace-scroll\s*\{[\s\S]*?overflow-y:\s*auto/u,
    );
    expect(css.match(/overflow-y:\s*(?:auto|scroll)/gu)).toHaveLength(
      1,
    );
    for (const selector of [
      ".viewer-workspace-view",
      ".viewer-workspace .panel",
      ".find-panel",
      ".district-routes-panel",
      ".inspector",
      ".dependency-list",
      ".unit-table-wrap",
      ".legend",
      ".external-list",
    ]) {
      const escaped = selector.replace(
        /[.*+?^${}()|[\]\\]/gu,
        "\\$&",
      );
      expect(css, selector).not.toMatch(
        new RegExp(
          `${escaped}[^{}]*\\{[^{}]*overflow(?:-y)?:\\s*(?:auto|scroll)`,
          "u",
        ),
      );
    }
    for (const id of [
      "district-routes-list",
      "district-route-contributors",
      "dependency-list",
      "inspector-content",
      "district-inspector-content",
      "external-inspector-content",
      "legend",
    ]) {
      expect(html).not.toMatch(
        new RegExp(`id="${id}"[^>]*tabindex=`, "u"),
      );
    }
  });

  it("exposes a visible keyboard button for the local model picker", () => {
    expect(html).toMatch(
      /<button[\s\S]*?id="model-file-open"[\s\S]*?>[\s\S]*?Open model[\s\S]*?<\/button>/u,
    );
    expect(html).toMatch(
      /<input[\s\S]*?id="model-file"[\s\S]*?type="file"/u,
    );
  });

  it("keeps the primary import action visible and groups secondary actions", () => {
    expect(html).toContain('id="project-import-open"');
    expect(html).toContain('id="project-actions-menu"');
    expect(html).toContain('id="export-actions-menu"');
    expect(html).toContain('id="advanced-project-settings-dialog"');
    expect(html).toContain('id="advanced-project-settings-open"');
  });

  it("docks beside the scene and becomes a three-state compact sheet", () => {
    expect(css).toContain("--viewer-workspace-width");
    expect(css).toMatch(
      /@media \(min-width: 1100px\)[\s\S]*?\.viewer-workspace\s*\{[\s\S]*?width:\s*var\(--viewer-workspace-width(?:,\s*420px)?\)/u,
    );
    expect(css).toContain('data-sheet-state="collapsed"');
    expect(css).toContain('data-sheet-state="peek"');
  });

  it("keeps scope persistent and exposes all overview metrics", () => {
    const scopePosition = html.indexOf('class="viewer-scope"');
    const scrollPosition = html.indexOf(
      'id="viewer-workspace-scroll"',
    );
    expect(scopePosition).toBeGreaterThan(0);
    expect(scopePosition).toBeLessThan(scrollPosition);
    expect(html).toMatch(
      /id="viewer-scope-reset"[\s\S]*?aria-label="Show whole city"/u,
    );
    for (const id of [
      "overview-repositories",
      "overview-solutions",
      "overview-modules",
      "overview-districts",
      "overview-buildings",
      "overview-sloc",
      "overview-median-complexity",
      "overview-max-complexity",
      "overview-dependency-edges",
      "overview-reference-weight",
      "overview-risk-low",
      "overview-risk-moderate",
      "overview-risk-high",
      "overview-risk-very-high",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });

  it("starts dense details and the legend collapsed", () => {
    expect(html).toMatch(
      /<details(?=[^>]*id="dependency-section")(?![^>]*\sopen\b)[^>]*>/u,
    );
    expect(html).toMatch(
      /<details(?=[^>]*id="building-units-details")(?![^>]*\sopen\b)[^>]*>/u,
    );
    expect(html).toMatch(
      /<details(?=[^>]*id="overview-legend")(?![^>]*\sopen\b)[^>]*>/u,
    );
    expect(html).toContain(
      'class="panel-heading selection-header"',
    );
    expect(css).toMatch(
      /\.selection-header\s*\{[\s\S]*?position:\s*sticky/u,
    );
  });

  it("does not render sub-10px viewer text", () => {
    expect(css).not.toMatch(/font-size:\s*[1-9]px/u);
  });
});
