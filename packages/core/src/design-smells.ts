import { CITY_MODEL_LIMITS } from "./model-validation.js";
import type {
  CityBuilding,
  CityModel,
  SourceLanguage,
} from "./model.js";

export const DESIGN_SMELL_PROTOCOL_VERSION =
  "codecity.design-smells/1" as const;
export const DESIGN_SMELL_RULE_CATALOG_VERSION = "1.1.0" as const;
export const DESIGN_SMELL_LIMITS = Object.freeze({
  rules: 8,
  buildings: CITY_MODEL_LIMITS.buildings,
  findings: 20_000,
  suppressions: 2_000,
  findingIdCharacters: 96,
  threshold: 1_000_000_000,
  evidenceRelatedBuildingIds: CITY_MODEL_LIMITS.buildings,
  suppressionReasonCharacters: CITY_MODEL_LIMITS.displayTextCharacters,
} as const);

export type DesignSmellId =
  | "high-complexity-method"
  | "oversized-file"
  | "oversized-class"
  | "excessive-coupling"
  | "dependency-cycle"
  | "duplicate-code"
  | "feature-envy";

export type DesignSmellAvailability = "available" | "unavailable";
export type DesignSmellSeverity = "moderate" | "high" | "critical";

export interface DesignSmellRuleDefinition {
  readonly id: DesignSmellId;
  readonly version: "1";
  readonly name: string;
  readonly category:
    | "complexity"
    | "size"
    | "coupling"
    | "structure";
  readonly availability: DesignSmellAvailability;
  readonly languages: readonly SourceLanguage[];
  readonly threshold?: Readonly<Record<SourceLanguage, number>>;
  readonly thresholdLabel?: string;
  readonly unavailableReason?: string;
  readonly description: string;
}

export interface DesignSmellLanguageAvailability {
  readonly availability: DesignSmellAvailability;
  readonly reason?: string;
}

const SOURCE_LANGUAGES = [
  "csharp",
  "typescript",
  "javascript",
] as const;

const CSHARP_DEPENDENCY_UNAVAILABLE =
  "CityModel 1.0 records C# project and package dependencies at module " +
  "level, so they cannot be attributed soundly to individual buildings.";

const CATALOG = [
  {
    id: "high-complexity-method",
    version: "1",
    name: "High-complexity method",
    category: "complexity",
    availability: "available",
    languages: SOURCE_LANGUAGES,
    threshold: { csharp: 15, typescript: 15, javascript: 15 },
    thresholdLabel: "cyclomatic complexity at least {threshold}",
    description:
      "Marks executable units whose measured cyclomatic complexity " +
      "reaches the configured threshold.",
  },
  {
    id: "oversized-file",
    version: "1",
    name: "Oversized file",
    category: "size",
    availability: "available",
    languages: SOURCE_LANGUAGES,
    threshold: { csharp: 500, typescript: 400, javascript: 400 },
    thresholdLabel: "source lines of code at least {threshold}",
    description:
      "Marks a source-file building when analyzer-measured SLOC reaches " +
      "the configured language-specific threshold.",
  },
  {
    id: "oversized-class",
    version: "1",
    name: "Oversized class",
    category: "size",
    availability: "unavailable",
    languages: SOURCE_LANGUAGES,
    unavailableReason:
      "Per-class size facts are not present in CityModel 1.0; a source " +
      "file may contain zero, one, or several classes.",
    description:
      "Requires per-class source ranges and size metrics, which this model " +
      "does not contain.",
  },
  {
    id: "excessive-coupling",
    version: "1",
    name: "Excessive coupling",
    category: "coupling",
    availability: "available",
    languages: SOURCE_LANGUAGES,
    threshold: { csharp: 10, typescript: 10, javascript: 10 },
    thresholdLabel:
      "distinct attributable outgoing dependencies at least {threshold}",
    description:
      "Marks JavaScript or TypeScript source files with many distinct " +
      "recorded attributable outgoing dependencies, including external targets.",
  },
  {
    id: "dependency-cycle",
    version: "1",
    name: "Dependency cycle",
    category: "structure",
    availability: "available",
    languages: SOURCE_LANGUAGES,
    threshold: { csharp: 2, typescript: 2, javascript: 2 },
    thresholdLabel: "cycle contains at least {threshold} source files",
    description:
      "Marks JavaScript or TypeScript source files in a strongly connected " +
      "component of recorded internal source-file dependencies.",
  },
  {
    id: "duplicate-code",
    version: "1",
    name: "Duplicate code",
    category: "structure",
    availability: "unavailable",
    languages: SOURCE_LANGUAGES,
    unavailableReason:
      "Clone-detection facts are not present in CityModel 1.0.",
    description:
      "Requires normalized source-token clone analysis, which this model " +
      "does not contain.",
  },
  {
    id: "feature-envy",
    version: "1",
    name: "Feature envy",
    category: "coupling",
    availability: "unavailable",
    languages: SOURCE_LANGUAGES,
    unavailableReason:
      "Member-access ownership facts are not present in CityModel 1.0.",
    description:
      "Requires receiver/member-access ownership facts, which this model " +
      "does not contain.",
  },
] as const satisfies readonly DesignSmellRuleDefinition[];

export const DESIGN_SMELL_RULE_CATALOG = Object.freeze(CATALOG);

export interface DesignSmellRuleSelection {
  readonly id: DesignSmellId;
  readonly enabled: boolean;
  readonly thresholds?: Partial<Record<SourceLanguage, number>>;
}

export interface DesignSmellConfiguration {
  readonly protocolVersion: typeof DESIGN_SMELL_PROTOCOL_VERSION;
  readonly ruleCatalogVersion: typeof DESIGN_SMELL_RULE_CATALOG_VERSION;
  readonly preset: "balanced" | "strict";
  readonly rules: readonly DesignSmellRuleSelection[];
}

export const DEFAULT_DESIGN_SMELL_CONFIGURATION:
  DesignSmellConfiguration = Object.freeze({
    protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
    ruleCatalogVersion: DESIGN_SMELL_RULE_CATALOG_VERSION,
    preset: "balanced",
    rules: Object.freeze(
      CATALOG.map((rule) =>
        Object.freeze({
          id: rule.id,
          enabled: rule.availability === "available",
        }),
      ),
    ),
  });

export interface DesignSmellSuppression {
  readonly protocolVersion: typeof DESIGN_SMELL_PROTOCOL_VERSION;
  readonly buildingId: string;
  readonly ruleId: DesignSmellId;
  readonly reason: string;
}

export interface DesignSmellEvidence {
  readonly kind:
    | "metric"
    | "executable-unit"
    | "dependency"
    | "cycle";
  readonly label: string;
  readonly value: number;
  readonly threshold: number;
  readonly unit?: string;
  readonly subject?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly relatedBuildingIds?: readonly string[];
}

export interface DesignSmellFinding {
  readonly id: string;
  readonly buildingId: string;
  readonly language: SourceLanguage;
  readonly ruleId: DesignSmellId;
  readonly ruleName: string;
  readonly ruleVersion: string;
  readonly severity: DesignSmellSeverity;
  readonly evidence: DesignSmellEvidence;
  readonly suppressed: boolean;
  readonly suppressionReason?: string;
}

export interface DesignSmellRuleResult {
  readonly rule: DesignSmellRuleDefinition;
  readonly enabled: boolean;
  readonly availability: DesignSmellAvailability;
  readonly reason?: string;
  readonly languageAvailability: Readonly<
    Record<SourceLanguage, DesignSmellLanguageAvailability>
  >;
  readonly threshold?: Readonly<Record<SourceLanguage, number>>;
  readonly findings: readonly DesignSmellFinding[];
}

export interface DesignSmellEvaluation {
  readonly protocolVersion: typeof DESIGN_SMELL_PROTOCOL_VERSION;
  readonly ruleCatalogVersion: typeof DESIGN_SMELL_RULE_CATALOG_VERSION;
  readonly results: readonly DesignSmellRuleResult[];
  readonly findings: readonly DesignSmellFinding[];
  readonly visibleFindings: readonly DesignSmellFinding[];
  readonly counts: Readonly<Record<DesignSmellId, number>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validBoundedText(
  value: unknown,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  );
}

function validModelId(value: unknown): value is string {
  return validBoundedText(value, CITY_MODEL_LIMITS.identifierCharacters);
}

function isRuleId(value: unknown): value is DesignSmellId {
  return CATALOG.some((rule) => rule.id === value);
}

function isLanguage(value: unknown): value is SourceLanguage {
  return SOURCE_LANGUAGES.includes(value as SourceLanguage);
}

function ruleById(id: DesignSmellId): DesignSmellRuleDefinition {
  return CATALOG.find((rule) => rule.id === id)!;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateDesignSmellConfiguration(
  value: unknown,
): asserts value is DesignSmellConfiguration {
  const candidate = record(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      "protocolVersion",
      "ruleCatalogVersion",
      "preset",
      "rules",
    ]) ||
    candidate["protocolVersion"] !== DESIGN_SMELL_PROTOCOL_VERSION ||
    candidate["ruleCatalogVersion"] !==
      DESIGN_SMELL_RULE_CATALOG_VERSION ||
    (candidate["preset"] !== "balanced" &&
      candidate["preset"] !== "strict") ||
    !Array.isArray(candidate["rules"]) ||
    candidate["rules"].length !== CATALOG.length
  ) {
    throw new TypeError(
      "The design-smell configuration has an unsupported schema or version.",
    );
  }
  candidate["rules"].forEach((selection, index) => {
    const item = record(selection);
    const expectedRule = CATALOG[index]!;
    if (
      !item ||
      !exactKeys(item, [
        "id",
        "enabled",
        ...(item["thresholds"] === undefined ? [] : ["thresholds"]),
      ]) ||
      item["id"] !== expectedRule.id ||
      typeof item["enabled"] !== "boolean" ||
      (expectedRule.availability === "unavailable" &&
        item["enabled"] !== false)
    ) {
      throw new TypeError(
        "Design-smell rule selections must contain the complete catalog " +
          "in canonical order.",
      );
    }
    if (item["thresholds"] !== undefined) {
      const thresholds = record(item["thresholds"]);
      if (
        !thresholds ||
        Object.keys(thresholds).some(
          (language) => !isLanguage(language),
        ) ||
        Object.values(thresholds).some(
          (threshold) =>
            !Number.isSafeInteger(threshold) ||
            Number(threshold) < 1 ||
            Number(threshold) > DESIGN_SMELL_LIMITS.threshold,
        )
      ) {
        throw new TypeError(
          "Design-smell thresholds must be bounded positive integers.",
        );
      }
    }
  });
}

export function validateDesignSmellSuppression(
  value: unknown,
): asserts value is DesignSmellSuppression {
  const candidate = record(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      "protocolVersion",
      "buildingId",
      "ruleId",
      "reason",
    ]) ||
    candidate["protocolVersion"] !== DESIGN_SMELL_PROTOCOL_VERSION ||
    !validModelId(candidate["buildingId"]) ||
    !isRuleId(candidate["ruleId"]) ||
    !validBoundedText(
      candidate["reason"],
      DESIGN_SMELL_LIMITS.suppressionReasonCharacters,
    )
  ) {
    throw new TypeError(
      "The design-smell suppression has an unsupported schema or invalid values.",
    );
  }
}

function thresholdFor(
  rule: DesignSmellRuleDefinition,
  selection: DesignSmellRuleSelection,
): Readonly<Record<SourceLanguage, number>> | undefined {
  if (!rule.threshold) return undefined;
  const overrides = selection.thresholds ?? {};
  return Object.freeze({
    csharp: overrides.csharp ?? rule.threshold.csharp,
    typescript: overrides.typescript ?? rule.threshold.typescript,
    javascript: overrides.javascript ?? rule.threshold.javascript,
  });
}

function unavailable(reason: string): DesignSmellLanguageAvailability {
  return Object.freeze({ availability: "unavailable", reason });
}

function available(
  reason?: string,
): DesignSmellLanguageAvailability {
  return Object.freeze({
    availability: "available",
    ...(reason === undefined ? {} : { reason }),
  });
}

function languageLabel(language: SourceLanguage): string {
  switch (language) {
    case "csharp":
      return "C#";
    case "typescript":
      return "TypeScript";
    case "javascript":
      return "JavaScript";
  }
}

function availabilityForRule(
  rule: DesignSmellRuleDefinition,
  buildings: readonly CityBuilding[],
): Readonly<
  Record<SourceLanguage, DesignSmellLanguageAvailability>
> {
  const byLanguage = Object.fromEntries(
    SOURCE_LANGUAGES.map((language) => {
      if (rule.availability === "unavailable") {
        return [
          language,
          unavailable(rule.unavailableReason!),
        ] as const;
      }
      const matching = buildings.filter(
        (building) => building.language === language,
      );
      if (matching.length === 0) {
        return [
          language,
          unavailable(
            `This city contains no ${languageLabel(language)} source files.`,
          ),
        ] as const;
      }
      if (
        language === "csharp" &&
        (rule.id === "excessive-coupling" ||
          rule.id === "dependency-cycle")
      ) {
        return [
          language,
          unavailable(CSHARP_DEPENDENCY_UNAVAILABLE),
        ] as const;
      }
      if (rule.id === "high-complexity-method") {
        const missing = matching.filter(
          (building) => building.units === undefined,
        ).length;
        if (missing === matching.length) {
          return [
            language,
            unavailable(
              `Executable-unit complexity facts are not recorded for ` +
                `${languageLabel(language)} source files in this city.`,
            ),
          ] as const;
        }
        if (missing > 0) {
          return [
            language,
            available(
              `${missing.toLocaleString("en-US")} source files without ` +
                "executable-unit facts are omitted.",
            ),
          ] as const;
        }
      }
      return [language, available()] as const;
    }),
  );
  return Object.freeze(
    byLanguage as Record<
      SourceLanguage,
      DesignSmellLanguageAvailability
    >,
  );
}

function severity(
  value: number,
  threshold: number,
): DesignSmellSeverity {
  return value >= threshold * 2
    ? "critical"
    : value >= threshold * 1.35
      ? "high"
      : "moderate";
}

function suppressionMap(
  suppressions: readonly DesignSmellSuppression[],
): Map<string, DesignSmellSuppression> {
  if (suppressions.length > DESIGN_SMELL_LIMITS.suppressions) {
    throw new RangeError(
      `At most ${DESIGN_SMELL_LIMITS.suppressions} ` +
        "design-smell suppressions are allowed.",
    );
  }
  const result = new Map<string, DesignSmellSuppression>();
  for (const suppression of suppressions) {
    validateDesignSmellSuppression(suppression);
    const identity =
      `${suppression.buildingId}\u0000${suppression.ruleId}`;
    if (result.has(identity)) {
      throw new TypeError(
        "Design-smell suppressions must be unique by building and rule.",
      );
    }
    result.set(identity, suppression);
  }
  return result;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

class FindingIdAllocator {
  readonly #signaturesById = new Map<string, string>();

  public allocate(
    ruleId: DesignSmellId,
    signature: string,
  ): string {
    const base = `smell:${ruleId}:${fnv1a64(signature)}`;
    let candidate = base;
    let collision = 0;
    while (true) {
      const existing = this.#signaturesById.get(candidate);
      if (existing === undefined) {
        this.#signaturesById.set(candidate, signature);
        return candidate;
      }
      if (existing === signature) {
        collision += 1;
      } else {
        collision += 1;
      }
      candidate = `${base}-${collision}`;
      if (
        candidate.length > DESIGN_SMELL_LIMITS.findingIdCharacters
      ) {
        throw new RangeError(
          "Design-smell finding ID collision space was exhausted.",
        );
      }
    }
  }
}

function finding(
  rule: DesignSmellRuleDefinition,
  building: CityBuilding,
  evidence: DesignSmellEvidence,
  discriminator: string,
  suppressions: ReadonlyMap<string, DesignSmellSuppression>,
  ids: FindingIdAllocator,
): DesignSmellFinding {
  const suppression = suppressions.get(
    `${building.id}\u0000${rule.id}`,
  );
  const signature = JSON.stringify({
    ruleId: rule.id,
    buildingId: building.id,
    discriminator,
    evidence,
  });
  return Object.freeze({
    id: ids.allocate(rule.id, signature),
    buildingId: building.id,
    language: building.language,
    ruleId: rule.id,
    ruleName: rule.name,
    ruleVersion: rule.version,
    severity: severity(evidence.value, evidence.threshold),
    evidence: Object.freeze({
      ...evidence,
      ...(evidence.relatedBuildingIds === undefined
        ? {}
        : {
            relatedBuildingIds: Object.freeze(
              [...evidence.relatedBuildingIds].sort(),
            ),
          }),
    }),
    suppressed: suppression !== undefined,
    ...(suppression === undefined
      ? {}
      : { suppressionReason: suppression.reason }),
  });
}

function sourceFileDependencyGraph(model: CityModel): {
  readonly outgoing: ReadonlyMap<string, ReadonlySet<string>>;
  readonly cycles: ReadonlyMap<string, readonly string[]>;
} {
  const ids = new Set(model.buildings.map(({ id }) => id));
  const languagesById = new Map(
    model.buildings.map(({ id, language }) => [id, language]),
  );
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const id of ids) {
    outgoing.set(id, new Set());
    incoming.set(id, new Set());
  }
  for (const dependency of model.dependencies) {
    if (
      dependency.kind !== "typescript-import" ||
      !ids.has(dependency.sourceId) ||
      languagesById.get(dependency.sourceId) === "csharp"
    ) {
      continue;
    }
    const target =
      dependency.targetId ??
      dependency.externalTarget ??
      dependency.id;
    outgoing.get(dependency.sourceId)!.add(target);
    if (dependency.targetId && ids.has(dependency.targetId)) {
      incoming.get(dependency.targetId)!.add(dependency.sourceId);
    }
  }

  const internalOutgoing = new Map<string, readonly string[]>();
  for (const [id, targets] of outgoing) {
    internalOutgoing.set(
      id,
      Object.freeze(
        [...targets].filter((target) => ids.has(target)).sort(),
      ),
    );
  }

  const visited = new Set<string>();
  const order: string[] = [];
  for (const root of [...ids].sort()) {
    if (visited.has(root)) continue;
    const stack: Array<{ id: string; next: number }> = [
      { id: root, next: 0 },
    ];
    visited.add(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const targets = internalOutgoing.get(frame.id)!;
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        if (!visited.has(target)) {
          visited.add(target);
          stack.push({ id: target, next: 0 });
        }
      } else {
        order.push(frame.id);
        stack.pop();
      }
    }
  }

  const assigned = new Set<string>();
  const cycles = new Map<string, readonly string[]>();
  for (const root of order.reverse()) {
    if (assigned.has(root)) continue;
    const component: string[] = [];
    const stack = [root];
    assigned.add(root);
    while (stack.length > 0) {
      const id = stack.pop()!;
      component.push(id);
      for (const previous of incoming.get(id)!) {
        if (!assigned.has(previous)) {
          assigned.add(previous);
          stack.push(previous);
        }
      }
    }
    const selfCycle = internalOutgoing.get(root)!.includes(root);
    if (component.length > 1 || selfCycle) {
      const canonical = Object.freeze(component.sort());
      for (const id of canonical) cycles.set(id, canonical);
    }
  }

  return {
    outgoing,
    cycles,
  };
}

function findingOrder(
  left: DesignSmellFinding,
  right: DesignSmellFinding,
): number {
  return (
    compareText(left.buildingId, right.buildingId) ||
    (left.evidence.line ?? 0) - (right.evidence.line ?? 0) ||
    compareText(left.id, right.id)
  );
}

export function evaluateDesignSmells(
  model: CityModel,
  configuration:
    DesignSmellConfiguration = DEFAULT_DESIGN_SMELL_CONFIGURATION,
  suppressions: readonly DesignSmellSuppression[] = [],
): DesignSmellEvaluation {
  validateDesignSmellConfiguration(configuration);
  if (model.buildings.length > DESIGN_SMELL_LIMITS.buildings) {
    throw new RangeError(
      `Design-smell evaluation accepts at most ` +
        `${DESIGN_SMELL_LIMITS.buildings} buildings.`,
    );
  }

  const suppressionByIdentity = suppressionMap(suppressions);
  const graph = sourceFileDependencyGraph(model);
  const sortedBuildings = [...model.buildings].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const ids = new FindingIdAllocator();
  const results: DesignSmellRuleResult[] = [];
  const all: DesignSmellFinding[] = [];

  for (const [ruleIndex, rule] of CATALOG.entries()) {
    const selection = configuration.rules[ruleIndex]!;
    const thresholds = thresholdFor(rule, selection);
    const languageAvailability = availabilityForRule(
      rule,
      sortedBuildings,
    );
    const availableLanguages = SOURCE_LANGUAGES.filter(
      (language) =>
        languageAvailability[language].availability === "available",
    );
    const resultAvailability =
      availableLanguages.length > 0 ? "available" : "unavailable";
    const resultReason =
      resultAvailability === "unavailable"
        ? (rule as DesignSmellRuleDefinition).unavailableReason ??
          "No language in this city has the facts required by this rule."
        : undefined;
    const matches: DesignSmellFinding[] = [];

    if (
      rule.availability === "available" &&
      selection.enabled &&
      thresholds
    ) {
      for (const building of sortedBuildings) {
        if (
          languageAvailability[building.language].availability !==
          "available"
        ) {
          continue;
        }
        const threshold = thresholds[building.language];
        if (rule.id === "high-complexity-method") {
          const occurrences = new Map<string, number>();
          for (const unit of building.units ?? []) {
            if (unit.complexity < threshold) continue;
            const unitSignature = JSON.stringify({
              name: unit.name,
              line: unit.line,
              endLine: unit.endLine ?? unit.line,
              complexity: unit.complexity,
            });
            const occurrence = occurrences.get(unitSignature) ?? 0;
            occurrences.set(unitSignature, occurrence + 1);
            matches.push(
              finding(
                rule,
                building,
                {
                  kind: "executable-unit",
                  label: "Cyclomatic complexity",
                  subject: unit.name,
                  value: unit.complexity,
                  threshold,
                  unit: "complexity",
                  line: unit.line,
                  ...(unit.endLine === undefined
                    ? {}
                    : { endLine: unit.endLine }),
                },
                `unit:${unitSignature}:${occurrence}`,
                suppressionByIdentity,
                ids,
              ),
            );
          }
        } else if (
          rule.id === "oversized-file" &&
          building.metrics.sloc >= threshold
        ) {
          matches.push(
            finding(
              rule,
              building,
              {
                kind: "metric",
                label: "Source lines of code",
                value: building.metrics.sloc,
                threshold,
                unit: "SLOC",
              },
              "file",
              suppressionByIdentity,
              ids,
            ),
          );
        } else if (rule.id === "excessive-coupling") {
          const value = graph.outgoing.get(building.id)?.size ?? 0;
          if (value >= threshold) {
            matches.push(
              finding(
                rule,
                building,
                {
                  kind: "dependency",
                  label: "Distinct attributable outgoing dependencies",
                  value,
                  threshold,
                  unit: "dependencies",
                },
                "outgoing",
                suppressionByIdentity,
                ids,
              ),
            );
          }
        } else if (rule.id === "dependency-cycle") {
          const members = graph.cycles.get(building.id);
          if (members && members.length >= threshold) {
            matches.push(
              finding(
                rule,
                building,
                {
                  kind: "cycle",
                  label: "Source-file dependency cycle size",
                  value: members.length,
                  threshold,
                  unit: "source files",
                  relatedBuildingIds: members,
                },
                `cycle:${members.join("\u0000")}`,
                suppressionByIdentity,
                ids,
              ),
            );
          }
        }
        if (all.length + matches.length > DESIGN_SMELL_LIMITS.findings) {
          throw new RangeError(
            `Design-smell evaluation exceeded ` +
              `${DESIGN_SMELL_LIMITS.findings} findings.`,
          );
        }
      }
    }

    matches.sort(findingOrder);
    all.push(...matches);
    results.push(
      Object.freeze({
        rule,
        enabled: selection.enabled,
        availability: resultAvailability,
        ...(resultReason === undefined ? {} : { reason: resultReason }),
        languageAvailability,
        ...(thresholds === undefined
          ? {}
          : { threshold: thresholds }),
        findings: Object.freeze(matches),
      }),
    );
  }

  const counts = Object.fromEntries(
    CATALOG.map((rule) => [
      rule.id,
      all.filter(
        (finding) =>
          finding.ruleId === rule.id && !finding.suppressed,
      ).length,
    ]),
  ) as Record<DesignSmellId, number>;
  return Object.freeze({
    protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
    ruleCatalogVersion: DESIGN_SMELL_RULE_CATALOG_VERSION,
    results: Object.freeze(results),
    findings: Object.freeze(all),
    visibleFindings: Object.freeze(
      all.filter((finding) => !finding.suppressed),
    ),
    counts: Object.freeze(counts),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateLanguageAvailability(
  value: unknown,
): asserts value is Readonly<
  Record<SourceLanguage, DesignSmellLanguageAvailability>
> {
  const candidate = record(value);
  if (
    !candidate ||
    !exactKeys(candidate, SOURCE_LANGUAGES)
  ) {
    throw new TypeError(
      "Design-smell language availability must cover every language.",
    );
  }
  for (const language of SOURCE_LANGUAGES) {
    const entry = record(candidate[language]);
    if (
      !entry ||
      !exactKeys(entry, [
        "availability",
        ...(entry["reason"] === undefined ? [] : ["reason"]),
      ]) ||
      (entry["availability"] !== "available" &&
        entry["availability"] !== "unavailable") ||
      (entry["availability"] === "unavailable" &&
        !validBoundedText(
          entry["reason"],
          CITY_MODEL_LIMITS.textCharacters,
        )) ||
      (entry["reason"] !== undefined &&
        !validBoundedText(
          entry["reason"],
          CITY_MODEL_LIMITS.textCharacters,
        ))
    ) {
      throw new TypeError(
        "Design-smell language availability is invalid.",
      );
    }
  }
}

function validateEvidence(
  value: unknown,
  ruleId: DesignSmellId,
): asserts value is DesignSmellEvidence {
  const evidence = record(value);
  if (!evidence) {
    throw new TypeError("Design-smell evidence must be an object.");
  }
  const optionalKeys = [
    "unit",
    "subject",
    "line",
    "endLine",
    "relatedBuildingIds",
  ].filter((key) => evidence[key] !== undefined);
  if (
    !exactKeys(evidence, [
      "kind",
      "label",
      "value",
      "threshold",
      ...optionalKeys,
    ]) ||
    ![
      "metric",
      "executable-unit",
      "dependency",
      "cycle",
    ].includes(String(evidence["kind"])) ||
    !validBoundedText(
      evidence["label"],
      CITY_MODEL_LIMITS.displayTextCharacters,
    ) ||
    !Number.isSafeInteger(evidence["value"]) ||
    Number(evidence["value"]) < 0 ||
    !Number.isSafeInteger(evidence["threshold"]) ||
    Number(evidence["threshold"]) < 1 ||
    Number(evidence["threshold"]) > DESIGN_SMELL_LIMITS.threshold ||
    Number(evidence["value"]) < Number(evidence["threshold"]) ||
    (evidence["unit"] !== undefined &&
      !validBoundedText(
        evidence["unit"],
        CITY_MODEL_LIMITS.displayTextCharacters,
      )) ||
    (evidence["subject"] !== undefined &&
      !validBoundedText(
        evidence["subject"],
        CITY_MODEL_LIMITS.displayTextCharacters,
      ))
  ) {
    throw new TypeError("Design-smell evidence values are invalid.");
  }
  const kind = evidence["kind"];
  if (
    (ruleId === "high-complexity-method" &&
      kind !== "executable-unit") ||
    (ruleId === "oversized-file" && kind !== "metric") ||
    (ruleId === "excessive-coupling" && kind !== "dependency") ||
    (ruleId === "dependency-cycle" && kind !== "cycle") ||
    (kind === "executable-unit" &&
      (!Number.isSafeInteger(evidence["line"]) ||
        Number(evidence["line"]) < 1 ||
        !validBoundedText(
          evidence["subject"],
          CITY_MODEL_LIMITS.displayTextCharacters,
        ))) ||
    (kind !== "executable-unit" &&
      (evidence["line"] !== undefined ||
        evidence["endLine"] !== undefined ||
        evidence["subject"] !== undefined)) ||
    (evidence["endLine"] !== undefined &&
      (!Number.isSafeInteger(evidence["endLine"]) ||
        Number(evidence["endLine"]) < Number(evidence["line"]))) ||
    (kind === "cycle" &&
      (!Array.isArray(evidence["relatedBuildingIds"]) ||
        evidence["relatedBuildingIds"].length < 1 ||
        evidence["relatedBuildingIds"].length >
          DESIGN_SMELL_LIMITS.evidenceRelatedBuildingIds ||
        evidence["relatedBuildingIds"].length !== evidence["value"])) ||
    (kind !== "cycle" &&
      evidence["relatedBuildingIds"] !== undefined)
  ) {
    throw new TypeError(
      "Design-smell evidence does not match its rule and kind.",
    );
  }
  if (Array.isArray(evidence["relatedBuildingIds"])) {
    const ids = evidence["relatedBuildingIds"];
    if (
      ids.some((id) => !validModelId(id)) ||
      ids.some((id, index) => index > 0 && ids[index - 1]! >= id)
    ) {
      throw new TypeError(
        "Related building IDs must be unique and canonically ordered.",
      );
    }
  }
}

function validateFinding(
  value: unknown,
  expectedRuleId?: DesignSmellId,
): asserts value is DesignSmellFinding {
  const finding = record(value);
  if (!finding) {
    throw new TypeError("Design-smell finding must be an object.");
  }
  if (
    !exactKeys(finding, [
      "id",
      "buildingId",
      "language",
      "ruleId",
      "ruleName",
      "ruleVersion",
      "severity",
      "evidence",
      "suppressed",
      ...(finding["suppressionReason"] === undefined
        ? []
        : ["suppressionReason"]),
    ]) ||
    !validBoundedText(
      finding["id"],
      DESIGN_SMELL_LIMITS.findingIdCharacters,
    ) ||
    !/^smell:[a-z-]+:[0-9a-f]{16}(?:-[1-9][0-9]*)?$/u.test(
      String(finding["id"]),
    ) ||
    !validModelId(finding["buildingId"]) ||
    !isLanguage(finding["language"]) ||
    !isRuleId(finding["ruleId"]) ||
    (expectedRuleId !== undefined &&
      finding["ruleId"] !== expectedRuleId) ||
    finding["ruleName"] !== ruleById(finding["ruleId"] as DesignSmellId).name ||
    finding["ruleVersion"] !==
      ruleById(finding["ruleId"] as DesignSmellId).version ||
    !["moderate", "high", "critical"].includes(
      String(finding["severity"]),
    ) ||
    typeof finding["suppressed"] !== "boolean" ||
    (finding["suppressed"] === true &&
      !validBoundedText(
        finding["suppressionReason"],
        DESIGN_SMELL_LIMITS.suppressionReasonCharacters,
      )) ||
    (finding["suppressed"] === false &&
      finding["suppressionReason"] !== undefined)
  ) {
    throw new TypeError(
      "The design-smell evaluation contains an invalid finding.",
    );
  }
  validateEvidence(finding["evidence"], finding["ruleId"] as DesignSmellId);
  const evidence = finding["evidence"] as DesignSmellEvidence;
  if (
    evidence.kind === "cycle" &&
    !evidence.relatedBuildingIds!.includes(
      finding["buildingId"] as string,
    )
  ) {
    throw new TypeError(
      "A dependency-cycle finding must include its affected building.",
    );
  }
  if (
    finding["severity"] !== severity(evidence.value, evidence.threshold)
  ) {
    throw new TypeError(
      "Design-smell finding severity does not match its evidence.",
    );
  }
}

export function validateDesignSmellEvaluation(
  value: unknown,
  configuration?: DesignSmellConfiguration,
): asserts value is DesignSmellEvaluation {
  const effectiveConfiguration =
    configuration ?? DEFAULT_DESIGN_SMELL_CONFIGURATION;
  validateDesignSmellConfiguration(effectiveConfiguration);
  const candidate = record(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      "protocolVersion",
      "ruleCatalogVersion",
      "results",
      "findings",
      "visibleFindings",
      "counts",
    ]) ||
    candidate["protocolVersion"] !== DESIGN_SMELL_PROTOCOL_VERSION ||
    candidate["ruleCatalogVersion"] !==
      DESIGN_SMELL_RULE_CATALOG_VERSION ||
    !Array.isArray(candidate["results"]) ||
    candidate["results"].length !== CATALOG.length ||
    !Array.isArray(candidate["findings"]) ||
    candidate["findings"].length > DESIGN_SMELL_LIMITS.findings ||
    !Array.isArray(candidate["visibleFindings"]) ||
    candidate["visibleFindings"].length > candidate["findings"].length
  ) {
    throw new TypeError(
      "The design-smell evaluation has an unsupported schema or bounds.",
    );
  }

  const flattened: DesignSmellFinding[] = [];
  candidate["results"].forEach((value, index) => {
    const result = record(value);
    const expectedRule = CATALOG[index]!;
    if (
      !result ||
      !exactKeys(result, [
        "rule",
        "enabled",
        "availability",
        ...(result["reason"] === undefined ? [] : ["reason"]),
        "languageAvailability",
        ...(result["threshold"] === undefined ? [] : ["threshold"]),
        "findings",
      ]) ||
      !sameJson(result["rule"], expectedRule) ||
      typeof result["enabled"] !== "boolean" ||
      (result["availability"] !== "available" &&
        result["availability"] !== "unavailable") ||
      (result["availability"] === "available" &&
        result["reason"] !== undefined) ||
      (result["availability"] === "unavailable" &&
        !validBoundedText(
          result["reason"],
          CITY_MODEL_LIMITS.textCharacters,
        )) ||
      (result["reason"] !== undefined &&
        !validBoundedText(
          result["reason"],
          CITY_MODEL_LIMITS.textCharacters,
        )) ||
      !Array.isArray(result["findings"])
    ) {
      throw new TypeError(
        "Design-smell rule results are not canonical.",
      );
    }
    validateLanguageAvailability(result["languageAvailability"]);
    const languageAvailability =
      result["languageAvailability"] as Readonly<
        Record<SourceLanguage, DesignSmellLanguageAvailability>
      >;
    const expectedAvailability = SOURCE_LANGUAGES.some(
      (language) =>
        languageAvailability[language].availability === "available",
    )
      ? "available"
      : "unavailable";
    if (result["availability"] !== expectedAvailability) {
      throw new TypeError(
        "Design-smell rule availability is inconsistent.",
      );
    }
    if (
      expectedRule.availability === "unavailable" &&
      SOURCE_LANGUAGES.some(
        (language) =>
          languageAvailability[language].availability !==
          "unavailable",
      )
    ) {
      throw new TypeError(
        "A catalog-unavailable rule cannot claim language availability.",
      );
    }
    const expectedSelection =
      effectiveConfiguration.rules[index]!;
    if (result["enabled"] !== expectedSelection.enabled) {
      throw new TypeError(
        "Design-smell result enabled state does not match configuration.",
      );
    }
    if (
      result["enabled"] === false &&
      result["findings"].length !== 0
    ) {
      throw new TypeError(
        "A disabled design-smell rule cannot return findings.",
      );
    }
    if (
      result["availability"] === "unavailable" &&
      result["findings"].length !== 0
    ) {
      throw new TypeError(
        "An unavailable design-smell rule cannot return findings.",
      );
    }
    if (
      (expectedRule as DesignSmellRuleDefinition).threshold ===
      undefined
    ) {
      if (result["threshold"] !== undefined) {
        throw new TypeError(
          "A rule without thresholds returned threshold data.",
        );
      }
    } else {
      const thresholds = record(result["threshold"]);
      if (
        !thresholds ||
        !exactKeys(thresholds, SOURCE_LANGUAGES) ||
        SOURCE_LANGUAGES.some(
          (language) =>
            !Number.isSafeInteger(thresholds[language]) ||
            Number(thresholds[language]) < 1 ||
            Number(thresholds[language]) >
              DESIGN_SMELL_LIMITS.threshold,
        )
      ) {
        throw new TypeError(
          "Design-smell result thresholds are invalid.",
        );
      }
      if (
        !sameJson(
          thresholds,
          thresholdFor(
            expectedRule as DesignSmellRuleDefinition,
            expectedSelection,
          ),
        )
      ) {
        throw new TypeError(
          "Design-smell result thresholds do not match configuration.",
        );
      }
    }
    let previous: DesignSmellFinding | undefined;
    for (const finding of result["findings"]) {
      validateFinding(finding, expectedRule.id);
      const typed = finding as DesignSmellFinding;
      if (
        previous !== undefined &&
        findingOrder(previous, typed) >= 0
      ) {
        throw new TypeError(
          "Design-smell findings are not uniquely ordered.",
        );
      }
      if (
        languageAvailability[typed.language].availability !==
        "available"
      ) {
        throw new TypeError(
          "A finding uses a language unavailable to its rule.",
        );
      }
      const resultThresholds = result["threshold"] as
        | Record<SourceLanguage, number>
        | undefined;
      if (
        resultThresholds !== undefined &&
        typed.evidence.threshold !==
          resultThresholds[typed.language]
      ) {
        throw new TypeError(
          "Finding evidence threshold does not match its rule and language.",
        );
      }
      previous = typed;
      flattened.push(typed);
    }
  });

  if (!sameJson(candidate["findings"], flattened)) {
    throw new TypeError(
      "Top-level design-smell findings do not match rule results.",
    );
  }
  const ids = new Set<string>();
  for (const finding of candidate["findings"]) {
    validateFinding(finding);
    const typed = finding as DesignSmellFinding;
    if (ids.has(typed.id)) {
      throw new TypeError("Design-smell finding IDs must be unique.");
    }
    ids.add(typed.id);
  }
  const expectedVisible = flattened.filter(
    (finding) => !finding.suppressed,
  );
  if (!sameJson(candidate["visibleFindings"], expectedVisible)) {
    throw new TypeError(
      "Visible findings must exactly exclude suppressed findings.",
    );
  }

  const counts = record(candidate["counts"]);
  if (!counts || !exactKeys(counts, CATALOG.map((rule) => rule.id))) {
    throw new TypeError(
      "Design-smell counts must cover the complete catalog.",
    );
  }
  for (const rule of CATALOG) {
    const expected = expectedVisible.filter(
      (finding) => finding.ruleId === rule.id,
    ).length;
    if (
      !Number.isSafeInteger(counts[rule.id]) ||
      counts[rule.id] !== expected
    ) {
      throw new TypeError(
        "Design-smell counts do not match visible findings.",
      );
    }
  }
}
