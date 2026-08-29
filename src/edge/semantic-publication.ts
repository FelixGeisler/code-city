import type { ControllerCanvas, ControllerPublication } from "../application/main-controller";
import type { InspectionFact } from "../application/city-payload";

export function stageSemanticPublication(
  documentTarget: Pick<Document, "createElement">,
  publicationRoot: Pick<HTMLElement, "replaceChildren">,
  revisionOutput: Pick<HTMLElement, "textContent">,
  revision: string,
  inspection: readonly InspectionFact[],
): ControllerPublication {
  const inspector = documentTarget.createElement("section");
  inspector.dataset.inspector = "";
  inspector.setAttribute("role", "status");
  inspector.setAttribute("aria-live", "polite");
  inspector.setAttribute("aria-atomic", "true");
  inspector.hidden = true;
  const path = documentTarget.createElement("bdi");
  path.dataset.canonicalPath = "";
  inspector.append(path);
  let committedToRoot = false;

  return Object.freeze({
    commit(canvas: ControllerCanvas) {
      publicationRoot.replaceChildren(canvas as unknown as Node, inspector);
      revisionOutput.textContent = revision;
      committedToRoot = true;
    },
    setSelection(index: number | null) {
      if (index === null) {
        path.textContent = "";
        inspector.hidden = true;
        return;
      }
      const fact = inspection[index];
      if (!fact) throw new Error("Invalid semantic selection");
      path.textContent = fact.canonicalPath;
      inspector.hidden = false;
    },
    rollback() {
      path.textContent = "";
      inspector.hidden = true;
      inspector.remove();
      if (committedToRoot || revisionOutput.textContent === revision) revisionOutput.textContent = "";
      committedToRoot = false;
    },
  });
}
