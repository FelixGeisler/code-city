import { automaticRule, manuallyExcluded, type RecordedExclusionPolicy } from "../domain/exclusion-policy";
import { compareUnsignedUtf8 } from "../domain/source-admission";

/** Native bounded DOM only; callbacks from replaced pages/attempts have no authority. */
export function createAutomaticExclusionsView(root: HTMLElement) {
  let policy: RecordedExclusionPolicy | undefined;
  let included = new Set<string>();
  let page = 0, epoch = 0;
  let complete = false;
  let manual: readonly string[] = [];
  const render = (): void => {
    const owner = ++epoch;
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = !policy ? "Detected directories appear after explicit Analyze." : complete
      ? "Directory discovery complete. Checkbox edits apply on the next Analyze only."
      : "Directory discovery incomplete. Available detections remain editable; edits apply on the next Analyze only.";
    const list = document.createElement("ul");
    const rows = policy?.detected ?? [];
    page = Math.min(page, Math.max(0, Math.ceil(rows.length / 32) - 1));
    for (const [path, ruleId] of rows.slice(page * 32, (page + 1) * 32)) {
      const row = document.createElement("li"), label = document.createElement("label"), box = document.createElement("input");
      box.type = "checkbox"; box.checked = !included.has(path);
      box.setAttribute("aria-label", `Automatic exclusion: ${path}`);
      box.addEventListener("change", () => {
        if (owner !== epoch) return;
        if (box.checked) included.delete(path); else included.add(path);
      });
      const name = document.createElement("bdi"); name.dir = "auto"; name.textContent = path;
      const reason = document.createElement("span");
      const rule = automaticRule(path);
      reason.textContent = ` — ${rule?.id === ruleId ? rule.reason : "Unknown convention"}${manuallyExcluded(path, manual) ? "; manual exclusion wins even if unchecked" : ""}`;
      label.append(box, name, reason); row.append(label); list.append(row);
    }
    const navigation = document.createElement("div");
    for (const [label, delta] of [["Previous detected paths", -1], ["Next detected paths", 1]] as const) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.disabled = delta < 0 ? page === 0 : (page + 1) * 32 >= rows.length;
      button.addEventListener("click", () => { if (owner !== epoch || button.disabled) return; page += delta; render(); });
      navigation.append(button);
    }
    const count = document.createElement("span"); count.textContent = `${rows.length ? page * 32 + 1 : 0}–${Math.min((page + 1) * 32, rows.length)} of ${rows.length} detected paths`;
    navigation.append(count); root.replaceChildren(status, list, navigation);
  };
  render();
  return {
    included: (): readonly string[] => Object.freeze([...included].sort(compareUnsignedUtf8)),
    reset() { policy = undefined; included.clear(); page = 0; complete = false; render(); },
    begin() { policy = undefined; page = 0; complete = false; render(); },
    report(value: RecordedExclusionPolicy, done: boolean) { policy = value; manual = value.manual; complete = done; render(); },
    restore(value: RecordedExclusionPolicy) { included = new Set(value.included); policy = value; manual = value.manual; complete = true; page = 0; render(); },
    manual(value: readonly string[]) { manual = value; render(); },
  };
}
