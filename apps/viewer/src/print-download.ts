export interface PrintExportName {
  readonly title?: string;
  readonly version?: string;
}

export interface PrintExportFileNames {
  readonly threeMf: string;
  readonly legend: string;
}

export interface PrintExportDownloadInput {
  readonly threeMfBytes: ArrayBuffer;
  readonly legendBytes?: ArrayBuffer;
}

export interface PrintExportDownload {
  readonly fileName: string;
  readonly url: string;
  readonly blob: Blob;
}

export interface PrintExportDownloads {
  readonly threeMf: PrintExportDownload;
  readonly legend?: PrintExportDownload;
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
): PrintExportFileNames {
  const parts = [name.title, name.version]
    .filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0,
    )
    .join("-");
  const stem = sanitizePrintFileStem(parts);
  return {
    threeMf: `${stem}.3mf`,
    legend: `${stem}.legend.json`,
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
    const names = printExportFileNames(name);
    const created: string[] = [];
    try {
      const threeMfBlob = new Blob([input.threeMfBytes], {
        type: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
      });
      const threeMfUrl = this.objectUrls.createObjectURL(threeMfBlob);
      created.push(threeMfUrl);
      const threeMf: PrintExportDownload = {
        fileName: names.threeMf,
        url: threeMfUrl,
        blob: threeMfBlob,
      };
      if (input.legendBytes === undefined) {
        this.activeUrls = created;
        return { threeMf };
      }

      const legendBlob = new Blob([input.legendBytes], {
        type: "application/json",
      });
      const legendUrl = this.objectUrls.createObjectURL(legendBlob);
      created.push(legendUrl);
      this.activeUrls = created;
      return {
        threeMf,
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
