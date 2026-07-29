export const VIEWER_WORKSPACE_VIEWS = [
  "find",
  "routes",
  "inspect",
  "legend",
] as const;

export type ViewerWorkspaceView =
  (typeof VIEWER_WORKSPACE_VIEWS)[number];

export type ViewerWorkspaceNavigationKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End";

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

export interface ViewerWorkspaceController {
  readonly activeView: ViewerWorkspaceView;
  readonly collapsed: boolean;
  show: (
    view: ViewerWorkspaceView,
    options?: { readonly focusTab?: boolean },
  ) => void;
  setCollapsed: (collapsed: boolean) => void;
  dispose: () => void;
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

export function installViewerWorkspace(
  root: HTMLElement,
  scrollOwner: HTMLElement,
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
  const cleanups: (() => void)[] = [];
  let activeView: ViewerWorkspaceView = "find";
  let collapsed = false;

  const setCollapsed = (next: boolean): void => {
    collapsed = next;
    root.dataset["collapsed"] = String(next);
    toggle.setAttribute("aria-expanded", String(!next));
    toggle.setAttribute(
      "aria-label",
      next ? "Expand viewer tools" : "Collapse viewer tools",
    );
    toggle.title = next ? "Expand viewer tools" : "Collapse viewer tools";
    const icon = toggle.querySelector<HTMLElement>("[aria-hidden='true']");
    if (icon) icon.textContent = next ? "+" : "−";
    scrollOwner.hidden = next;
    if (next && root.contains(document.activeElement)) {
      toggle.focus();
    }
  };

  const show = (
    view: ViewerWorkspaceView,
    options: { readonly focusTab?: boolean } = {},
  ): void => {
    const wasCollapsed = collapsed;
    setCollapsed(false);
    const changed = view !== activeView;
    activeView = view;
    root.dataset["activeView"] = view;
    for (const candidate of VIEWER_WORKSPACE_VIEWS) {
      const selected = candidate === view;
      const tab = tabsByView.get(candidate)!;
      const panel = panelsByView.get(candidate)!;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
    }
    if (changed) scrollOwner.scrollTop = 0;
    if (options.focusTab && (changed || wasCollapsed)) {
      tabsByView.get(view)!.focus();
    }
  };

  for (const view of VIEWER_WORKSPACE_VIEWS) {
    const tab = tabsByView.get(view)!;
    const onClick = (): void => show(view);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isNavigationKey(event.key)) return;
      event.preventDefault();
      show(workspaceViewForNavigation(view, event.key), {
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

  const onToggle = (): void => setCollapsed(!collapsed);
  toggle.addEventListener("click", onToggle);
  cleanups.push(() => toggle.removeEventListener("click", onToggle));

  activeView = "find";
  root.dataset["activeView"] = activeView;
  for (const candidate of VIEWER_WORKSPACE_VIEWS) {
    const selected = candidate === activeView;
    const tab = tabsByView.get(candidate)!;
    const panel = panelsByView.get(candidate)!;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
  setCollapsed(false);
  return {
    get activeView() {
      return activeView;
    },
    get collapsed() {
      return collapsed;
    },
    show,
    setCollapsed,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
