import { CONTRIBUTION_PAGE_SIZE, UNIT_PAGE_SIZE, type InspectionQuery, type InspectionResult, type SourceLocation, type UnitRow } from "../application/unit-inspection";
export type InspectInvestigation = (query: InspectionQuery) => Promise<InspectionResult>;
type InspectionDocument = Pick<Document, "createElement">;
type SourcePage = Extract<InspectionResult, { type: "source" }>;
const point = (location: SourceLocation) => `${location.line}:${location.column}`;
const compare = (a: SourceLocation, b: SourceLocation) => a.line - b.line || a.column - b.column;
export function unitKindLabel(path: string, kind: string): string {
  if (kind === "arrow") return /\.cs$/iu.test(path) ? "Lambda expression" : "Arrow function";
  const label = ({ "top-level": "Top-level code", function: "Function", method: "Method", constructor: "Constructor", getter: "Getter", setter: "Setter", "static-block": "Static initializer" } as Record<string, unknown>)[kind];
  return typeof label === "string" ? label : "Executable unit";
}

/** One file owns its callbacks. Contribution scope is bound to the rendered source page. */
export function attachUnitInspection(documentTarget: InspectionDocument, inspector: HTMLElement, path: string, inspect: InspectInvestigation): () => void {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] => { const node = documentTarget.createElement(tag); node.textContent = text; return node; };
  const button = (label: string, action: () => void) => { const node = element("button", label); node.type = "button"; node.addEventListener("click", action); return node; };
  const slot = element("section"); slot.dataset.units = ""; slot.setAttribute("aria-live", "off"); slot.append(element("h3", "Executable units"));
  const message = element("p"); message.setAttribute("role", "status");
  const rows = element("ol"); rows.dataset.unitRows = "";
  const page = element("div"); page.dataset.unitPaging = ""; const range = element("span");
  let active = true, listEpoch = 0, sourceEpoch = 0, contributionEpoch = 0, offset = 0;
  let selected: UnitRow | undefined, shown: SourcePage | undefined, cursor: number | null = null, next: number | null = null;
  let sourcePending = false, contributionPending = false, contributionOffset = 0, contributionTotal = 0, wholeUnit = false, focusSource = false;
  const history: number[] = [];
  const previousUnits = button("Previous units", () => { offset = Math.max(0, offset - UNIT_PAGE_SIZE); void loadUnits(); });
  const nextUnits = button("Next units", () => { offset += UNIT_PAGE_SIZE; void loadUnits(); }); page.append(previousUnits, range, nextUnits);
  const dialog = element("dialog"); dialog.dataset.unitSource = ""; dialog.setAttribute("aria-labelledby", "unit-source-title");
  const heading = element("h2"); heading.id = "unit-source-title"; const identity = element("bdi", path); identity.dir = "auto"; heading.append(identity);
  const close = button("Close source", () => dialog.close()); close.dataset.closeSource = "";
  const titleBar = element("div"); titleBar.dataset.sourceTitle = ""; titleBar.append(heading, close);
  const details = element("p"); details.dataset.unitDetails = "";
  const sourceMessage = element("p"); sourceMessage.setAttribute("role", "status");
  const sourceRange = element("span"); sourceRange.dataset.sourceRange = "";
  const code = element("pre"); code.dataset.sourceCode = ""; code.tabIndex = 0; code.setAttribute("aria-label", "Read-only normalized source"); code.dir = "ltr";
  const sourcePaging = element("div"); sourcePaging.dataset.sourcePaging = "";
  const previousSource = button("Previous source", () => { if (!active || sourcePending || !history.length) return; cursor = history.pop()!; void loadSource(); });
  const nextSource = button("Next source", () => { if (!active || sourcePending || next === null || cursor === null) return; history.push(cursor); cursor = next; void loadSource(); });
  sourcePaging.append(previousSource, sourceRange, nextSource);
  const sourceSection = element("section"); sourceSection.append(sourceMessage, sourcePaging, code);
  const contributionSection = element("section"); contributionSection.dataset.ownedContributions = "";
  const scopeLabel = element("label", "Contributions for"); const scope = element("select"); scope.dataset.contributionScope = "";
  for (const [value, text] of [["shown", "Shown source"], ["unit", "Whole unit"]]) { const option = element("option", text); option.value = value!; scope.append(option); }
  scope.value = "shown"; scope.disabled = true; scopeLabel.append(scope);
  const contributionMessage = element("p"); contributionMessage.setAttribute("role", "status"); contributionMessage.dataset.contributionStatus = "";
  const contributions = element("ol"); contributions.dataset.contributionRows = "";
  const contributionPaging = element("div"); contributionPaging.dataset.contributionPaging = ""; const contributionRange = element("span");
  const previousContributions = button("Previous contributions", () => { if (!active || sourcePending || !shown || !dialog.open || contributionPending || contributionOffset === 0) return; contributionOffset = Math.max(0, contributionOffset - CONTRIBUTION_PAGE_SIZE); void loadContributions(); });
  const nextContributions = button("Next contributions", () => { if (!active || sourcePending || !shown || !dialog.open || contributionPending || contributionOffset + CONTRIBUTION_PAGE_SIZE >= contributionTotal) return; contributionOffset += CONTRIBUTION_PAGE_SIZE; void loadContributions(); });
  contributionPaging.append(previousContributions, contributionRange, nextContributions);
  contributionSection.append(element("h3", "Owned contributions"), scopeLabel, contributionMessage, contributionPaging, contributions);
  const body = element("div"); body.dataset.sourceBody = ""; body.append(sourceSection, contributionSection); dialog.append(titleBar, details, body);
  scope.addEventListener("change", () => { if (!active || sourcePending || !shown || !dialog.open || !["shown", "unit"].includes(scope.value)) return; wholeUnit = scope.value === "unit"; contributionOffset = 0; void loadContributions(); });
  dialog.addEventListener("keydown", event => event.stopPropagation());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    selected = undefined; shown = undefined; sourcePending = false; contributionPending = false; sourceEpoch++; contributionEpoch++;
    code.replaceChildren(); contributions.replaceChildren(); scope.disabled = true;
  });
  slot.append(message, rows, page, dialog); inspector.append(slot);

  async function loadUnits(): Promise<void> {
    if (!active) return;
    const epoch = ++listEpoch; message.textContent = "Loading units"; previousUnits.disabled = true; nextUnits.disabled = true;
    try {
      const result = await inspect({ type: "units", path, offset });
      if (!active || epoch !== listEpoch) return;
      if (result.type !== "units") throw new Error("Invalid unit list");
      const total = result.total; rows.replaceChildren(); rows.start = offset + 1;
      for (const unit of result.rows) {
        const row = element("li"), open = button("", () => openSource(unit)); open.dataset.unit = String(unit.id);
        const name = element("span", `${unitKindLabel(path, unit.kind)} · ${point(unit.start)}–${point(unit.end)}`);
        const value = element("span", `Complexity ${unit.complexity}`); value.dataset.unitComplexity = ""; open.append(name, value); row.append(open); rows.append(row);
      }
      message.textContent = total === 0 ? "No executable units." : "";
      range.textContent = total === 0 ? "" : `${offset + 1}–${Math.min(total, offset + UNIT_PAGE_SIZE)} of ${total}`;
      page.hidden = total <= UNIT_PAGE_SIZE; previousUnits.disabled = offset === 0; nextUnits.disabled = offset + UNIT_PAGE_SIZE >= total;
    } catch { if (active && epoch === listEpoch) { rows.replaceChildren(); page.hidden = true; message.textContent = "Unit inspection unavailable."; } }
  }
  function openSource(unit: UnitRow): void {
    if (!active) return;
    selected = unit; cursor = null; next = null; history.length = 0; wholeUnit = false; scope.value = "shown"; focusSource = false;
    details.textContent = `${unitKindLabel(path, unit.kind)} · Complexity ${unit.complexity} (whole unit) · ${point(unit.start)}–${point(unit.end)} (end exclusive)`;
    code.replaceChildren(); contributions.replaceChildren(); sourcePaging.hidden = true; dialog.showModal(); void loadSource();
  }
  async function loadSource(): Promise<void> {
    if (!active || !selected || !dialog.open) return;
    const epoch = ++sourceEpoch, unit = selected.id;
    shown = undefined; sourcePending = true; contributionEpoch++; contributionPending = false; contributionOffset = 0; contributionTotal = 0;
    code.replaceChildren(); contributions.replaceChildren(); sourceRange.textContent = ""; contributionPaging.hidden = true; scope.disabled = true;
    sourceMessage.textContent = "Loading source"; contributionMessage.textContent = "Waiting for source"; previousSource.disabled = true; nextSource.disabled = true;
    try {
      const result = await inspect({ type: "source", path, unit, cursor });
      if (!active || epoch !== sourceEpoch || selected?.id !== unit || !dialog.open) return;
      if (result.type !== "source") throw new Error("Invalid source");
      cursor = result.cursor; next = result.next; shown = result; sourcePending = false;
      let textOffset = 0, highlight = 0, syntaxIndex = 0, line = result.start.line;
      for (const text of result.text.split("\n")) {
        const row = element("span"); row.dataset.sourceLine = "";
        const number = element("span", String(line++)); number.dataset.sourceLineNumber = ""; number.setAttribute("aria-hidden", "true");
        const content = element("code"); const limit = textOffset + text.length; let position = textOffset, mark: HTMLElement | undefined;
        while (position < limit) {
          while (result.highlights[highlight] && result.highlights[highlight]!.end <= position) highlight++;
          const span = result.highlights[highlight], marked = span !== undefined && span.start <= position;
          while (result.syntax[syntaxIndex] && result.syntax[syntaxIndex]!.end <= position) syntaxIndex++;
          const syntax = result.syntax[syntaxIndex], colored = syntax !== undefined && syntax.start <= position;
          const end = Math.min(limit, span ? marked ? span.end : span.start : limit, syntax ? colored ? syntax.end : syntax.start : limit);
          const fragment = element("span", result.text.slice(position, end)); if (colored) fragment.dataset.syntaxColor = String(syntax.color);
          if (marked) { if (!mark) { mark = element("mark"); mark.title = "Owned complexity contribution"; content.append(mark); } mark.append(fragment); }
          else { mark = undefined; content.append(fragment); }
          position = end;
        }
        row.append(number, content); code.append(row); textOffset = limit + 1;
      }
      sourceRange.textContent = `Shown source: ${point(result.start)}–${point(result.end)}`;
      sourceMessage.textContent = (result.syntaxUnavailable ? "Syntax coloring unavailable. " : "") + (result.highlights.length ? "Underlined: owned complexity-contribution spans." : "No owned contribution in this source page.");
      sourcePaging.hidden = false; previousSource.hidden = nextSource.hidden = history.length === 0 && next === null;
      previousSource.disabled = history.length === 0; nextSource.disabled = next === null; scope.disabled = false;
      code.scrollTop = 0; code.scrollLeft = 0; if (focusSource) { focusSource = false; code.focus?.({ preventScroll: true }); }
      void loadContributions();
    } catch { if (active && epoch === sourceEpoch) { sourcePending = false; shown = undefined; code.replaceChildren(); sourceMessage.textContent = "Source inspection unavailable."; contributionMessage.textContent = "No source page is shown."; } }
  }
  async function loadContributions(): Promise<void> {
    if (!active || !selected || !shown || sourcePending || !dialog.open) return;
    const epoch = ++contributionEpoch, unit = selected.id, source = shown, expectedSourceEpoch = sourceEpoch, all = wholeUnit;
    const current = () => active && epoch === contributionEpoch && expectedSourceEpoch === sourceEpoch && shown === source && selected?.id === unit && dialog.open && wholeUnit === all;
    contributionPending = true; contributions.replaceChildren(); contributionPaging.hidden = true;
    contributionMessage.textContent = "Loading contributions"; previousContributions.disabled = true; nextContributions.disabled = true;
    try {
      const result = await inspect({ type: "contributions", path, unit, offset: contributionOffset, cursor: all ? null : source.cursor });
      if (!current()) return;
      if (result.type !== "contributions" || result.unitTotal !== selected!.complexity - 1) throw new Error("Invalid contributions");
      contributionPending = false; contributionTotal = result.total; contributions.start = contributionOffset + 1;
      for (const row of result.rows) {
        const continued = !all && (compare(row.start, source.start) < 0 || compare(row.end, source.end) > 0);
        const item = element("li"), open = button(`${row.kind} · ${point(row.start)}–${point(row.end)}${continued ? " · extends outside shown page" : ""}`, () => {
          if (!current()) return;
          wholeUnit = false; scope.value = "shown"; contributionOffset = 0;
          if (cursor !== row.cursor) { if (cursor !== null) history.push(cursor); cursor = row.cursor; focusSource = true; void loadSource(); }
          else { code.scrollTop = 0; code.scrollLeft = 0; code.focus?.({ preventScroll: true }); void loadContributions(); }
        });
        open.dataset.contribution = String(row.id); item.append(open); contributions.append(item);
      }
      contributionMessage.textContent = result.unitTotal === 0 ? "No branching contributions in this unit."
        : all ? `${result.unitTotal} contributions in the whole unit. Select a location to show its source.`
        : `${result.total} of ${result.unitTotal} contributions overlap the shown source. Select Whole unit to browse all.`;
      contributionRange.textContent = result.total === 0 ? "" : `${contributionOffset + 1}–${Math.min(result.total, contributionOffset + CONTRIBUTION_PAGE_SIZE)} of ${result.total}`;
      contributionPaging.hidden = result.total <= CONTRIBUTION_PAGE_SIZE;
      previousContributions.disabled = contributionOffset === 0; nextContributions.disabled = contributionOffset + CONTRIBUTION_PAGE_SIZE >= result.total;
    } catch { if (current()) { contributionPending = false; contributions.replaceChildren(); contributionMessage.textContent = "Contribution inspection unavailable."; } }
  }
  void loadUnits();
  return () => { active = false; listEpoch++; sourceEpoch++; contributionEpoch++; if (dialog.open) dialog.close(); slot.replaceChildren(); };
}
