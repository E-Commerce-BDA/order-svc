/**
 * Stable JSON for hashing. Object keys are sorted recursively so the same
 * request body always hashes the same, whatever order the client serialised its
 * fields in — otherwise a reordered payload looks like a different payload and
 * is rejected as an idempotency conflict.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    sorted[key] = sortValue(source[key]);
  }
  return sorted;
}
