import type { DistrictDescriptor, InspectionFact } from "../application/city-payload";
import { compareUnsignedUtf8 } from "../domain/source-admission";

export function immediateDirectory(path: string): string | null {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? null : path.slice(0, slash);
}

/** Indexed once per publication. Root identity never aliases a real `_root` directory. */
export function createDistrictInspectionIndex(
  inspection: readonly InspectionFact[],
  districts: readonly DistrictDescriptor[],
) {
  const root = districts.findIndex(district => district.root);
  const byPath = new Map(districts.flatMap((district, index) => district.root ? [] : [[district.identity, index] as const]));
  const parents = districts.map(district => district.root ? null : byPath.get(immediateDirectory(district.identity) ?? "") ?? root);
  const children = districts.map(() => [] as number[]);
  const maxima = districts.map(() => 0);
  for (let index = 0; index < districts.length; index += 1) {
    const parent = parents[index];
    if (parent !== null && parent !== undefined && parent >= 0) children[parent]!.push(index);
  }
  const directoryOf = (path: string): number => {
    const directory = immediateDirectory(path);
    const index = directory === null ? root : byPath.get(directory);
    if (index === undefined || index < 0) throw new Error("Selected file has no district");
    return index;
  };
  for (const fact of inspection) {
    const index = directoryOf(fact.canonicalPath);
    maxima[index] = Math.max(maxima[index]!, fact.M);
  }
  // Canonical-path order puts every ancestor before its descendants; no recursive traversal.
  for (let index = districts.length - 1; index >= 0; index -= 1) {
    const parent = parents[index];
    if (parent !== null && parent !== undefined && parent >= 0) maxima[parent] = Math.max(maxima[parent]!, maxima[index]!);
  }
  for (const entries of children) entries.sort((left, right) => maxima[right]! - maxima[left]!
    || compareUnsignedUtf8(districts[left]!.identity, districts[right]!.identity));
  const members = (index: number): number[] => {
    const district = districts[index];
    if (!district) throw new Error("Invalid selected district");
    const prefix = `${district.identity}/`;
    const indices: number[] = [];
    for (let file = 0; file < inspection.length; file += 1) {
      if (district.root || inspection[file]!.canonicalPath.startsWith(prefix)) indices.push(file);
    }
    return indices;
  };
  return { root, parents, children, maxima, directoryOf, members };
}

type DistrictIndex = ReturnType<typeof createDistrictInspectionIndex>;
type Sort = "S" | "U" | "M";
const PAGE_SIZE = 32;

/** Native controls only. Every detached row and disposed view invalidates its callbacks. */
export function attachDistrictInspection(
  documentTarget: Pick<Document, "createElement">,
  inspector: HTMLElement,
  inspection: readonly InspectionFact[],
  districts: readonly DistrictDescriptor[],
  hierarchy: DistrictIndex,
  selected: number,
  members: readonly number[],
  selectDistrict: (index: number) => void,
  selectFile: (index: number) => void,
): () => void {
  let active = true;
  const releases: Array<() => void> = [];
  const on = (element: HTMLElement, event: string, callback: () => void): (() => void) => {
    let attached = true;
    const listener = (): void => { if (active && attached) callback(); };
    element.addEventListener(event, listener);
    return () => { attached = false; element.removeEventListener(event, listener); };
  };
  const button = (text: string, callback: () => void): HTMLButtonElement => {
    const element = documentTarget.createElement("button");
    element.type = "button";
    element.textContent = text;
    releases.push(on(element, "click", callback));
    return element;
  };
  const path = (text: string): HTMLElement => {
    const element = documentTarget.createElement("bdi");
    element.setAttribute("dir", "auto");
    element.textContent = text;
    return element;
  };
  const view = documentTarget.createElement("div");
  view.dataset.districtInspection = "";
  const navigation = documentTarget.createElement("nav");
  navigation.dataset.districtNavigation = "";
  navigation.setAttribute("aria-label", "Directory navigation");
  const root = button("Root /", () => selectDistrict(hierarchy.root));
  root.disabled = selected === hierarchy.root;
  const parent = hierarchy.parents[selected];
  const up = button("Parent directory", () => { if (parent !== null && parent !== undefined) selectDistrict(parent); });
  up.disabled = parent === null || parent === undefined;
  navigation.append(root, up);
  const breadcrumbs = documentTarget.createElement("ol");
  breadcrumbs.dataset.districtBreadcrumbs = "";
  breadcrumbs.setAttribute("aria-label", "Directory breadcrumbs");
  const ancestors: number[] = [];
  for (let index: number | null | undefined = selected; index !== null && index !== undefined; index = hierarchy.parents[index]) ancestors.push(index);
  for (const index of ancestors.reverse()) {
    const item = documentTarget.createElement("li");
    const control = button("", () => selectDistrict(index));
    control.append(path(districts[index]!.root ? "/" : districts[index]!.identity));
    if (index === selected) control.setAttribute("aria-current", "location");
    item.append(control);
    breadcrumbs.append(item);
  }
  navigation.append(breadcrumbs);
  view.append(navigation);

  const list = (kind: "directories" | "files", initialIndices: readonly number[]): void => {
    let indices = initialIndices;
    let page = 0;
    let releaseRows: Array<() => void> = [];
    const section = documentTarget.createElement("section");
    section.dataset.districtList = kind;
    const heading = documentTarget.createElement("h3");
    heading.textContent = kind === "directories" ? "Direct child directories" : "Contained files (complete subtree)";
    const scope = documentTarget.createElement("p");
    scope.textContent = kind === "directories"
      ? "Immediate child directories only; ranked by descendant maximum complexity (M)."
      : "All successful files in this directory and its descendants; independent of Find file.";
    section.append(heading, scope);
    const rows = documentTarget.createElement("ul");
    rows.dataset.districtRows = kind;
    const status = documentTarget.createElement("span");
    status.setAttribute("role", "status");
    const render = (): void => {
      for (const release of releaseRows) release();
      releaseRows = [];
      rows.replaceChildren();
      const start = page * PAGE_SIZE;
      for (const index of indices.slice(start, start + PAGE_SIZE)) {
        const item = documentTarget.createElement("li");
        const control = documentTarget.createElement("button");
        control.type = "button";
        control.append(path(kind === "directories" ? districts[index]!.identity : inspection[index]!.canonicalPath));
        const metrics = documentTarget.createElement("span");
        metrics.dataset.districtRowMetrics = "";
        const fact = inspection[index];
        metrics.textContent = kind === "directories" ? `M: ${hierarchy.maxima[index]}` : `S: ${fact!.S} · U: ${fact!.U} · M: ${fact!.M}`;
        control.append(metrics);
        releaseRows.push(on(control, "click", () => kind === "directories" ? selectDistrict(index) : selectFile(index)));
        item.append(control);
        rows.append(item);
      }
      const count = indices.length;
      status.textContent = count === 0 ? "0 rows" : `${start + 1}–${Math.min(start + PAGE_SIZE, count)} of ${count}`;
      previous.disabled = page === 0;
      next.disabled = (page + 1) * PAGE_SIZE >= count;
    };
    if (kind === "files") {
      const label = documentTarget.createElement("label");
      label.textContent = "Sort contained files by";
      const sort = documentTarget.createElement("select");
      sort.dataset.districtFileSort = "";
      for (const [value, text] of [["M", "Maximum complexity (M)"], ["S", "Source lines (S)"], ["U", "Executable units (U)"]]) {
        const option = documentTarget.createElement("option");
        option.value = value!;
        option.textContent = text!;
        sort.append(option);
      }
      sort.value = "M";
      const reorder = (): void => {
        const metric = sort.value as Sort;
        if (metric !== "S" && metric !== "U" && metric !== "M") return;
        indices = [...initialIndices].sort((left, right) => inspection[right]![metric] - inspection[left]![metric]
          || compareUnsignedUtf8(inspection[left]!.canonicalPath, inspection[right]!.canonicalPath));
        page = 0;
        render();
      };
      releases.push(on(sort, "change", reorder));
      label.append(sort);
      section.append(label);
      // Initial order uses exactly the same comparator as subsequent native sort changes.
      indices = [...initialIndices].sort((left, right) => inspection[right]!.M - inspection[left]!.M
        || compareUnsignedUtf8(inspection[left]!.canonicalPath, inspection[right]!.canonicalPath));
    }
    const paging = documentTarget.createElement("div");
    paging.dataset.districtPaging = kind;
    const previous = button("Previous", () => { if (page > 0) { page -= 1; render(); } });
    const next = button("Next", () => { if ((page + 1) * PAGE_SIZE < indices.length) { page += 1; render(); } });
    previous.setAttribute("aria-label", `Previous ${kind} page`);
    next.setAttribute("aria-label", `Next ${kind} page`);
    paging.append(previous, status, next);
    section.append(rows, paging);
    view.append(section);
    releases.push(() => { for (const release of releaseRows) release(); });
    render();
  };
  list("directories", hierarchy.children[selected]!);
  list("files", members);
  inspector.append(view);
  return () => {
    if (!active) return;
    active = false;
    for (const release of releases) release();
  };
}
