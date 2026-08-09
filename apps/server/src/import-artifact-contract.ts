import { EVOLUTION_BUNDLE_LIMITS } from "../../../packages/core/src/index.js";

export const IMPORT_CITY_MODEL_MAX_BYTES = 128 * 1024 * 1024;
export const IMPORT_EVOLUTION_MAX_BYTES = EVOLUTION_BUNDLE_LIMITS.serializedBytes;

export type ImportArtifactStoreErrorCode =
  | "INVALID_TOKEN"
  | "FILESYSTEM_POLICY"
  | "CITY_MODEL_INVALID"
  | "CITY_MODEL_TOO_LARGE"
  | "EVOLUTION_INVALID"
  | "EVOLUTION_TOO_LARGE"
  | "ARTIFACT_ALREADY_EXISTS";

export class ImportArtifactStoreError extends Error {
  public override readonly name = "ImportArtifactStoreError";

  public constructor(
    public readonly code: ImportArtifactStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
