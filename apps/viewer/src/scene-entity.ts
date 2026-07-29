export const SCENE_ENTITY_KINDS = Object.freeze([
  "building",
  "district",
  "external",
] as const);

export type SceneEntityKind = (typeof SCENE_ENTITY_KINDS)[number];

export interface BuildingSceneEntity {
  readonly kind: "building";
  readonly id: string;
}

export interface DistrictSceneEntity {
  readonly kind: "district";
  readonly id: string;
}

export interface ExternalSceneEntity {
  readonly kind: "external";
  readonly id: string;
}

export type SceneEntity =
  | BuildingSceneEntity
  | DistrictSceneEntity
  | ExternalSceneEntity;

export type SceneEntityTransition =
  | {
      readonly kind: "unchanged";
      readonly current: SceneEntity | null;
    }
  | {
      readonly kind: "entered";
      readonly current: SceneEntity;
    }
  | {
      readonly kind: "cleared";
      readonly previous: SceneEntity;
    }
  | {
      readonly kind: "replaced";
      readonly previous: SceneEntity;
      readonly current: SceneEntity;
    };

const KEY_SEPARATOR = "\0";
const SCENE_ENTITY_KIND_SET = new Set<SceneEntityKind>(SCENE_ENTITY_KINDS);

/**
 * Creates a plain-text scene identity without trimming or normalizing its ID.
 * Model validation owns ID policy; this layer preserves the stable identity
 * byte-for-byte (in JavaScript UTF-16 code units).
 */
export function createSceneEntity<Kind extends SceneEntityKind>(
  kind: Kind,
  id: string,
): Extract<SceneEntity, { readonly kind: Kind }> {
  assertSceneEntityKind(kind);
  assertSceneEntityId(id);
  return Object.freeze({ kind, id }) as Extract<
    SceneEntity,
    { readonly kind: Kind }
  >;
}

/**
 * Keys retain the existing `kind + NUL + ID` scene convention. Only the first
 * NUL is structural, so IDs may themselves contain delimiters or hostile text.
 */
export function encodeSceneEntityKey(entity: SceneEntity): string {
  assertSceneEntityKind(entity?.kind);
  assertSceneEntityId(entity?.id);
  return `${entity.kind}${KEY_SEPARATOR}${entity.id}`;
}

/**
 * Parses only canonical scene keys. Malformed or unknown values fail closed.
 */
export function decodeSceneEntityKey(value: unknown): SceneEntity | null {
  if (typeof value !== "string") {
    return null;
  }
  const separator = value.indexOf(KEY_SEPARATOR);
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }
  const kind = value.slice(0, separator);
  if (!isSceneEntityKind(kind)) {
    return null;
  }
  return createSceneEntity(kind, value.slice(separator + 1));
}

export function sameSceneEntity(
  left: SceneEntity | null,
  right: SceneEntity | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.kind === right.kind &&
      left.id === right.id)
  );
}

/**
 * Describes the state change once so hover and selection owners can update
 * highlights, labels, and inspector state without stringly typed branching.
 */
export function transitionSceneEntity(
  previous: SceneEntity | null,
  current: SceneEntity | null,
): SceneEntityTransition {
  if (sameSceneEntity(previous, current)) {
    return Object.freeze({ kind: "unchanged", current: previous });
  }
  if (previous === null) {
    return Object.freeze({ kind: "entered", current: current! });
  }
  if (current === null) {
    return Object.freeze({ kind: "cleared", previous });
  }
  return Object.freeze({ kind: "replaced", previous, current });
}

export function isSceneEntityKind(value: unknown): value is SceneEntityKind {
  return (
    typeof value === "string" &&
    SCENE_ENTITY_KIND_SET.has(value as SceneEntityKind)
  );
}

function assertSceneEntityKind(
  value: unknown,
): asserts value is SceneEntityKind {
  if (!isSceneEntityKind(value)) {
    throw new TypeError(`Unknown scene entity kind "${String(value)}".`);
  }
}

function assertSceneEntityId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Scene entity ID must be a non-empty string.");
  }
}
