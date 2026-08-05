export const VIEWER_WORKSPACE_VIEWS = [
  "explore",
  "analyze",
] as const;

export type ViewerWorkspaceView =
  (typeof VIEWER_WORKSPACE_VIEWS)[number];

export const VIEWER_ANALYZE_VIEWS = [
  "findings",
  "routes",
  "queries",
] as const;

export type ViewerAnalyzeView =
  (typeof VIEWER_ANALYZE_VIEWS)[number];

export const VIEWER_WORKSPACE_SHEET_STATES = [
  "collapsed",
  "peek",
  "expanded",
] as const;

export type ViewerWorkspaceSheetState =
  (typeof VIEWER_WORKSPACE_SHEET_STATES)[number];

export type ViewerWorkspaceShowIntent = "passive" | "explicit";

export type ViewerWorkspaceNavigationKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End";

export const VIEWER_WORKSPACE_COMPACT_BREAKPOINT = 1100;
export const VIEWER_WORKSPACE_MIN_WIDTH = 320;
export const VIEWER_WORKSPACE_MAX_WIDTH = 640;
export const VIEWER_WORKSPACE_DEFAULT_WIDTH = 420;
export const VIEWER_WORKSPACE_MIN_SCENE_WIDTH = 480;
export const VIEWER_WORKSPACE_WIDTH_STORAGE_KEY =
  "viewer-workspace-width-v1";

const VIEWER_WORKSPACE_RESIZE_STEP = 16;

export function nextBoundedResultLimit(
  current: number,
  maximum: number,
  increment: number,
): number {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(maximum) ||
    !Number.isFinite(increment) ||
    maximum < 1 ||
    increment < 1
  ) {
    throw new RangeError(
      "Progressive result limits must be finite and positive.",
    );
  }
  return Math.min(
    Math.floor(maximum),
    Math.max(1, Math.floor(current)) + Math.floor(increment),
  );
}

export interface ViewerWorkspaceState {
  readonly activeView: ViewerWorkspaceView;
  readonly activeAnalyzeView: ViewerAnalyzeView;
  readonly detailsOpen: boolean;
  readonly sheetState: ViewerWorkspaceSheetState;
}

export interface ViewerWorkspaceShowOptions {
  readonly intent?: ViewerWorkspaceShowIntent;
  readonly focus?: boolean;
}

export interface ViewerWorkspaceController {
  readonly activeView: ViewerWorkspaceView;
  readonly activeAnalyzeView: ViewerAnalyzeView;
  readonly detailsOpen: boolean;
  readonly sheetState: ViewerWorkspaceSheetState;
  readonly collapsed: boolean;
  readonly compact: boolean;
  show: (
    view: ViewerWorkspaceView,
    options?: ViewerWorkspaceShowOptions,
  ) => void;
  showAnalyze: (
    view: ViewerAnalyzeView,
    options?: ViewerWorkspaceShowOptions,
  ) => void;
  showDetails: (options?: ViewerWorkspaceShowOptions) => void;
  closeDetails: (options?: { readonly focusTab?: boolean }) => void;
  setSheetState: (state: ViewerWorkspaceSheetState) => void;
  /** Compatibility alias for integrations using the previous controller. */
  setCollapsed: (collapsed: boolean) => void;
  dispose: () => void;
}

export interface ViewerWorkspaceInstallOptions {
  readonly window?: Window;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly onStateChange?: (state: ViewerWorkspaceState) => void;
}

export function initialViewerWorkspaceState(
  compact: boolean,
): ViewerWorkspaceState {
  return {
    activeView: "explore",
    activeAnalyzeView: "findings",
    detailsOpen: false,
    sheetState: compact ? "peek" : "expanded",
  };
}

export function workspaceStateForShow(
  current: ViewerWorkspaceState,
  view: ViewerWorkspaceView | "details",
  options: {
    readonly compact: boolean;
    readonly intent?: ViewerWorkspaceShowIntent | undefined;
  },
): ViewerWorkspaceState {
  const intent = options.intent ?? "explicit";
  let sheetState = current.sheetState;

  if (!options.compact || intent === "explicit") {
    sheetState = "expanded";
  } else if (
    view === "details" &&
    current.sheetState !== "expanded"
  ) {
    sheetState = "peek";
  }

  return view === "details"
    ? { ...current, detailsOpen: true, sheetState }
    : {
        ...current,
        activeView: view,
        detailsOpen: false,
        sheetState,
      };
}

export function workspaceStateForAnalyze(
  current: ViewerWorkspaceState,
  view: ViewerAnalyzeView,
  options: {
    readonly compact: boolean;
    readonly intent?: ViewerWorkspaceShowIntent | undefined;
  },
): ViewerWorkspaceState {
  return {
    ...workspaceStateForShow(current, "analyze", options),
    activeAnalyzeView: view,
  };
}

export function parseViewerWorkspaceWidth(
  persisted: string | null | undefined,
): number | undefined {
  if (persisted === null || persisted === undefined) return undefined;
  if (persisted.trim().length === 0) return undefined;
  const width = Number(persisted);
  return Number.isFinite(width) &&
    width >= VIEWER_WORKSPACE_MIN_WIDTH &&
    width <= VIEWER_WORKSPACE_MAX_WIDTH
    ? width
    : undefined;
}

export function viewerWorkspaceMaximumWidth(
  viewportWidth: number,
): number {
  if (!Number.isFinite(viewportWidth)) {
    return VIEWER_WORKSPACE_MAX_WIDTH;
  }
  return Math.min(
    VIEWER_WORKSPACE_MAX_WIDTH,
    Math.max(
      VIEWER_WORKSPACE_MIN_WIDTH,
      Math.floor(viewportWidth) - VIEWER_WORKSPACE_MIN_SCENE_WIDTH,
    ),
  );
}

export function viewerWorkspaceRuntimeWidth(
  preferredWidth: number,
  viewportWidth: number,
): number {
  const preferred =
    Number.isFinite(preferredWidth) &&
    preferredWidth >= VIEWER_WORKSPACE_MIN_WIDTH &&
    preferredWidth <= VIEWER_WORKSPACE_MAX_WIDTH
      ? preferredWidth
      : VIEWER_WORKSPACE_DEFAULT_WIDTH;
  return Math.min(
    preferred,
    viewerWorkspaceMaximumWidth(viewportWidth),
  );
}

function clampViewerWorkspaceWidth(width: number): number {
  return Math.min(
    VIEWER_WORKSPACE_MAX_WIDTH,
    Math.max(VIEWER_WORKSPACE_MIN_WIDTH, width),
  );
}

function isNavigationKey(
  value: string,
): value is ViewerWorkspaceNavigationKey {
  return (
    value === "ArrowLeft" ||
    value === "ArrowRight" ||
    value === "Home" ||
    value === "End"
  );
}

export function workspaceViewForNavigation(
  current: ViewerWorkspaceView,
  key: ViewerWorkspaceNavigationKey,
): ViewerWorkspaceView {
  if (key === "Home") return VIEWER_WORKSPACE_VIEWS[0];
  if (key === "End") return VIEWER_WORKSPACE_VIEWS.at(-1)!;
  const currentIndex = VIEWER_WORKSPACE_VIEWS.indexOf(current);
  const offset = key === "ArrowRight" ? 1 : -1;
  const nextIndex =
    (currentIndex + offset + VIEWER_WORKSPACE_VIEWS.length) %
    VIEWER_WORKSPACE_VIEWS.length;
  return VIEWER_WORKSPACE_VIEWS[nextIndex]!;
}

export function analyzeViewForNavigation(
  current: ViewerAnalyzeView,
  key: ViewerWorkspaceNavigationKey,
): ViewerAnalyzeView {
  if (key === "Home") return VIEWER_ANALYZE_VIEWS[0];
  if (key === "End") return VIEWER_ANALYZE_VIEWS.at(-1)!;
  const currentIndex = VIEWER_ANALYZE_VIEWS.indexOf(current);
  const offset = key === "ArrowRight" ? 1 : -1;
  const nextIndex =
    (currentIndex + offset + VIEWER_ANALYZE_VIEWS.length) %
    VIEWER_ANALYZE_VIEWS.length;
  return VIEWER_ANALYZE_VIEWS[nextIndex]!;
}

function workspaceView(
  element: HTMLElement,
  attribute: "workspaceView" | "workspacePanel",
): ViewerWorkspaceView | undefined {
  const value = element.dataset[attribute];
  return VIEWER_WORKSPACE_VIEWS.find((candidate) => candidate === value);
}

function requiredViewElement<T extends HTMLElement>(
  elements: readonly T[],
  attribute: "workspaceView" | "workspacePanel",
  view: ViewerWorkspaceView,
): T {
  const match = elements.find(
    (element) => workspaceView(element, attribute) === view,
  );
  if (!match) {
    throw new Error(`Missing viewer workspace ${attribute} '${view}'.`);
  }
  return match;
}

function analyzeView(
  element: HTMLElement,
  attribute: "analyzeView" | "analyzePanel",
): ViewerAnalyzeView | undefined {
  const value = element.dataset[attribute];
  return VIEWER_ANALYZE_VIEWS.find((candidate) => candidate === value);
}

function requiredAnalyzeElement<T extends HTMLElement>(
  elements: readonly T[],
  attribute: "analyzeView" | "analyzePanel",
  view: ViewerAnalyzeView,
): T {
  const match = elements.find(
    (element) => analyzeView(element, attribute) === view,
  );
  if (!match) {
    throw new Error(`Missing viewer analyze ${attribute} '${view}'.`);
  }
  return match;
}

function readPreferredWidth(
  storage: Pick<Storage, "getItem"> | undefined,
): number {
  if (!storage) return VIEWER_WORKSPACE_DEFAULT_WIDTH;
  try {
    return (
      parseViewerWorkspaceWidth(
        storage.getItem(VIEWER_WORKSPACE_WIDTH_STORAGE_KEY),
      ) ?? VIEWER_WORKSPACE_DEFAULT_WIDTH
    );
  } catch {
    return VIEWER_WORKSPACE_DEFAULT_WIDTH;
  }
}

function persistPreferredWidth(
  storage: Pick<Storage, "setItem"> | undefined,
  width: number,
): void {
  if (!storage || parseViewerWorkspaceWidth(String(width)) === undefined) {
    return;
  }
  try {
    storage.setItem(
      VIEWER_WORKSPACE_WIDTH_STORAGE_KEY,
      String(width),
    );
  } catch {
    // A blocked storage area must not make the viewer unusable.
  }
}

export function installViewerWorkspace(
  root: HTMLElement,
  scrollOwner: HTMLElement,
  options: ViewerWorkspaceInstallOptions = {},
): ViewerWorkspaceController {
  const tabs = [
    ...root.querySelectorAll<HTMLButtonElement>(
      '[role="tab"][data-workspace-view]',
    ),
  ];
  const panels = [
    ...root.querySelectorAll<HTMLElement>(
      '[role="tabpanel"][data-workspace-panel]',
    ),
  ];
  const analyzeTabs = [
    ...root.querySelectorAll<HTMLButtonElement>(
      '[role="tab"][data-analyze-view]',
    ),
  ];
  const analyzePanels = [
    ...root.querySelectorAll<HTMLElement>(
      '[role="tabpanel"][data-analyze-panel]',
    ),
  ];
  const tabsByView = new Map(
    VIEWER_WORKSPACE_VIEWS.map((view) => [
      view,
      requiredViewElement(tabs, "workspaceView", view),
    ]),
  );
  const panelsByView = new Map(
    VIEWER_WORKSPACE_VIEWS.map((view) => [
      view,
      requiredViewElement(panels, "workspacePanel", view),
    ]),
  );
  const analyzeTabsByView = new Map(
    VIEWER_ANALYZE_VIEWS.map((view) => [
      view,
      requiredAnalyzeElement(analyzeTabs, "analyzeView", view),
    ]),
  );
  const analyzePanelsByView = new Map(
    VIEWER_ANALYZE_VIEWS.map((view) => [
      view,
      requiredAnalyzeElement(analyzePanels, "analyzePanel", view),
    ]),
  );
  const detailsPanel = root.querySelector<HTMLElement>(
    '[data-workspace-context="details"]',
  );
  if (!detailsPanel) {
    throw new Error("Missing contextual viewer details panel.");
  }
  const detailsBack = root.querySelector<HTMLButtonElement>(
    "[data-workspace-details-back]",
  );
  if (!detailsBack) {
    throw new Error("Missing contextual viewer details back action.");
  }
  const toggle = root.querySelector<HTMLButtonElement>(
    "[data-workspace-toggle]",
  );
  if (!toggle) {
    throw new Error("Missing viewer workspace collapse toggle.");
  }
  const resizer = root.querySelector<HTMLElement>(
    "[data-workspace-resizer]",
  );
  if (!resizer) {
    throw new Error("Missing viewer workspace resizer.");
  }

  const hostWindow =
    options.window ?? root.ownerDocument.defaultView ?? window;
  const storage = options.storage ?? (() => {
    try {
      return hostWindow.localStorage;
    } catch {
      return undefined;
    }
  })();
  const cleanups: (() => void)[] = [];
  type ScrollKey =
    | "explore"
    | `analyze:${ViewerAnalyzeView}`
    | "details";
  const scrollTopByView = new Map<ScrollKey, number>([
    ["explore", 0],
    ...VIEWER_ANALYZE_VIEWS.map(
      (view): readonly [ScrollKey, number] => [`analyze:${view}`, 0],
    ),
    ["details", 0],
  ]);
  let compact =
    hostWindow.innerWidth < VIEWER_WORKSPACE_COMPACT_BREAKPOINT;
  let state = initialViewerWorkspaceState(compact);
  let preferredWidth = readPreferredWidth(storage);
  let activePointerCleanup: (() => void) | undefined;
  const scrollKey = (candidate: ViewerWorkspaceState): ScrollKey =>
    candidate.detailsOpen
      ? "details"
      : candidate.activeView === "explore"
        ? "explore"
        : `analyze:${candidate.activeAnalyzeView}`;
  const notifyState = (): void =>
    options.onStateChange?.(
      Object.freeze({
        activeView: state.activeView,
        activeAnalyzeView: state.activeAnalyzeView,
        detailsOpen: state.detailsOpen,
        sheetState: state.sheetState,
      }),
    );

  const renderWidth = (): void => {
    const maximum = viewerWorkspaceMaximumWidth(hostWindow.innerWidth);
    const runtimeWidth = viewerWorkspaceRuntimeWidth(
      preferredWidth,
      hostWindow.innerWidth,
    );
    root.style.setProperty(
      "--viewer-workspace-width",
      `${runtimeWidth}px`,
    );
    resizer.setAttribute(
      "aria-valuemin",
      String(VIEWER_WORKSPACE_MIN_WIDTH),
    );
    resizer.setAttribute("aria-valuemax", String(maximum));
    resizer.setAttribute(
      "aria-valuenow",
      String(Math.round(runtimeWidth)),
    );
    resizer.setAttribute("aria-disabled", String(compact));
  };

  const renderSheetState = (): void => {
    root.dataset["sheetState"] = state.sheetState;
    root.dataset["collapsed"] = String(
      state.sheetState === "collapsed",
    );
    root.dataset["compact"] = String(compact);
    scrollOwner.hidden = state.sheetState === "collapsed";

    const contentVisible = state.sheetState !== "collapsed";
    toggle.setAttribute("aria-expanded", String(contentVisible));
    const action =
      state.sheetState === "expanded"
        ? "Collapse viewer tools"
        : state.sheetState === "peek"
          ? "Expand viewer tools fully"
          : "Show viewer tools";
    toggle.setAttribute("aria-label", action);
    toggle.title = action;
    const icon = toggle.querySelector<HTMLElement>(
      "[aria-hidden='true']",
    );
    if (icon) {
      icon.textContent =
        state.sheetState === "expanded" ? "−" : "+";
    }
  };

  const renderView = (): void => {
    root.dataset["activeView"] = state.activeView;
    root.dataset["activeAnalyzeView"] = state.activeAnalyzeView;
    root.dataset["detailsOpen"] = String(state.detailsOpen);
    for (const candidate of VIEWER_WORKSPACE_VIEWS) {
      const active = candidate === state.activeView;
      const tab = tabsByView.get(candidate)!;
      const panel = panelsByView.get(candidate)!;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.hidden = !active || state.detailsOpen;
    }
    for (const candidate of VIEWER_ANALYZE_VIEWS) {
      const selected = candidate === state.activeAnalyzeView;
      const visible =
        selected && state.activeView === "analyze" && !state.detailsOpen;
      const tab = analyzeTabsByView.get(candidate)!;
      const panel = analyzePanelsByView.get(candidate)!;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panel.hidden = !visible;
    }
    detailsPanel.hidden = !state.detailsOpen;
  };

  const transition = (next: ViewerWorkspaceState): boolean => {
    const previousKey = scrollKey(state);
    const nextKey = scrollKey(next);
    const changed = previousKey !== nextKey;
    if (changed) scrollTopByView.set(previousKey, scrollOwner.scrollTop);
    state = next;
    renderView();
    renderSheetState();
    if (changed) scrollOwner.scrollTop = scrollTopByView.get(nextKey) ?? 0;
    return changed;
  };

  const setSheetState = (
    sheetState: ViewerWorkspaceSheetState,
  ): void => {
    state = { ...state, sheetState };
    renderSheetState();
    if (
      sheetState === "collapsed" &&
      root.contains(root.ownerDocument.activeElement)
    ) {
      toggle.focus();
    }
    notifyState();
  };

  const show = (
    view: ViewerWorkspaceView,
    showOptions: ViewerWorkspaceShowOptions = {},
  ): void => {
    transition(
      workspaceStateForShow(state, view, {
        compact,
        intent: showOptions.intent,
      }),
    );
    const passive = showOptions.intent === "passive";
    if (showOptions.focus && !passive) {
      tabsByView.get(view)!.focus();
    }
    notifyState();
  };

  const showAnalyze = (
    view: ViewerAnalyzeView,
    showOptions: ViewerWorkspaceShowOptions = {},
  ): void => {
    transition(
      workspaceStateForAnalyze(state, view, {
        compact,
        intent: showOptions.intent,
      }),
    );
    const passive = showOptions.intent === "passive";
    if (showOptions.focus && !passive) {
      analyzeTabsByView.get(view)!.focus();
    }
    notifyState();
  };

  const showDetails = (
    showOptions: ViewerWorkspaceShowOptions = {},
  ): void => {
    transition(
      workspaceStateForShow(state, "details", {
        compact,
        intent: showOptions.intent,
      }),
    );
    const passive = showOptions.intent === "passive";
    if (showOptions.focus && !passive) detailsPanel.focus();
    notifyState();
  };

  const closeDetails = (
    closeOptions: { readonly focusTab?: boolean } = {},
  ): void => {
    if (!state.detailsOpen) return;
    transition({ ...state, detailsOpen: false });
    if (closeOptions.focusTab) {
      if (state.activeView === "analyze") {
        analyzeTabsByView.get(state.activeAnalyzeView)!.focus();
      } else {
        tabsByView.get(state.activeView)!.focus();
      }
    }
    notifyState();
  };

  const setPreferredWidth = (
    requestedWidth: number,
    persist: boolean,
  ): void => {
    if (!Number.isFinite(requestedWidth)) return;
    preferredWidth = clampViewerWorkspaceWidth(requestedWidth);
    renderWidth();
    if (persist) persistPreferredWidth(storage, preferredWidth);
  };

  for (const view of VIEWER_WORKSPACE_VIEWS) {
    const tab = tabsByView.get(view)!;
    const onClick = (): void =>
      show(view, { intent: "explicit" });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isNavigationKey(event.key)) return;
      event.preventDefault();
      show(workspaceViewForNavigation(view, event.key), {
        intent: "explicit",
        focus: true,
      });
    };
    tab.addEventListener("click", onClick);
    tab.addEventListener("keydown", onKeyDown);
    cleanups.push(() => {
      tab.removeEventListener("click", onClick);
      tab.removeEventListener("keydown", onKeyDown);
    });
  }

  for (const view of VIEWER_ANALYZE_VIEWS) {
    const tab = analyzeTabsByView.get(view)!;
    const onClick = (): void =>
      showAnalyze(view, { intent: "explicit" });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isNavigationKey(event.key)) return;
      event.preventDefault();
      showAnalyze(analyzeViewForNavigation(view, event.key), {
        intent: "explicit",
        focus: true,
      });
    };
    tab.addEventListener("click", onClick);
    tab.addEventListener("keydown", onKeyDown);
    cleanups.push(() => {
      tab.removeEventListener("click", onClick);
      tab.removeEventListener("keydown", onKeyDown);
    });
  }

  const onDetailsBack = (): void => closeDetails({ focusTab: true });
  detailsBack.addEventListener("click", onDetailsBack);
  cleanups.push(() =>
    detailsBack.removeEventListener("click", onDetailsBack),
  );

  const onToggle = (): void => {
    if (state.sheetState === "collapsed") {
      setSheetState(compact ? "peek" : "expanded");
    } else if (state.sheetState === "peek") {
      setSheetState("expanded");
    } else {
      setSheetState("collapsed");
    }
  };
  toggle.addEventListener("click", onToggle);
  cleanups.push(() => toggle.removeEventListener("click", onToggle));

  const stopPointerResize = (): void => {
    activePointerCleanup?.();
    activePointerCleanup = undefined;
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (compact || (event.button !== 0 && event.button !== -1)) return;
    event.preventDefault();
    stopPointerResize();
    const startX = event.clientX;
    const startWidth = viewerWorkspaceRuntimeWidth(
      preferredWidth,
      hostWindow.innerWidth,
    );
    let moved = false;
    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return;
      moved = true;
      setPreferredWidth(
        startWidth + startX - moveEvent.clientX,
        true,
      );
    };
    const onPointerEnd = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== event.pointerId) return;
      if (!moved) renderWidth();
      stopPointerResize();
    };
    hostWindow.addEventListener("pointermove", onPointerMove);
    hostWindow.addEventListener("pointerup", onPointerEnd);
    hostWindow.addEventListener("pointercancel", onPointerEnd);
    activePointerCleanup = () => {
      hostWindow.removeEventListener("pointermove", onPointerMove);
      hostWindow.removeEventListener("pointerup", onPointerEnd);
      hostWindow.removeEventListener("pointercancel", onPointerEnd);
    };
    resizer.setPointerCapture?.(event.pointerId);
  };
  const onResizerKeyDown = (event: KeyboardEvent): void => {
    if (
      compact ||
      !isNavigationKey(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const runtimeWidth = viewerWorkspaceRuntimeWidth(
      preferredWidth,
      hostWindow.innerWidth,
    );
    const maximum = viewerWorkspaceMaximumWidth(hostWindow.innerWidth);
    if (event.key === "Home") {
      setPreferredWidth(VIEWER_WORKSPACE_MIN_WIDTH, true);
    } else if (event.key === "End") {
      setPreferredWidth(maximum, true);
    } else {
      const direction = event.key === "ArrowLeft" ? 1 : -1;
      setPreferredWidth(
        Math.min(
          maximum,
          runtimeWidth + direction * VIEWER_WORKSPACE_RESIZE_STEP,
        ),
        true,
      );
    }
  };
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.tabIndex = 0;
  resizer.addEventListener("pointerdown", onPointerDown);
  resizer.addEventListener("keydown", onResizerKeyDown);
  cleanups.push(() => {
    resizer.removeEventListener("pointerdown", onPointerDown);
    resizer.removeEventListener("keydown", onResizerKeyDown);
    stopPointerResize();
  });

  const onWindowResize = (): void => {
    const wasCompact = compact;
    compact =
      hostWindow.innerWidth < VIEWER_WORKSPACE_COMPACT_BREAKPOINT;
    if (wasCompact && !compact) {
      state = { ...state, sheetState: "expanded" };
    } else if (!wasCompact && compact) {
      state = {
        ...state,
        sheetState:
          state.sheetState === "collapsed" ? "collapsed" : "peek",
      };
    }
    renderSheetState();
    renderWidth();
    notifyState();
  };
  hostWindow.addEventListener("resize", onWindowResize);
  cleanups.push(() =>
    hostWindow.removeEventListener("resize", onWindowResize),
  );

  renderView();
  renderSheetState();
  renderWidth();
  notifyState();

  return {
    get activeView() {
      return state.activeView;
    },
    get sheetState() {
      return state.sheetState;
    },
    get activeAnalyzeView() {
      return state.activeAnalyzeView;
    },
    get detailsOpen() {
      return state.detailsOpen;
    },
    get collapsed() {
      return state.sheetState === "collapsed";
    },
    get compact() {
      return compact;
    },
    show,
    showAnalyze,
    showDetails,
    closeDetails,
    setSheetState,
    setCollapsed: (collapsed: boolean) =>
      setSheetState(collapsed ? "collapsed" : "expanded"),
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
