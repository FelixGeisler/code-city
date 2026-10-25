import {
  createFetchSessionTransport,
  createStandaloneBrowserController,
  type BrowserFailedFile,
  type StandaloneBrowserView,
} from "./standalone-browser-controller";
import { createStandalonePresentationCoordinator } from "./standalone-presentation-session";

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
const presentationRoot = requiredElement<HTMLElement>("[data-presentation]");
let workingProgressLabel: HTMLLabelElement | undefined;
let workingProgress: HTMLProgressElement | undefined;

function replaceStatus(message: string, action?: Readonly<{ label: string; run: () => void }>): void {
  workingProgressLabel = undefined;
  workingProgress = undefined;
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

function replaceWorkingStatus(cancel: () => void): void {
  const text = document.createElement("p");
  text.setAttribute("role", "status");
  text.textContent = "Analyzing repository";
  const progressLabel = document.createElement("label");
  progressLabel.setAttribute("data-analysis-progress", "");
  const progress = document.createElement("progress");
  progressLabel.append("Starting analysis", progress);
  workingProgressLabel = progressLabel;
  workingProgress = progress;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Cancel";
  button.addEventListener("click", cancel, { once: true });
  status.replaceChildren(text, progressLabel, button);
}

function updateWorkingProgress(label: string, completed?: number, total?: number): void {
  const progressLabel = workingProgressLabel;
  const progress = workingProgress;
  if (!progressLabel || !progress || !status.contains(progressLabel)) return;
  progressLabel.replaceChildren(label, progress);
  if (completed === undefined || total === undefined) {
    progress.removeAttribute("value");
    progress.removeAttribute("max");
    progress.removeAttribute("aria-valuenow");
    return;
  }
  progress.max = total;
  progress.value = completed;
  progress.removeAttribute("aria-valuenow");
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
    path.setAttribute("dir", "auto");
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

const presentation = createStandalonePresentationCoordinator({
  documentTarget: document,
  root: presentationRoot,
  failed() {
    feedback.textContent = "";
    renderFailures([]);
    actions.replaceChildren();
    replaceStatus("Presentation failed (M1-PRES-1)");
  },
});

const view: StandaloneBrowserView = Object.freeze({
  clear() {
    feedback.textContent = "";
    workingProgressLabel = undefined;
    workingProgress = undefined;
    status.replaceChildren();
    commit.textContent = "";
    renderFailures([]);
    actions.replaceChildren();
    presentation.clear();
  },
  working(cancel) {
    replaceWorkingStatus(cancel);
  },
  progress(label, completed, total) {
    updateWorkingProgress(label, completed, total);
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
    presentation.clear();
    renderFailures([]);
    actions.replaceChildren();
    commit.textContent = revision ?? "";
    replaceStatus(code ? `${category} (${code})` : category);
  },
  cancelled() {
    presentation.clear();
    renderFailures([]);
    actions.replaceChildren();
    commit.textContent = "";
    replaceStatus("Cancelled");
  },
  succeeded(generation, model, failures, revision, discard) {
    workingProgressLabel = undefined;
    workingProgress = undefined;
    status.replaceChildren();
    feedback.textContent = "";
    commit.textContent = revision;
    if (!presentation.publish(generation, model)) return;
    try {
      renderFailures(failures);
      renderDiscard(discard);
    } catch {
      presentation.failCurrent();
    }
  },
  allFilesFailed(_generation, failures, revision, discard) {
    workingProgressLabel = undefined;
    workingProgress = undefined;
    status.replaceChildren();
    feedback.textContent = "";
    commit.textContent = revision;
    presentation.clear();
    renderFailures(failures);
    renderDiscard(discard);
  },
});

const controller = createStandaloneBrowserController(createFetchSessionTransport(), view);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  controller.submit(repository.value, exclusions.value);
});
window.addEventListener("pagehide", () => {
  controller.dispose();
  presentation.dispose();
}, { once: true });
controller.start();
