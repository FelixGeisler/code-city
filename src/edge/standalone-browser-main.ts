import { createCityPresenter, type CityPresenter } from "./city-presenter";
import {
  createFetchSessionTransport,
  createStandaloneBrowserController,
  type BrowserFailedFile,
  type StandaloneBrowserView,
} from "./standalone-browser-controller";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error("Code City standalone shell is incomplete");
  return element;
}

const form = requiredElement<HTMLFormElement>("form");
const repository = requiredElement<HTMLInputElement>("input[name=repository]");
const exclusions = requiredElement<HTMLTextAreaElement>("textarea[name=additional-exclusions]");
const feedback = requiredElement<HTMLElement>("[data-feedback]");
const status = requiredElement<HTMLElement>("[data-status]");
const commit = requiredElement<HTMLOutputElement>("[data-commit]");
const failed = requiredElement<HTMLElement>("[data-failed]");
const failedRows = requiredElement<HTMLUListElement>("[data-failed-rows]");
const actions = requiredElement<HTMLElement>("[data-actions]");
const city = requiredElement<HTMLElement>("[data-city]");
const cityReset = requiredElement<HTMLButtonElement>("[data-city-reset]");

let presenter: CityPresenter<number> | undefined;

function clearCity(): void {
  presenter?.dispose();
  presenter = undefined;
  city.replaceChildren();
  city.hidden = true;
  cityReset.hidden = true;
}

function replaceStatus(message: string, action?: Readonly<{ label: string; run: () => void }>): void {
  const text = document.createElement("p");
  text.setAttribute("role", "status");
  text.textContent = message;
  if (!action) {
    status.replaceChildren(text);
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action.label;
  button.addEventListener("click", action.run, { once: true });
  status.replaceChildren(text, button);
}

function renderFailures(rows: readonly BrowserFailedFile[]): void {
  if (rows.length === 0) {
    failedRows.replaceChildren();
    failed.hidden = true;
    return;
  }
  const items = rows.map(({ canonicalPath, category }) => {
    const item = document.createElement("li");
    const path = document.createElement("bdi");
    path.textContent = canonicalPath;
    const detail = document.createElement("span");
    detail.textContent = category;
    item.append(path, detail);
    return item;
  });
  failedRows.replaceChildren(...items);
  failed.hidden = false;
}

function renderDiscard(discard: () => void): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Discard current analysis";
  button.addEventListener("click", () => {
    button.disabled = true;
    discard();
  }, { once: true });
  actions.replaceChildren(button);
}

function renderCity(model: Parameters<StandaloneBrowserView["succeeded"]>[0]): void {
  clearCity();
  city.hidden = false;
  cityReset.hidden = false;
  const next = createCityPresenter<number>({
    host: city,
    resetControl: cityReset,
    isEligible: () => true,
    failed: () => {
      clearCity();
      replaceStatus("Presentation failed (M1-PRES-1)");
    },
  });
  const staged = next.stage(1, model.geometry, model.presentation, {
    hoverIndex() {},
    activationIndex() {},
    selectionAction() {},
    districtProjection() {},
  });
  if (staged.kind !== "staged") {
    next.dispose();
    replaceStatus("Presentation failed (M1-PRES-1)");
    return;
  }
  const committed = next.commit(staged.token);
  if (committed.kind !== "committed") {
    next.dispose();
    replaceStatus("Presentation failed (M1-PRES-1)");
    return;
  }
  city.replaceChildren(staged.canvas as HTMLCanvasElement);
  presenter = next;
}

const view: StandaloneBrowserView = Object.freeze({
  clear() {
    feedback.textContent = "";
    status.replaceChildren();
    commit.textContent = "";
    renderFailures([]);
    actions.replaceChildren();
    clearCity();
  },
  working(cancel) {
    replaceStatus("Working", { label: "Cancel", run: cancel });
  },
  invalid() {
    feedback.textContent = "Invalid input";
  },
  capacity() {
    replaceStatus("Code City capacity is unavailable.");
  },
  lost() {
    replaceStatus("Provider/resolution failure");
  },
  revision(value) {
    commit.textContent = value;
  },
  failed(category, code, revision) {
    clearCity();
    renderFailures([]);
    actions.replaceChildren();
    commit.textContent = revision ?? "";
    replaceStatus(code ? `${category} (${code})` : category);
  },
  cancelled() {
    clearCity();
    renderFailures([]);
    actions.replaceChildren();
    commit.textContent = "";
    replaceStatus("Cancelled");
  },
  succeeded(model, failures, revision, discard) {
    status.replaceChildren();
    feedback.textContent = "";
    commit.textContent = revision;
    renderFailures(failures);
    renderCity(model);
    renderDiscard(discard);
  },
  allFilesFailed(failures, revision, discard) {
    status.replaceChildren();
    feedback.textContent = "";
    commit.textContent = revision;
    clearCity();
    renderFailures(failures);
    renderDiscard(discard);
  },
});

const controller = createStandaloneBrowserController(createFetchSessionTransport(), view);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  controller.submit(repository.value, exclusions.value);
});
window.addEventListener("pagehide", () => controller.dispose(), { once: true });
controller.start();
