import { manuallyExcluded, type RecordedExclusionPolicy } from "../domain/exclusion-policy";
import { compareUnsignedUtf8, parseAdditionalExclusions } from "../domain/source-admission";

/** One visible list; automatic rows are never silently promoted to manual rules. */
export function createExclusionsEditor(input: HTMLTextAreaElement) {
  let manual = new Set<string>(), included = new Set<string>(), known = new Set<string>();
  let presented = new Set<string>();
  let renderedText = input.value;
  const sorted = (paths: Iterable<string>): string[] => [...paths].sort(compareUnsignedUtf8);
  const read = (): boolean => {
    const paths = parseAdditionalExclusions(input.value);
    if (!paths) return false; // Keep invalid/in-progress text exactly as entered.
    const visible = new Set(paths);
    manual = new Set([...manual].filter(path => visible.has(path)));
    for (const path of presented) {
      if (known.has(path) && !visible.has(path)) included.add(path);
    }
    for (const path of visible) {
      if (presented.has(path)) continue;
      if (known.has(path)) included.delete(path);
      else manual.add(path);
    }
    presented = visible;
    return true;
  };
  const render = (): void => {
    const paths = new Set(manual);
    for (const path of known) {
      if (!included.has(path) || manuallyExcluded(path, [...manual])) paths.add(path);
    }
    const text = sorted(paths).join("\n");
    if (input.value !== text) input.value = text;
    renderedText = text;
    presented = paths;
  };
  input.addEventListener("input", read);
  input.addEventListener("blur", () => {
    if (input.value === renderedText && read()) render();
  });
  return {
    settings() {
      return { manualText: read() ? sorted(manual).join("\n") : input.value, included: sorted(included) };
    },
    // A submit already read the editor. Reports describe that applied snapshot,
    // but must merge against our *current* settings, including later user edits.
    begin() { renderedText = input.value; },
    report(policy: RecordedExclusionPolicy, complete: boolean) {
      const valid = read();
      const next = policy.detected.map(([path]) => path);
      known = complete ? new Set(next) : new Set([...known, ...next]);
      // Never overwrite pending text or move a focused editor's caret. A later
      // explicit submit will reconcile it; unseen new roots are not removals.
      if (valid && input.value === renderedText && document.activeElement !== input) render();
    },
    reset() {
      const valid = read();
      if (!valid) {
        // A source switch still drops old automatic-only lines, but preserves
        // every other character of an unfinished edit (including line endings).
        input.value = input.value.replace(/([^\r\n]*)(\r\n|\r|\n|$)/g, (row, path: string) =>
          known.has(path) && !manual.has(path) ? "" : row);
        presented = new Set([...presented].filter(path => !known.has(path) || manual.has(path)));
      }
      known.clear(); included.clear();
      if (valid) render();
    },
    restore(policy: RecordedExclusionPolicy) {
      manual = new Set(policy.manual); included = new Set(policy.included);
      known = new Set(policy.detected.map(([path]) => path));
      render();
    },
  };
}
