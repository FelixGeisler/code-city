import type {
  PrintExportTransferArtifact,
} from "./print-export-protocol.js";

export interface PrintExportName {
  readonly title?: string;
  readonly version?: string;
}

export interface PrintExportFileNames {
  readonly artifact: string;
  readonly legend: string;
}

export interface PrintCalibrationFileNames {
  readonly artifact: string;
  readonly manifest: string;
}

export interface PrintExportDownloadInput {
  readonly artifact: PrintExportTransferArtifact;
  readonly legendBytes?: ArrayBuffer;
}

export interface PrintExportDownload {
  readonly fileName: string;
  readonly url: string;
  readonly blob: Blob;
}

export interface PrintExportDownloads {
  readonly artifact: PrintExportDownload;
  readonly legend?: PrintExportDownload;
}

export interface PrintCalibrationDownloadInput {
  readonly artifact: PrintExportTransferArtifact;
  readonly manifestBytes: ArrayBuffer;
}

export interface PrintCalibrationDownloads {
  readonly artifact: PrintExportDownload;
  readonly manifest: PrintExportDownload;
}

export type PrintDownloadPublication =
  | {
      readonly ok: true;
      readonly downloads: PrintExportDownloads;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

export type PrintCalibrationDownloadPublication =
  | {
      readonly ok: true;
      readonly downloads: PrintCalibrationDownloads;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

export interface ObjectUrlApi {
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
}

const RESERVED_WINDOWS_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MAX_STEM_CODE_POINTS = 96;

function trimUnsafeEdges(value: string): string {
  return value
    .replace(/^[\s._-]+/u, "")
    .replace(/[\s._-]+$/u, "");
}

export function sanitizePrintFileStem(value: string): string {
  let stem = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/gu, "-")
    .replace(/\.{2,}/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-");
  stem = trimUnsafeEdges(stem);
  stem = [...stem].slice(0, MAX_STEM_CODE_POINTS).join("");
  stem = trimUnsafeEdges(stem);
  if (stem.length === 0) stem = "code-city";
  if (RESERVED_WINDOWS_NAME.test(stem)) {
    stem = `code-city-${stem}`;
  }
  return stem;
}

export function printExportFileNames(
  name: PrintExportName,
  fileExtension: PrintExportTransferArtifact["fileExtension"] = ".3mf",
): PrintExportFileNames {
  const parts = [name.title, name.version]
    .filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0,
    )
    .join("-");
  const stem = sanitizePrintFileStem(parts);
  return {
    artifact: `${stem}${fileExtension}`,
    legend: `${stem}.legend.json`,
  };
}

export function printCalibrationFileNames(
  profileId: string,
  fileExtension: PrintExportTransferArtifact["fileExtension"] = ".3mf",
): PrintCalibrationFileNames {
  const stem = sanitizePrintFileStem(profileId);
  return {
    artifact: `${stem}.calibration${fileExtension}`,
    manifest: `${stem}.calibration.json`,
  };
}

function defaultObjectUrlApi(): ObjectUrlApi {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}

export class PrintDownloadManager {
  private readonly objectUrls: ObjectUrlApi;
  private activeUrls: string[] = [];

  public constructor(objectUrls: ObjectUrlApi = defaultObjectUrlApi()) {
    this.objectUrls = objectUrls;
  }

  public replace(
    name: PrintExportName,
    input: PrintExportDownloadInput,
  ): PrintExportDownloads {
    this.clear();
    const names = printExportFileNames(
      name,
      input.artifact.fileExtension,
    );
    const created: string[] = [];
    try {
      const artifactBlob = new Blob([input.artifact.bytes], {
        type: input.artifact.mimeType,
      });
      const artifactUrl = this.objectUrls.createObjectURL(artifactBlob);
      created.push(artifactUrl);
      const artifact: PrintExportDownload = {
        fileName: names.artifact,
        url: artifactUrl,
        blob: artifactBlob,
      };
      if (input.legendBytes === undefined) {
        this.activeUrls = created;
        return { artifact };
      }

      const legendBlob = new Blob([input.legendBytes], {
        type: "application/json",
      });
      const legendUrl = this.objectUrls.createObjectURL(legendBlob);
      created.push(legendUrl);
      this.activeUrls = created;
      return {
        artifact,
        legend: {
          fileName: names.legend,
          url: legendUrl,
          blob: legendBlob,
        },
      };
    } catch (error) {
      for (const url of created) {
        this.objectUrls.revokeObjectURL(url);
      }
      this.activeUrls = [];
      throw error;
    }
  }

  public replaceCalibration(
    profileId: string,
    input: PrintCalibrationDownloadInput,
  ): PrintCalibrationDownloads {
    this.clear();
    const names = printCalibrationFileNames(
      profileId,
      input.artifact.fileExtension,
    );
    const created: string[] = [];
    try {
      const artifactBlob = new Blob([input.artifact.bytes], {
        type: input.artifact.mimeType,
      });
      const artifactUrl = this.objectUrls.createObjectURL(artifactBlob);
      created.push(artifactUrl);

      const manifestBlob = new Blob([input.manifestBytes], {
        type: "application/json",
      });
      const manifestUrl = this.objectUrls.createObjectURL(manifestBlob);
      created.push(manifestUrl);
      this.activeUrls = created;
      return {
        artifact: {
          fileName: names.artifact,
          url: artifactUrl,
          blob: artifactBlob,
        },
        manifest: {
          fileName: names.manifest,
          url: manifestUrl,
          blob: manifestBlob,
        },
      };
    } catch (error) {
      for (const url of created) {
        this.objectUrls.revokeObjectURL(url);
      }
      this.activeUrls = [];
      throw error;
    }
  }

  public clear(): void {
    for (const url of this.activeUrls) {
      this.objectUrls.revokeObjectURL(url);
    }
    this.activeUrls = [];
  }

  public dispose(): void {
    this.clear();
  }
}

export function tryPublishPrintDownloads(
  manager: PrintDownloadManager,
  name: PrintExportName,
  input: PrintExportDownloadInput,
): PrintDownloadPublication {
  try {
    return {
      ok: true,
      downloads: manager.replace(name, input),
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Local downloads could not be prepared: ${detail}`,
    };
  }
}

export function tryPublishCalibrationDownloads(
  manager: PrintDownloadManager,
  profileId: string,
  input: PrintCalibrationDownloadInput,
): PrintCalibrationDownloadPublication {
  try {
    return {
      ok: true,
      downloads: manager.replaceCalibration(profileId, input),
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message:
        `Local calibration downloads could not be prepared: ${detail}`,
    };
  }
}
