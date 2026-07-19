// Deliberately reads the retained parseViewerScene output, never Excalidraw
// viewport internals (mount.ts stays untouched) — the widget only knows the
// scene it last rendered, not the host's current pan/zoom.
export const STICKY_PLACEMENT_MARGIN = 24

interface EligibleElement {
  x: number
  y: number
  width: number
  height: number
  // Excalidraw's rotation, in radians, around the element's own center.
  // Missing or non-numeric input is treated as unrotated (0) rather than
  // disqualifying the element — angle is optional in Excalidraw's element
  // schema, so a well-formed unrotated element must stay eligible.
  angle: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// parseViewerScene (scene.ts) validates elements only as loose records, so
// geometry here can be missing, non-numeric, NaN, or Infinity — any of those
// disqualifies the element from the bounds computation rather than
// corrupting it.
function toEligibleElement(element: unknown): EligibleElement | undefined {
  if (typeof element !== 'object' || element === null) return undefined
  const record = element as Record<string, unknown>
  if (record.isDeleted === true) return undefined
  if (
    !isFiniteNumber(record.x) ||
    !isFiniteNumber(record.y) ||
    !isFiniteNumber(record.width) ||
    !isFiniteNumber(record.height)
  ) {
    return undefined
  }
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
    angle: isFiniteNumber(record.angle) ? record.angle : 0,
  }
}

// Excalidraw rotates an element around its own center, so its visible
// footprint's axis-aligned bounding box is generally larger than (and offset
// from) the unrotated x/y/width/height rect — using the raw rect for a
// rotated element (especially a tall, narrow one close to 90 degrees) can
// place a target that reads as "clear of the content" well inside its actual
// rendered bounds.
function rotatedAabb(element: EligibleElement): Bounds {
  const { x, y, width, height, angle } = element
  if (angle === 0) {
    return { minX: x, minY: y, maxX: x + width, maxY: y + height }
  }
  const centerX = x + width / 2
  const centerY = y + height / 2
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const halfWidth = width / 2
  const halfHeight = height / 2
  const corners = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([dx, dy]) => ({
    x: centerX + dx * cos - dy * sin,
    y: centerY + dx * sin + dy * cos,
  }))
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
  }
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
    const eligible = toEligibleElement(element)
    if (!eligible) continue
    const elementAabb = rotatedAabb(eligible)
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, elementAabb.minX),
          minY: Math.min(bounds.minY, elementAabb.minY),
          maxX: Math.max(bounds.maxX, elementAabb.maxX),
          maxY: Math.max(bounds.maxY, elementAabb.maxY),
        }
      : elementAabb
  }
  if (!bounds) return { x: 0, y: 0 }
  return { x: bounds.maxX + STICKY_PLACEMENT_MARGIN, y: bounds.minY }
}
