import { AUTOMATIC_EXCLUSION_RULES } from "../domain/exclusion-policy";
import { createAutomaticExclusionsView } from "./automatic-exclusions-view";
import { parseAdditionalExclusions } from "../domain/source-admission";
import { validWorkingTreeName } from "../application/investigation-origin";
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
const inputKind = requiredElement<HTMLSelectElement>("select[name=input-kind]");
const localSetup = requiredElement<HTMLElement>("[data-local-setup]");
const githubSetup = requiredElement<HTMLElement>("[data-github-setup]");
const chooseFolder = requiredElement<HTMLButtonElement>("[data-choose-folder]");
const folderName = requiredElement<HTMLElement>("[data-folder-name]");
const folderStatus = requiredElement<HTMLElement>("[data-folder-status]");
const originLabel = requiredElement<HTMLElement>("[data-origin-label]");
let selectedFolder: { root: unknown; name: string } | undefined;
let folderPickerEpoch = 0;
const exclusions = requiredElement<HTMLTextAreaElement>("textarea[name=additional-exclusions]");
requiredElement<HTMLElement>("[data-automatic-rules]").textContent = `Automatic directory conventions: ${AUTOMATIC_EXCLUSION_RULES.map(rule => rule.path).join(", ")}.`;
const automaticExclusions = createAutomaticExclusionsView(requiredElement<HTMLElement>("[data-automatic-exclusions]"));
let sourceSettingsEpoch = 0, attemptSettingsEpoch = 0;
let retainRestoredFolderSettings = false;
const resetSourceSettings = (): void => { sourceSettingsEpoch++; retainRestoredFolderSettings = false; automaticExclusions.reset(); };
exclusions.addEventListener("input", () => { automaticExclusions.manual(parseAdditionalExclusions(exclusions.value) ?? []); });
repository.addEventListener("input", resetSourceSettings);
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
  changeRepository.textContent = "Change source";
  changeRepository.setAttribute("aria-expanded", "false");
  repositoryName.textContent = capturedRepositoryUrl;
}

function showEditableExclusions(): void {
  form.hidden = false;
  requiredElement<HTMLDetailsElement>("[data-exclusions]").open = true;
  changeRepository.textContent = "Close setup";
  changeRepository.setAttribute("aria-expanded", "true");
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
    changeRepository.textContent = "Change source";
    changeRepository.setAttribute("aria-expanded", "false");
    feedback.textContent = "";
    workingProgressLabel = undefined;
    workingProgress = undefined;
    status.replaceChildren();
    commit.textContent = "";
    renderFailures([]);
    presentation.clear();
  },
  exclusionPolicy(policy, complete) {
    if (sourceSettingsEpoch === attemptSettingsEpoch) automaticExclusions.report(policy, complete);
  },
  working(cancel) {
    attemptSettingsEpoch = sourceSettingsEpoch;
    automaticExclusions.begin();
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
  origin(value) {
    capturedRepositoryUrl = value.kind === "working-tree" ? value.name : value.repositoryUrl;
    repositoryName.textContent = capturedRepositoryUrl;
    originLabel.textContent = value.kind === "working-tree" ? "Working-tree capture" : "Commit";
  },
  revision(value) {
    commit.textContent = value;
  },
  failed(category, code, revision) {
    showAttempt(false);
    showEditableExclusions();
    presentation.clear();
    renderFailures([]);
    commit.textContent = revision ?? "";
    replaceStatus(code ? `${category} (${code})` : category);
  },
  cancelled() {
    showAttempt(false);
    showEditableExclusions();
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
    showEditableExclusions();
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
const controller = createStandaloneBrowserController(createBrowserWorkerTransport(undefined, (origin, record, savedPolicy) => {
  if (sourceSettingsEpoch !== attemptSettingsEpoch) return;
  view.origin?.(origin);
  inputKind.value = origin.kind;
  // Reopening a capture never reopens a filesystem capability.
  selectedFolder = undefined;
  folderName.textContent = "No folder selected";
  repository.value = origin.kind === "github" ? origin.repositoryUrl : "";
  localSetup.hidden = origin.kind !== "working-tree"; githubSetup.hidden = origin.kind !== "github";
  exclusions.value = savedPolicy.manual.join("\n");
  automaticExclusions.restore(savedPolicy);
  retainRestoredFolderSettings = origin.kind === "working-tree";
  showSaved(record);
}), view);
const secureAnalysis = window.isSecureContext && globalThis.crypto?.subtle !== undefined;
function submitAnalysis(repositoryUrl: string, additionalExclusions: string): void {
  if (!secureAnalysis) { replaceStatus("Browser analysis requires HTTPS or localhost."); return; }
  history.replaceState(null, "", "/");
  capturedRepositoryUrl = repositoryUrl; originLabel.textContent = "Commit";
  controller.submit(repositoryUrl, additionalExclusions, automaticExclusions.included());
}
inputKind.addEventListener("change", () => {
  resetSourceSettings();
  folderPickerEpoch++;
  localSetup.hidden = inputKind.value !== "working-tree";
  githubSetup.hidden = inputKind.value !== "github";
});
const directoryPicker = (window as Window & { showDirectoryPicker?: (options: { mode: "read" }) => Promise<{ name: string }> }).showDirectoryPicker;
chooseFolder.addEventListener("click", () => {
  if (!secureAnalysis || !directoryPicker) { folderStatus.textContent = "Read-only folder selection requires secure desktop Chromium. Public GitHub remains available."; return; }
  const epoch = ++folderPickerEpoch;
  // No file access or analysis on the UI thread: pass the native handle only on Analyze.
  void directoryPicker.call(window, { mode: "read" }).then(root => {
    if (epoch !== folderPickerEpoch) return;
    if (!validWorkingTreeName(root.name)) { folderStatus.textContent = "Folder name is not supported."; return; }
    if (retainRestoredFolderSettings) retainRestoredFolderSettings = false;
    else resetSourceSettings();
    selectedFolder = { root, name: root.name };
    folderName.textContent = root.name;
    folderStatus.textContent = "Folder selected. Choose Analyze to capture its current files; nothing has been uploaded.";
  }, error => {
    if (epoch !== folderPickerEpoch) return;
    folderStatus.textContent = error instanceof DOMException && error.name === "AbortError"
      ? "Folder selection cancelled. The current investigation is unchanged."
      : "Folder access denied or unavailable. The current investigation is unchanged.";
  });
});
if (!secureAnalysis || !directoryPicker) folderStatus.textContent = "Read-only folder selection requires secure desktop Chromium. Public GitHub remains available.";
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (inputKind.value === "github") { submitAnalysis(repository.value, exclusions.value); return; }
  if (!secureAnalysis || !directoryPicker) { folderStatus.textContent = "Read-only folder selection requires secure desktop Chromium."; return; }
  if (!selectedFolder) { folderStatus.textContent = "Choose a folder before Analyze."; return; }
  folderPickerEpoch++;
  history.replaceState(null, "", "/");
  capturedRepositoryUrl = selectedFolder.name; originLabel.textContent = "Working-tree capture";
  controller.submitWorkingTree(selectedFolder.root, selectedFolder.name, exclusions.value, automaticExclusions.included());
});
changeRepository.addEventListener("click", () => {
  if (!hasAttempt || isWorking) return;
  form.hidden = !form.hidden;
  changeRepository.textContent = form.hidden ? "Change source" : "Close setup";
  changeRepository.setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) (inputKind.value === "github" ? repository : chooseFolder).focus();
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
  originLabel.textContent = "Saved identity";
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
    for (const record of records) {
      const kind = record.kind ?? "github";
      const key = `${kind}:${kind === "github" ? record.repository.toLowerCase() : record.repository}`;
      const group = groups.get(key) ?? []; group.push(record); groups.set(key, group);
    }
    for (const [, records] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const name = records[0]!.repository;
      const local = records[0]!.kind === "working-tree";
      const group = document.createElement("details"); group.name = "saved-project"; group.open = groups.size === 1;
      const summary = document.createElement("summary"); const identity = document.createElement("bdi"); identity.dir = "auto"; identity.textContent = name;
      summary.append(identity, ` · ${local ? "Working tree" : "GitHub"} (${records.length})`); group.append(summary);
      const list = document.createElement("ul");
      for (const record of records) {
        const row = document.createElement("li"), button = document.createElement("button"); button.type = "button";
        const label = document.createElement("bdi"); label.dir = "auto"; label.textContent = `${local ? "Working-tree capture" : record.ref} · ${record.revision.slice(0, 12)} · ${record.savedAt}`;
        button.append(label); button.addEventListener("click", () => { savedPicker.close(); openSaved(record.id); }); row.append(button); list.append(row);
      }
      group.append(list); savedProjects.append(group);
    }
  }, error => { if (epoch === pickerEpoch && savedPicker.open) savedMessage.textContent = error instanceof Error ? error.message : "Saved investigations unavailable"; });
});
requiredElement<HTMLButtonElement>("[data-close-saved]").addEventListener("click", () => savedPicker.close());
savedPicker.addEventListener("close", () => { pickerEpoch++; savedProjects.replaceChildren(); });
window.addEventListener("pagehide", () => {
  folderPickerEpoch++; selectedFolder = undefined;
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
