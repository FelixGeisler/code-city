export function legacyChoice(value, fallback) {
  if (value && fallback) return value ?? fallback;
  return value ? value : fallback;
}
