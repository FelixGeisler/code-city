import {
  DESIGN_SMELL_LIMITS,
  DESIGN_SMELL_PROTOCOL_VERSION,
  validateDesignSmellSuppression,
  type CityModel,
  type DesignSmellSuppression,
} from "../../../packages/core/src/index.js";
import { metricMappingProjectIdentity, type MetricMappingStorage } from "./metric-mapping-storage.js";

export const DESIGN_SMELL_SUPPRESSION_STORAGE_PREFIX = "code-city-design-smell-suppressions-v1:";
const MAXIMUM_STORAGE_BYTES = 256 * 1024;

interface DocumentV1 {
  readonly protocolVersion: typeof DESIGN_SMELL_PROTOCOL_VERSION;
  readonly projectIdentity: string;
  readonly suppressions: readonly DesignSmellSuppression[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function key(model: CityModel): string { return `${DESIGN_SMELL_SUPPRESSION_STORAGE_PREFIX}${metricMappingProjectIdentity(model)}`; }
function parse(value: string, projectIdentity: string): DocumentV1 | undefined {
  if (new TextEncoder().encode(value).byteLength > MAXIMUM_STORAGE_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const document = parsed as Record<string, unknown>;
    if (Object.keys(document).sort().join("\u0000") !== ["projectIdentity", "protocolVersion", "suppressions"].join("\u0000") || document.protocolVersion !== DESIGN_SMELL_PROTOCOL_VERSION || document.projectIdentity !== projectIdentity || !Array.isArray(document.suppressions) || document.suppressions.length > DESIGN_SMELL_LIMITS.suppressions) return undefined;
    const identities = new Set<string>();
    for (const suppression of document.suppressions) { validateDesignSmellSuppression(suppression); const current = suppression as DesignSmellSuppression; const identity = `${current.buildingId}\u0000${current.ruleId}`; if (identities.has(identity)) return undefined; identities.add(identity); }
    return { protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION, projectIdentity, suppressions: structuredClone(document.suppressions as DesignSmellSuppression[]) };
  } catch { return undefined; }
}

/** Local, project-scoped false-positive decisions. CityModel and source are never changed. */
export class DesignSmellSuppressionStore {
  public constructor(private readonly storage: MetricMappingStorage) {}
  public list(model: CityModel): readonly DesignSmellSuppression[] {
    const identity = metricMappingProjectIdentity(model);
    try { return Object.freeze(parse(this.storage.getItem(key(model)) ?? "", identity)?.suppressions ?? []); } catch { return []; }
  }
  public save(model: CityModel, suppression: DesignSmellSuppression): boolean {
    try { validateDesignSmellSuppression(suppression); } catch { return false; }
    const current = [...this.list(model)].filter((entry) => entry.buildingId !== suppression.buildingId || entry.ruleId !== suppression.ruleId);
    if (current.length >= DESIGN_SMELL_LIMITS.suppressions) return false;
    current.push(structuredClone(suppression));
    current.sort(
      (left, right) =>
        compareText(left.buildingId, right.buildingId) ||
        compareText(left.ruleId, right.ruleId),
    );
    return this.write(model, current);
  }
  public remove(model: CityModel, buildingId: string, ruleId: DesignSmellSuppression["ruleId"]): boolean {
    return this.write(model, this.list(model).filter((entry) => entry.buildingId !== buildingId || entry.ruleId !== ruleId));
  }
  private write(model: CityModel, suppressions: readonly DesignSmellSuppression[]): boolean {
    const value = JSON.stringify({ protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION, projectIdentity: metricMappingProjectIdentity(model), suppressions });
    if (new TextEncoder().encode(value).byteLength > MAXIMUM_STORAGE_BYTES) return false;
    try { this.storage.setItem(key(model), value); return true; } catch { return false; }
  }
}
