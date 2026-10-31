import {
  createStandaloneBrowserController,
  type BrowserFailedFile,
  type StandaloneBrowserView,
} from "./standalone-browser-controller";
import { listSavedInvestigations, savedUrl } from "./browser-saved-investigations";
import { validSavedId, type SavedRecord } from "../application/saved-investigation";
import { createBrowserWorkerTransport } from "./browser-worker-transport";
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
const failed = requiredElement<HTMLDetailsElement>("[data-failed]");
const failedSummary = requiredElement<HTMLElement>("[data-failed-summary]");
const failedRows = requiredElement<HTMLUListElement>("[data-failed-rows]");
const presentationRoot = requiredElement<HTMLElement>("[data-presentation]");
const investigation = requiredElement<HTMLElement>("[data-investigation]");
const repositoryName = requiredElement<HTMLElement>("[data-repository]");
const investigationControls = requiredElement<HTMLElement>("[data-investigation-controls]");
const changeRepository = requiredElement<HTMLButtonElement>("[data-change-repository]");
const saveButton = requiredElement<HTMLButtonElement>("[data-save]");
const saveStatus = requiredElement<HTMLElement>("[data-save-status]");
const savedPicker = requiredElement<HTMLDialogElement>("[data-saved-picker]");
const savedProjects = requiredElement<HTMLElement>("[data-saved-projects]");
const savedMessage = requiredElement<HTMLElement>("[data-saved-message]");
let savedRecord: SavedRecord | undefined;
let uiEpoch = 0, pickerEpoch = 0;
let capturedRepositoryUrl: string | undefined;
let hasAttempt = false;
let isWorking = false;
let workingProgressLabel: HTMLLabelElement | undefined;
let workingProgress: HTMLProgressElement | undefined;

function showAttempt(working: boolean): void {
  if (capturedRepositoryUrl === undefined) return;
  hasAttempt = true;
  isWorking = working;
  form.hidden = true;
  investigation.hidden = false;
  investigationControls.hidden = working;
  changeRepository.disabled = working;
  changeRepository.textContent = "Change repository";
  changeRepository.setAttribute("aria-expanded", "false");
  repositoryName.textContent = capturedRepositoryUrl;
}

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
  status.replaceChildren(progressLabel, button);
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
  failed.open = false;
  failedSummary.textContent = rows.length === 0 ? "" : `${rows.length} ${rows.length === 1 ? "file" : "files"} not analyzed`;
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


const presentation = createStandalonePresentationCoordinator({
  documentTarget: document,
  root: presentationRoot,
  inspect: query => controller.inspect(query),
  failed() {
    feedback.textContent = "";
    renderFailures([]);
    showAttempt(false);
    replaceStatus("Presentation failed (M1-PRES-1)");
  },
});

const view: StandaloneBrowserView = Object.freeze({
  clear() {
    uiEpoch++;
    savedRecord = undefined;
    saveButton.hidden = true;
    saveButton.disabled = false;
    saveButton.textContent = "Save";
    saveStatus.replaceChildren();
    hasAttempt = false;
    isWorking = false;
    form.hidden = false;
    investigation.hidden = true;
    repositoryName.textContent = "";
    changeRepository.textContent = "Change repository";
    changeRepository.setAttribute("aria-expanded", "false");
    feedback.textContent = "";
    workingProgressLabel = undefined;
    workingProgress = undefined;
    status.replaceChildren();
    commit.textContent = "";
    renderFailures([]);
    presentation.clear();
  },
  working(cancel) {
    showAttempt(true);
    replaceWorkingStatus(cancel);
  },
  progress(label, completed, total) {
    updateWorkingProgress(label, completed, total);
  },
  invalid() {
    feedback.textContent = "Invalid input";
  },
  capacity() {
    showAttempt(false);
    replaceStatus("Local analysis could not start.");
  },
  lost() {
    showAttempt(false);
    replaceStatus("Provider/resolution failure");
  },
  revision(value) {
    commit.textContent = value;
  },
  failed(category, code, revision) {
    showAttempt(false);
    presentation.clear();
    renderFailures([]);
    commit.textContent = revision ?? "";
    replaceStatus(code ? `${category} (${code})` : category);
  },
  cancelled() {
    showAttempt(false);
    presentation.clear();
    renderFailures([]);
    commit.textContent = "";
    replaceStatus("Cancelled");
  },
  succeeded(generation, model, failures, revision) {
    showAttempt(false);
    feedback.textContent = "";
    commit.textContent = revision;
    if (!presentation.publish(generation, model)) return;
    saveButton.hidden = false;
    try {
      renderFailures(failures);
      if (workingProgress) workingProgress.value = workingProgress.max;
      workingProgressLabel = undefined;
      workingProgress = undefined;
      status.replaceChildren();
    } catch {
      presentation.failCurrent();
    }
  },
  allFilesFailed(_generation, failures, revision) {
    showAttempt(false);
    replaceStatus("No files could be analyzed.");
    feedback.textContent = "";
    commit.textContent = revision;
    presentation.clear();
    renderFailures(failures);
    saveButton.hidden = false;
  },
});

function showSaved(record: SavedRecord): void {
  savedRecord = record;
  saveButton.textContent = "Copy link";
  const link = document.createElement("a");
  link.href = savedUrl(record.id);
  link.textContent = link.href;
  const time = document.createElement("span");
  time.textContent = `Saved ${record.savedAt} · `;
  saveStatus.replaceChildren(time, link);
  history.replaceState(null, "", `/saved/${record.id}`);
}
const controller = createStandaloneBrowserController(createBrowserWorkerTransport(undefined, (url, record, savedExclusions) => {
  capturedRepositoryUrl = url;
  repository.value = url;
  exclusions.value = savedExclusions.join("\n");  repositoryName.textContent = url;
  showSaved(record);
}), view);
const secureAnalysis = window.isSecureContext && globalThis.crypto?.subtle !== undefined;
function submitAnalysis(repositoryUrl: string, additionalExclusions: string): void {
  if (!secureAnalysis) { replaceStatus("Browser analysis requires HTTPS or localhost."); return; }
  history.replaceState(null, "", "/");
  capturedRepositoryUrl = repositoryUrl;
  controller.submit(repositoryUrl, additionalExclusions);
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAnalysis(repository.value, exclusions.value);
});
changeRepository.addEventListener("click", () => {
  if (!hasAttempt || isWorking) return;
  form.hidden = !form.hidden;
  changeRepository.textContent = form.hidden ? "Change repository" : "Close setup";
  changeRepository.setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) repository.focus();
});
saveButton.addEventListener("click", () => {
  if (savedRecord) {
    void navigator.clipboard?.writeText(savedUrl(savedRecord.id)).catch(() => {});
    return;
  }
  const epoch = uiEpoch;
  saveButton.disabled = true;
  saveStatus.textContent = "Saving investigation";
  void controller.save().then(record => { if (epoch === uiEpoch) showSaved(record); }, error => {
    if (epoch === uiEpoch) saveStatus.textContent = `${error instanceof Error ? error.message : "Save failed"}. The current investigation is unchanged.`;
  }).finally(() => { if (epoch === uiEpoch) saveButton.disabled = false; });
});
function openSaved(id: string): void {
  if (!secureAnalysis || !validSavedId(id)) { replaceStatus("Saved investigation unavailable"); return; }
  capturedRepositoryUrl = "Opening saved investigation";
  history.replaceState(null, "", `/saved/${id}`);
  controller.openSaved(id);
}
requiredElement<HTMLButtonElement>("[data-open-saved]").addEventListener("click", () => {
  const epoch = ++pickerEpoch;
  savedProjects.replaceChildren(); savedMessage.textContent = "Loading saved investigations"; savedPicker.showModal();
  void listSavedInvestigations().then(records => {
    if (epoch !== pickerEpoch || !savedPicker.open) return;
    savedMessage.textContent = records.length ? "" : "No saved investigations yet.";
    const groups = new Map<string, SavedRecord[]>();
    for (const record of records) { const key = record.repository.toLowerCase(); const group = groups.get(key) ?? []; group.push(record); groups.set(key, group); }
    for (const [name, records] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const group = document.createElement("details"); group.name = "saved-project"; group.open = groups.size === 1;
      const summary = document.createElement("summary"); const identity = document.createElement("bdi"); identity.dir = "auto"; identity.textContent = name;
      summary.append(identity, ` (${records.length})`); group.append(summary);
      const list = document.createElement("ul");
      for (const record of records) {
        const row = document.createElement("li"), button = document.createElement("button"); button.type = "button";
        const label = document.createElement("bdi"); label.dir = "auto"; label.textContent = `${record.ref} · ${record.revision.slice(0, 12)} · ${record.savedAt}`;
        button.append(label); button.addEventListener("click", () => { savedPicker.close(); openSaved(record.id); }); row.append(button); list.append(row);
      }
      group.append(list); savedProjects.append(group);
    }
  }, error => { if (epoch === pickerEpoch && savedPicker.open) savedMessage.textContent = error instanceof Error ? error.message : "Saved investigations unavailable"; });
});
requiredElement<HTMLButtonElement>("[data-close-saved]").addEventListener("click", () => savedPicker.close());
savedPicker.addEventListener("close", () => { pickerEpoch++; savedProjects.replaceChildren(); });
window.addEventListener("pagehide", () => {
  controller.dispose();
  presentation.dispose();
}, { once: true });
if (secureAnalysis) {
  controller.start();
  const saved = /^\/saved\/([A-Za-z0-9_-]{43})$/u.exec(location.pathname);
  if (saved) openSaved(saved[1]!);
}
else {
  replaceStatus("Browser analysis requires HTTPS or localhost.");
  requiredElement<HTMLButtonElement>('form button[type="submit"]').disabled = true;
}
