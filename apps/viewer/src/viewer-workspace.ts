export const VIEWER_WORKSPACE_VIEWS = [
  "explore",
  "routes",
  "details",
  "overview",
  "metrics",
] as const;

export type ViewerWorkspaceView =
  (typeof VIEWER_WORKSPACE_VIEWS)[number];

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
  readonly sheetState: ViewerWorkspaceSheetState;
}

export interface ViewerWorkspaceShowOptions {
  readonly intent?: ViewerWorkspaceShowIntent;
  readonly focusTab?: boolean;
}

export interface ViewerWorkspaceController {
  readonly activeView: ViewerWorkspaceView;
  readonly sheetState: ViewerWorkspaceSheetState;
  readonly collapsed: boolean;
  readonly compact: boolean;
  show: (
    view: ViewerWorkspaceView,
    options?: ViewerWorkspaceShowOptions,
  ) => void;
  setSheetState: (state: ViewerWorkspaceSheetState) => void;
  /** Compatibility alias for integrations using the previous controller. */
  setCollapsed: (collapsed: boolean) => void;
  dispose: () => void;
}

export interface ViewerWorkspaceInstallOptions {
  readonly window?: Window;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

export function initialViewerWorkspaceState(
  compact: boolean,
): ViewerWorkspaceState {
  return {
    activeView: "overview",
    sheetState: compact ? "peek" : "expanded",
  };
}

export function workspaceStateForShow(
  current: ViewerWorkspaceState,
  view: ViewerWorkspaceView,
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

  return { activeView: view, sheetState };
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
  const scrollTopByView = new Map<ViewerWorkspaceView, number>(
    VIEWER_WORKSPACE_VIEWS.map((view) => [view, 0]),
  );
  let compact =
    hostWindow.innerWidth < VIEWER_WORKSPACE_COMPACT_BREAKPOINT;
  let state = initialViewerWorkspaceState(compact);
  let preferredWidth = readPreferredWidth(storage);
  let activePointerCleanup: (() => void) | undefined;

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
    for (const candidate of VIEWER_WORKSPACE_VIEWS) {
      const selected = candidate === state.activeView;
      const tab = tabsByView.get(candidate)!;
      const panel = panelsByView.get(candidate)!;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
    }
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
  };

  const show = (
    view: ViewerWorkspaceView,
    showOptions: ViewerWorkspaceShowOptions = {},
  ): void => {
    const previousView = state.activeView;
    const changed = view !== previousView;
    if (changed) {
      scrollTopByView.set(previousView, scrollOwner.scrollTop);
    }
    state = workspaceStateForShow(state, view, {
      compact,
      intent: showOptions.intent,
    });
    renderView();
    renderSheetState();
    if (changed) {
      scrollOwner.scrollTop = scrollTopByView.get(view) ?? 0;
    }

    const passive = showOptions.intent === "passive";
    if (showOptions.focusTab && !passive) {
      tabsByView.get(view)!.focus();
    }
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
        focusTab: true,
      });
    };
    tab.addEventListener("click", onClick);
    tab.addEventListener("keydown", onKeyDown);
    cleanups.push(() => {
      tab.removeEventListener("click", onClick);
      tab.removeEventListener("keydown", onKeyDown);
    });
  }

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
  };
  hostWindow.addEventListener("resize", onWindowResize);
  cleanups.push(() =>
    hostWindow.removeEventListener("resize", onWindowResize),
  );

  renderView();
  renderSheetState();
  renderWidth();

  return {
    get activeView() {
      return state.activeView;
    },
    get sheetState() {
      return state.sheetState;
    },
    get collapsed() {
      return state.sheetState === "collapsed";
    },
    get compact() {
      return compact;
    },
    show,
    setSheetState,
    setCollapsed: (collapsed: boolean) =>
      setSheetState(collapsed ? "collapsed" : "expanded"),
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
