function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function v1LibraryItemId(elements: unknown, index: number): string {
  return `imported-v1-${index}-${stableHash(JSON.stringify(elements))}`
}

// Normalize `.excalidrawlib` payloads from libraries.excalidraw.com into the
// `libraryItems[]` shape expected by `excalidrawAPI.updateLibrary`.
// - v2: { type: 'excalidrawlib', version: 2, libraryItems: [...] } -> pass through
// - v1: { type: 'excalidrawlib', version: 1, library: ElementArray[] } ->
//       wrap each ElementArray as { id, status: 'published', elements, created }
export function normalizeLibraryPayload(raw: unknown): unknown[] {
  if (typeof raw !== 'object' || raw === null) return []
  const obj = raw as { type?: string; version?: number; library?: unknown[]; libraryItems?: unknown[] }
  if (obj.type !== 'excalidrawlib') return []
  if (obj.version === 2 && Array.isArray(obj.libraryItems)) return obj.libraryItems
  if (obj.version === 1 && Array.isArray(obj.library)) {
    return obj.library.map((elements, i) => ({
      id: v1LibraryItemId(elements, i),
      status: 'published' as const,
      elements: elements as unknown[],
      created: i,
    }))
  }
  return []
}
