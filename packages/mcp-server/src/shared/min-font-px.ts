// Shared helper: bump text-element fontSize up to a minimum before
// exporting. Used by both the browser export path
// (useWhiteboardSync.helpers.ts) and the headless export path
// (exportCanvasHeadless) so the two routes stay observable-by-eye.
//
// Contract: returns the input array unchanged when minFontPx is
// undefined or no element needs adjustment, so callers can call this
// unconditionally without paying for a clone.

export interface MinFontPxElement {
  type?: unknown
  fontSize?: unknown
  // Allow any other field through untouched.
  [key: string]: unknown
}

export function applyMinFontPx<T extends MinFontPxElement>(
  elements: readonly T[],
  minFontPx: number | undefined,
): readonly T[] {
  if (minFontPx === undefined) return elements
  let mutated: T[] | null = null
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (el.type !== 'text') continue
    const currentSize = typeof el.fontSize === 'number' ? el.fontSize : Number(el.fontSize)
    if (!Number.isFinite(currentSize) || currentSize >= minFontPx) continue
    if (!mutated) mutated = elements.slice() as T[]
    mutated[i] = { ...el, fontSize: minFontPx } as T
  }
  return mutated ?? elements
}
