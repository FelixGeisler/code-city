import { validSavedId, parseSavedRecord as validateRecord, type SavedRecord } from "../application/saved-investigation";
export function parseSavedRecord(value: unknown): SavedRecord {
  try { return validateRecord(value); } catch { throw new Error("Saved investigation unavailable"); }
}
export async function listSavedInvestigations(): Promise<SavedRecord[]> {
  const response = await fetch("/api/investigations", { credentials: "omit", cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error("Saved investigations are unavailable. Check the host's data directory.");
  const value: unknown = await response.json();
  if (!Array.isArray(value) || value.length > 1024) throw new Error("Saved investigation list is invalid");
  return value.map(parseSavedRecord);
}
export function savedUrl(id: string): string { if (!validSavedId(id)) throw new Error("Invalid saved investigation"); return new URL(`/saved/${id}`, location.origin).href; }
