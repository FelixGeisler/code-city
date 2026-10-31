import { CONTRIBUTION_PAGE_SIZE, UNIT_PAGE_SIZE, type InspectionQuery, type InspectionResult, type SourceLocation, type UnitRow } from "../application/unit-inspection";
export type InspectInvestigation = (query: InspectionQuery) => Promise<InspectionResult>;
type InspectionDocument = Pick<Document, "createElement">;
const point = (location: SourceLocation) => `${location.line}:${location.column}`;
export function unitKindLabel(path: string, kind: string): string {
  if (kind === "arrow") return /\.cs$/iu.test(path) ? "Lambda expression" : "Arrow function";
  const label = ({ "top-level": "Top-level code", function: "Function", method: "Method", constructor: "Constructor", getter: "Getter", setter: "Setter", "static-block": "Static initializer" } as Record<string, unknown>)[kind];
  return typeof label === "string" ? label : "Executable unit";
}

/** One file's view owns its callbacks, dialog and disclosure state. */
export function attachUnitInspection(documentTarget: InspectionDocument, inspector: HTMLElement, path: string, inspect: InspectInvestigation): () => void {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] => { const node = documentTarget.createElement(tag); node.textContent = text; return node; };
  const button = (label: string, action: () => void) => { const node = element("button", label); node.type = "button"; node.addEventListener("click", action); return node; };
  const slot = element("section"); slot.dataset.units = ""; slot.setAttribute("aria-live", "off");
  slot.append(element("h3", "Executable units"));
  const message = element("p"); message.setAttribute("role", "status");
  const rows = element("ol"); rows.dataset.unitRows = "";
  const page = element("div"); page.dataset.unitPaging = "";
  const range = element("span");
  let active = true, listEpoch = 0, sourceEpoch = 0, contributionEpoch = 0, offset = 0, total = 0;
  let selected: UnitRow | undefined, cursor: number | null = null, next: number | null = null, contributionOffset = 0, contributionTotal = 0;
  const history: number[] = [];
  const previousUnits = button("Previous units", () => { offset = Math.max(0, offset - UNIT_PAGE_SIZE); void loadUnits(); });
  const nextUnits = button("Next units", () => { offset += UNIT_PAGE_SIZE; void loadUnits(); });
  page.append(previousUnits, range, nextUnits);
  const dialog = element("dialog"); dialog.dataset.unitSource = ""; dialog.setAttribute("aria-labelledby", "unit-source-title");
  const heading = element("h2"); heading.id = "unit-source-title"; const identity = element("bdi", path); identity.dir = "auto"; heading.append(identity);
  const close = button("Close source", () => dialog.close()); close.dataset.closeSource = "";
  const titleBar = element("div"); titleBar.dataset.sourceTitle = ""; titleBar.append(heading, close);
  const details = element("p"); details.dataset.unitDetails = "";
  const sourceMessage = element("p"); sourceMessage.setAttribute("role", "status");
  const sourceRange = element("span"); sourceRange.dataset.sourceRange = "";
  const code = element("pre"); code.dataset.sourceCode = ""; code.tabIndex = 0; code.setAttribute("aria-label", "Read-only normalized source"); code.dir = "ltr";
  const sourcePaging = element("div"); sourcePaging.dataset.sourcePaging = "";
  const previousSource = button("Previous source", () => { cursor = history.pop() ?? null; void loadSource(); });
  const nextSource = button("Next source", () => { if (next === null || cursor === null) return; history.push(cursor); cursor = next; void loadSource(); });
  sourcePaging.append(previousSource, sourceRange, nextSource);
  const sourceSection = element("section"); sourceSection.append(sourceMessage, sourcePaging, code);
  const contributionSection = element("section"); contributionSection.dataset.ownedContributions = "";
  const contributionMessage = element("p"); contributionMessage.setAttribute("role", "status");
  const contributions = element("ol"); contributions.dataset.contributionRows = "";
  const contributionPaging = element("div"); contributionPaging.dataset.contributionPaging = "";
  const contributionRange = element("span");
  const previousContributions = button("Previous contributions", () => { contributionOffset = Math.max(0, contributionOffset - CONTRIBUTION_PAGE_SIZE); void loadContributions(); });
  const nextContributions = button("Next contributions", () => { contributionOffset += CONTRIBUTION_PAGE_SIZE; void loadContributions(); });
  contributionPaging.append(previousContributions, contributionRange, nextContributions);
  contributionSection.append(element("h3", "Owned contributions"), contributionMessage, contributionPaging, contributions);
  const body = element("div"); body.dataset.sourceBody = ""; body.append(sourceSection, contributionSection);
  dialog.append(titleBar, details, body);
  dialog.addEventListener("keydown", event => event.stopPropagation());
  dialog.addEventListener("close", () => { if (dialog.open) return; selected = undefined; sourceEpoch++; contributionEpoch++; code.replaceChildren(); contributions.replaceChildren(); });
  slot.append(message, rows, page, dialog); inspector.append(slot);

  async function loadUnits(): Promise<void> {
    if (!active) return;
    const epoch = ++listEpoch; message.textContent = "Loading units"; previousUnits.disabled = true; nextUnits.disabled = true;
    try {
      const result = await inspect({ type: "units", path, offset });
      if (!active || epoch !== listEpoch) return;
      if (result.type !== "units") throw new Error("Invalid unit list");
      total = result.total; rows.replaceChildren(); rows.start = offset + 1;
      for (const unit of result.rows) {
        const row = element("li"); const open = button("", () => openSource(unit)); open.dataset.unit = String(unit.id);
        const name = element("span", `${unitKindLabel(path, unit.kind)} · ${point(unit.start)}–${point(unit.end)}`);
        const value = element("span", `Complexity ${unit.complexity}`); value.dataset.unitComplexity = "";
        open.append(name, value); row.append(open); rows.append(row);
      }
      message.textContent = total === 0 ? "No executable units." : "";
      range.textContent = total === 0 ? "" : `${offset + 1}–${Math.min(total, offset + UNIT_PAGE_SIZE)} of ${total}`;
      page.hidden = total <= UNIT_PAGE_SIZE; previousUnits.disabled = offset === 0; nextUnits.disabled = offset + UNIT_PAGE_SIZE >= total;
    } catch { if (active && epoch === listEpoch) { rows.replaceChildren(); page.hidden = true; message.textContent = "Unit inspection unavailable."; } }
  }
  function openSource(unit: UnitRow): void {
    if (!active) return;
    selected = unit; cursor = null; next = null; history.length = 0; contributionOffset = 0;
    details.textContent = `${unitKindLabel(path, unit.kind)} · Complexity ${unit.complexity} · ${point(unit.start)}–${point(unit.end)} (end exclusive)`;
    code.replaceChildren(); contributions.replaceChildren(); sourcePaging.hidden = true; dialog.showModal();
    void loadSource(); void loadContributions();
  }
  async function loadSource(): Promise<void> {
    if (!active || !selected || !dialog.open) return;
    const epoch = ++sourceEpoch, unit = selected.id;
    sourceMessage.textContent = "Loading source"; previousSource.disabled = true; nextSource.disabled = true;
    try {
      const result = await inspect({ type: "source", path, unit, cursor });
      if (!active || epoch !== sourceEpoch || selected?.id !== unit || !dialog.open) return;
      if (result.type !== "source") throw new Error("Invalid source");
      cursor = result.cursor; next = result.next;
      code.replaceChildren(); let textOffset = 0, highlight = 0, syntaxIndex = 0, line = result.start.line;
      for (const text of result.text.split("\n")) {
        const row = element("span"); row.dataset.sourceLine = "";
        const number = element("span", String(line++)); number.dataset.sourceLineNumber = ""; number.setAttribute("aria-hidden", "true");
        const content = element("code");
        const limit = textOffset + text.length; let position = textOffset, mark: HTMLElement | undefined;
        while (position < limit) {
          while (result.highlights[highlight] && result.highlights[highlight]!.end <= position) highlight++;
          const span = result.highlights[highlight]; const marked = span !== undefined && span.start <= position;
          while (result.syntax[syntaxIndex] && result.syntax[syntaxIndex]!.end <= position) syntaxIndex++;
          const syntax = result.syntax[syntaxIndex], colored = syntax !== undefined && syntax.start <= position;
          const end = Math.min(limit, span ? marked ? span.end : span.start : limit, syntax ? colored ? syntax.end : syntax.start : limit);
          const fragment = element("span", result.text.slice(position, end));
          if (colored) fragment.dataset.syntax = syntax.kind;
          if (marked) {
            if (!mark) { mark = element("mark"); mark.title = "Owned complexity contribution"; content.append(mark); }
            mark.append(fragment);
          } else { mark = undefined; content.append(fragment); }
          position = end;
        }
        row.append(number, content); code.append(row); textOffset = limit + 1;
      }
      sourceRange.textContent = `${point(result.start)}–${point(result.end)}`;
      sourceMessage.textContent = result.highlights.length ? "Underlined: owned complexity-contribution spans." : "No owned contribution in this source page.";
      sourcePaging.hidden = history.length === 0 && next === null;
      previousSource.disabled = history.length === 0; nextSource.disabled = next === null;
      code.scrollTop = 0; code.scrollLeft = 0;
    } catch { if (active && epoch === sourceEpoch) { code.replaceChildren(); sourceMessage.textContent = "Source inspection unavailable."; } }
  }
  async function loadContributions(): Promise<void> {
    if (!active || !selected || !dialog.open) return;
    const epoch = ++contributionEpoch, unit = selected.id;
    contributionMessage.textContent = "Loading contributions"; previousContributions.disabled = true; nextContributions.disabled = true;
    try {
      const result = await inspect({ type: "contributions", path, unit, offset: contributionOffset });
      if (!active || epoch !== contributionEpoch || selected?.id !== unit || !dialog.open) return;
      if (result.type !== "contributions") throw new Error("Invalid contributions");
      contributionTotal = result.total; contributions.replaceChildren(); contributions.start = contributionOffset + 1;
      for (const row of result.rows) contributions.append(element("li", `${row.kind} · ${point(row.start)}–${point(row.end)}`));
      contributionMessage.textContent = contributionTotal === 0 ? "No branching contributions." : "Locations use one-based lines and Unicode columns; ends are exclusive.";
      contributionRange.textContent = contributionTotal === 0 ? "" : `${contributionOffset + 1}–${Math.min(contributionTotal, contributionOffset + CONTRIBUTION_PAGE_SIZE)} of ${contributionTotal}`;
      contributionPaging.hidden = contributionTotal <= CONTRIBUTION_PAGE_SIZE;
      previousContributions.disabled = contributionOffset === 0; nextContributions.disabled = contributionOffset + CONTRIBUTION_PAGE_SIZE >= contributionTotal;
    } catch { if (active && epoch === contributionEpoch) { contributions.replaceChildren(); contributionMessage.textContent = "Contribution inspection unavailable."; } }
  }
  void loadUnits();
  return () => { active = false; listEpoch++; sourceEpoch++; contributionEpoch++; if (dialog.open) dialog.close(); slot.replaceChildren(); };
}
