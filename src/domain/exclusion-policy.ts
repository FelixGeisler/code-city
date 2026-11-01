import { compareUnsignedUtf8, isCanonicalAdditionalExclusions } from "./source-admission";

export const EXCLUSION_POLICY_VERSION = "code-city-auto-exclusions-1" as const;
// Pinned version-1 wire vocabulary. Changing this catalogue requires a new policy version.
export const AUTOMATIC_EXCLUSION_RULES = Object.freeze([
  ...["node_modules", "bower_components", ".pnpm-store", ".yarn/cache", ".yarn/unplugged"].map(path => ({ id: `dependency:${path}`, path, reason: "Recognized dependency directory convention" })),
  ...["dist", "build", "bin", "obj", "coverage", ".nyc_output"].map(path => ({ id: `output:${path}`, path, reason: "Recognized generated output/report convention" })),
  ...[".angular", ".next", ".nuxt", ".svelte-kit", ".parcel-cache", ".vite", ".turbo", ".nx"].map(path => ({ id: `cache:${path}`, path, reason: "Recognized framework/cache convention" })),
].map(rule => Object.freeze(rule)));
export type ExclusionSettings = Readonly<{ manual: readonly string[]; included: readonly string[] }>;
export type ExclusionInput = ExclusionSettings | readonly string[];
export type RecordedExclusionPolicy = Readonly<{
  version: typeof EXCLUSION_POLICY_VERSION;
  manual: readonly string[];
  included: readonly string[];
  detected: readonly (readonly [path: string, ruleId: string])[];
  effective: readonly string[];
}>;
export type ExclusionReport = (policy: RecordedExclusionPolicy, complete: boolean) => void;
export function exclusionSettings(input: ExclusionInput): ExclusionSettings {
  const value = Array.isArray(input) ? { manual: input, included: [] } : input as ExclusionSettings;
  if (!value || !Array.isArray(value.manual) || !Array.isArray(value.included)
    || !isCanonicalAdditionalExclusions(value.manual) || !isCanonicalAdditionalExclusions(value.included) || value.included.some(path => !automaticRule(path))) throw new Error("Invalid exclusion settings");
  return Object.freeze({ manual: Object.freeze([...value.manual]), included: Object.freeze([...value.included]) });
}
const rulesByLeaf = new Map(AUTOMATIC_EXCLUSION_RULES.map(rule => [rule.path.slice(rule.path.lastIndexOf("/") + 1), rule]));
export function automaticRule(path: string) {
  const rule = rulesByLeaf.get(path.slice(path.lastIndexOf("/") + 1));
  return rule && (path === rule.path || path.endsWith(`/${rule.path}`)) ? rule : undefined;
}
export function automaticRootPaths(path: string): string[] {
  const segments = path.split("/"), roots: string[] = [];
  for (let index = 0; index < segments.length - 1; index++) {
    const rule = rulesByLeaf.get(segments[index]!);
    if (!rule || (rule.path.startsWith(".yarn/") && segments[index - 1] !== ".yarn")) continue;
    roots.push(segments.slice(0, index + 1).join("/"));
  }
  return roots;
}
export function manuallyExcluded(path: string, manual: readonly string[]): boolean {
  return manual.some(root => path === root || path.startsWith(`${root}/`));
}
export function excludedDirectory(path: string, input: ExclusionInput): boolean {
  const settings: ExclusionSettings = Array.isArray(input) ? { manual: input, included: [] } : input as ExclusionSettings;
  return manuallyExcluded(path, settings.manual) || (!!automaticRule(path) && !settings.included.includes(path));
}
export function recordExclusionPolicy(input: ExclusionInput, roots: readonly (readonly [string, string])[] = []): RecordedExclusionPolicy {
  const settings = exclusionSettings(input);
  const detected = [...roots].sort((a, b) => compareUnsignedUtf8(a[0], b[0])).map(row => Object.freeze([...row]) as readonly [string, string]);
  const included = new Set(settings.included);
  const effective = [...new Set([...settings.manual, ...detected.filter(([path]) => !included.has(path) || manuallyExcluded(path, settings.manual)).map(([path]) => path)])].sort(compareUnsignedUtf8);
  return Object.freeze({ version: EXCLUSION_POLICY_VERSION, ...settings, detected: Object.freeze(detected), effective: Object.freeze(effective) });
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid exclusion policy");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key] || !("value" in descriptors[key]!))) throw new Error("Invalid exclusion policy shape");
}
function dense(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).some(d => !d || !("value" in d))) throw new Error("Invalid exclusion policy array");
}
export function parseRecordedExclusionPolicy(value: unknown): RecordedExclusionPolicy {
  exact(value, ["version", "manual", "included", "detected", "effective"]);
  if (value.version !== EXCLUSION_POLICY_VERSION) throw new Error("Unsupported exclusion policy version");
  for (const key of ["manual", "included", "effective"] as const) {
    dense(value[key]);
    if (!(value[key] as unknown[]).every(path => typeof path === "string") || !isCanonicalAdditionalExclusions(value[key] as string[])) throw new Error("Invalid exclusion policy paths");
  }
  dense(value.detected);
  const roots: [string, string][] = [];
  const detectedPaths = new Set<string>(), includedPaths = new Set(value.included as string[]);
  let prior: string | undefined;
  for (const row of value.detected) {
    dense(row);
    if (row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string"
      || !isCanonicalAdditionalExclusions([row[0]]) || automaticRule(row[0])?.id !== row[1]
      || (prior !== undefined && compareUnsignedUtf8(prior, row[0]) >= 0)) throw new Error("Invalid detected exclusion");
    // Descendants of pruned roots cannot have been discovered.
    if ((value.manual as string[]).some(root => (row[0] as string).startsWith(`${root}/`))) throw new Error("Hidden detected exclusion");
    if (automaticRootPaths(row[0]).some(root => !includedPaths.has(root) || !detectedPaths.has(root))) throw new Error("Missing automatic ancestor");
    roots.push([row[0], row[1]]); detectedPaths.add(row[0]); prior = row[0];
  }
  const policy = recordExclusionPolicy(value as unknown as ExclusionSettings, roots);
  if (JSON.stringify(policy.effective) !== JSON.stringify(value.effective)) throw new Error("Inconsistent effective exclusions");
  return policy;
}
