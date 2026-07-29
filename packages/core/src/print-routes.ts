export type PrintRoutePolicy = "auto" | "off";

export function parsePrintRoutePolicy(
  value: string | undefined,
): PrintRoutePolicy {
  if (value === undefined || value === "off") return "off";
  if (value === "auto") return "auto";
  throw new TypeError("Print route policy must be either 'auto' or 'off'.");
}
