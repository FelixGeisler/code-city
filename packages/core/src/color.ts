const DISPLAY_COLOR = /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/u;

export function normalizeDisplayColor(
  value: string,
  field = "color",
): string {
  const normalized = value.normalize("NFC").trim().toUpperCase();
  if (!DISPLAY_COLOR.test(normalized)) {
    throw new TypeError(
      `${field} must be a #RRGGBB or #RRGGBBAA color.`,
    );
  }
  return normalized;
}

export function isDisplayColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    normalizeDisplayColor(value);
    return true;
  } catch {
    return false;
  }
}
