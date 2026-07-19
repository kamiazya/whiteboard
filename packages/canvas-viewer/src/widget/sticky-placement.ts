// Deliberately reads the retained parseViewerScene output, never Excalidraw
// viewport internals (mount.ts stays untouched) — the widget only knows the
// scene it last rendered, not the host's current pan/zoom.
export const STICKY_PLACEMENT_MARGIN = 24

interface EligibleElement {
  x: number
  y: number
  width: number
  height: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// parseViewerScene (scene.ts) validates elements only as loose records, so
// geometry here can be missing, non-numeric, NaN, or Infinity — any of those
// disqualifies the element from the bounds computation rather than
// corrupting it.
function isEligibleElement(element: unknown): element is EligibleElement {
  if (typeof element !== 'object' || element === null) return false
  const record = element as Record<string, unknown>
  if (record.isDeleted === true) return false
  return (
    isFiniteNumber(record.x) &&
    isFiniteNumber(record.y) &&
    isFiniteNumber(record.width) &&
    isFiniteNumber(record.height)
  )
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface StickyPlacement {
  x: number
  y: number
}

// Right of the last-valid-scene content, top-aligned to its topmost element.
// An empty scene, or one with no geometrically-eligible element, falls back
// to the origin deterministically rather than guessing a viewport center
// this widget has no way to observe.
export function computeStickyPlacement(elements: readonly unknown[]): StickyPlacement {
  let bounds: Bounds | undefined
  for (const element of elements) {
    if (!isEligibleElement(element)) continue
    const maxX = element.x + element.width
    const maxY = element.y + element.height
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, element.x),
          minY: Math.min(bounds.minY, element.y),
          maxX: Math.max(bounds.maxX, maxX),
          maxY: Math.max(bounds.maxY, maxY),
        }
      : { minX: element.x, minY: element.y, maxX, maxY }
  }
  if (!bounds) return { x: 0, y: 0 }
  return { x: bounds.maxX + STICKY_PLACEMENT_MARGIN, y: bounds.minY }
}
