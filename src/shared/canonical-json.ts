// The one canonical JSON form of TaskIndex: JSON.stringify with object keys
// sorted by UTF-16 code units (`a < b`), arrays and scalars as they are.
// It defines `commandHash` in the operations table and the export comparisons,
// so the algorithm must stay byte-for-byte stable; existing hashes depend on it.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}
