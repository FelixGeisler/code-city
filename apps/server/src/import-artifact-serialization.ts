import {
  iterateCanonicalEvolutionBundleBytes,
  iteratePreparedEvolutionBundleBytes,
  validateCityModel,
  type PreparedEvolutionSerialization,
} from "../../../packages/core/src/index.js";
import {
  IMPORT_CITY_MODEL_MAX_BYTES,
  IMPORT_EVOLUTION_MAX_BYTES,
  ImportArtifactStoreError,
} from "./import-artifact-contract.js";

export function publicationCheckpoint(
  signal?: AbortSignal,
  checkpoint?: () => void,
): void {
  signal?.throwIfAborted();
  checkpoint?.();
  signal?.throwIfAborted();
}

export function serializeValidatedCityModel(
  value: unknown,
  signal?: AbortSignal,
  checkpoint?: () => void,
): Buffer {
  let serialized: string;
  let propertiesSinceCheckpoint = 0;
  try {
    publicationCheckpoint(signal, checkpoint);
    const result = JSON.stringify(value, (_key, item) => {
      propertiesSinceCheckpoint += 1;
      if (propertiesSinceCheckpoint >= 256) {
        propertiesSinceCheckpoint = 0;
        publicationCheckpoint(signal, checkpoint);
      }
      return item;
    }, 2);
    publicationCheckpoint(signal, checkpoint);
    if (result === undefined) throw new TypeError("Not JSON serializable.");
    serialized = result;
  } catch (error) {
    publicationCheckpoint(signal, checkpoint);
    throw new ImportArtifactStoreError(
      "CITY_MODEL_INVALID",
      "City model could not be serialized as JSON.",
      { cause: error },
    );
  }

  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  publicationCheckpoint(signal, checkpoint);
  if (bytes.byteLength > IMPORT_CITY_MODEL_MAX_BYTES) {
    throw new ImportArtifactStoreError(
      "CITY_MODEL_TOO_LARGE",
      `City model exceeds the ${IMPORT_CITY_MODEL_MAX_BYTES}-byte limit.`,
    );
  }
  try {
    const parsed = JSON.parse(serialized) as unknown;
    publicationCheckpoint(signal, checkpoint);
    validateCityModel(parsed, {
      checkpoint: () => publicationCheckpoint(signal, checkpoint),
    });
    publicationCheckpoint(signal, checkpoint);
  } catch (error) {
    publicationCheckpoint(signal, checkpoint);
    throw new ImportArtifactStoreError(
      "CITY_MODEL_INVALID",
      "City model failed schema validation.",
      { cause: error },
    );
  }
  return bytes;
}

function evolutionSerializationError(error: unknown): ImportArtifactStoreError {
  if (error instanceof ImportArtifactStoreError) return error;
  if (error instanceof Error && error.message.includes("serialized bundle must not exceed")) {
    return new ImportArtifactStoreError(
      "EVOLUTION_TOO_LARGE",
      `Evolution bundle exceeds the ${IMPORT_EVOLUTION_MAX_BYTES}-byte limit.`,
      { cause: error },
    );
  }
  return new ImportArtifactStoreError(
    "EVOLUTION_INVALID",
    "Evolution bundle failed schema validation.",
    { cause: error },
  );
}

export function prepareEvolutionSerialization(
  value: unknown,
  signal?: AbortSignal,
  prepared?: PreparedEvolutionSerialization,
  checkpoint?: () => void,
): { readonly chunks: Iterable<Uint8Array>; readonly expectedBytes?: number } {
  try {
    if (prepared !== undefined && prepared.bundle !== value) {
      throw new TypeError("Prepared evolution serialization does not match the supplied bundle.");
    }
    const iterationOptions = signal === undefined && checkpoint === undefined
      ? {}
      : { checkpoint: () => publicationCheckpoint(signal, checkpoint) };
    return Object.freeze({
      chunks: prepared === undefined
        ? iterateCanonicalEvolutionBundleBytes(value, iterationOptions)
        : iteratePreparedEvolutionBundleBytes(prepared, iterationOptions),
      ...(prepared === undefined ? {} : { expectedBytes: prepared.measuredBytes }),
    });
  } catch (error) {
    publicationCheckpoint(signal, checkpoint);
    throw evolutionSerializationError(error);
  }
}

export async function* mappedEvolutionChunks(
  chunks: Iterable<Uint8Array>,
  signal?: AbortSignal,
  checkpoint?: () => void,
): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    for (const chunk of chunks) {
      publicationCheckpoint(signal, checkpoint);
      yield chunk;
    }
    publicationCheckpoint(signal, checkpoint);
  } catch (error) {
    publicationCheckpoint(signal, checkpoint);
    throw evolutionSerializationError(error);
  }
}
