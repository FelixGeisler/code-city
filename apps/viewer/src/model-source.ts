import { normalizeAssetRelativePath } from "../../../packages/core/src/identity.js";
import type { SemanticGroup } from "../../../packages/core/src/model.js";

export interface AutomaticModelLoadAttempt {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly finish: () => void;
}

export class AutomaticModelLoadGate {
  private generation = 0;
  private controller: AbortController | undefined;

  public begin(): AutomaticModelLoadAttempt {
    this.invalidate();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () =>
        this.generation === generation &&
        this.controller === controller &&
        !controller.signal.aborted,
      finish: () => {
        if (
          this.generation === generation &&
          this.controller === controller
        ) {
          this.controller = undefined;
        }
      },
    };
  }

  public invalidate(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
  }
}

export function assetRootFromResponseUrl(responseUrl: string): URL {
  const response = new URL(responseUrl);
  if (response.protocol !== "http:" && response.protocol !== "https:") {
    throw new TypeError("Model responses must use HTTP or HTTPS.");
  }
  return new URL(".", response);
}

export function resolveAssetUrl(
  relativePath: string,
  assetRoot: URL,
): URL {
  const normalized = normalizeAssetRelativePath(relativePath);
  if (normalized !== relativePath) {
    throw new TypeError(
      "Logo paths in a city model must already be normalized.",
    );
  }
  if (
    (assetRoot.protocol !== "http:" && assetRoot.protocol !== "https:") ||
    !assetRoot.pathname.endsWith("/")
  ) {
    throw new TypeError(
      "The asset root must be an HTTP(S) directory URL.",
    );
  }

  const resolved = new URL(normalized, assetRoot);
  if (
    resolved.origin !== assetRoot.origin ||
    resolved.protocol !== assetRoot.protocol ||
    !resolved.pathname.startsWith(assetRoot.pathname)
  ) {
    throw new TypeError("Resolved logo URL escapes the model asset root.");
  }
  return resolved;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortLegendGroups(
  groups: readonly SemanticGroup[],
): readonly SemanticGroup[] {
  return [...groups].sort(
    (left, right) =>
      right.priority - left.priority ||
      compareText(left.label, right.label) ||
      compareText(left.id, right.id),
  );
}
