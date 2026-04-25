// Pure helper that prepares one .excalidrawlib item for insertion onto the
// canvas. It assigns fresh ids, shifts the item so its bbox top-left lands on
// the target point, remaps internal references, and drops external bindings.

export interface LibraryElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  containerId?: string | null
  boundElements?: Array<{ id: string; type: string }> | null
  startBinding?: { elementId: string; focus?: number; gap?: number } | null
  endBinding?: { elementId: string; focus?: number; gap?: number } | null
  [key: string]: unknown
}

function requirePositiveScale(scale: number | undefined): number {
  if (scale === undefined) return 1
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('scale must be a positive number')
  }
  return scale
}

function scalePoints(value: unknown, scale: number): unknown {
  if (!Array.isArray(value)) return value
  return value.map((point) => {
    if (!Array.isArray(point) || point.length < 2) return point
    if (typeof point[0] !== 'number' || typeof point[1] !== 'number') return point
    const scaled = [...point]
    scaled[0] = point[0] * scale
    scaled[1] = point[1] * scale
    return scaled
  })
}

export function resolveLibraryItem(
  elements: LibraryElement[],
  target: { x: number; y: number },
  idGen: () => string,
  scaleArg?: number,
): LibraryElement[] {
  if (elements.length === 0) return []
  const scale = requirePositiveScale(scaleArg)

  // Old-id -> new-id map for internal reference remapping.
  const idMap = new Map<string, string>()
  for (const el of elements) idMap.set(el.id, idGen())

  // Compute the bbox top-left.
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const el of elements) {
    if (el.x < minX) minX = el.x
    if (el.y < minY) minY = el.y
  }
  // Copy while rewriting fields.
  return elements.map((el) => {
    const copy: LibraryElement = { ...el }
    copy.id = idMap.get(el.id)!
    copy.x = target.x + (el.x - minX) * scale
    copy.y = target.y + (el.y - minY) * scale
    copy.width = el.width * scale
    copy.height = el.height * scale
    if (typeof el.fontSize === 'number') copy.fontSize = el.fontSize * scale
    if (typeof el.strokeWidth === 'number') copy.strokeWidth = el.strokeWidth * scale
    if ('points' in el) copy.points = scalePoints(el.points, scale)
    // containerId: remap internal references, null out external ones.
    if (typeof el.containerId === 'string') {
      copy.containerId = idMap.get(el.containerId) ?? null
    }
    // boundElements: keep and remap only internal references.
    if (Array.isArray(el.boundElements)) {
      copy.boundElements = el.boundElements
        .filter((be) => idMap.has(be.id))
        .map((be) => ({ ...be, id: idMap.get(be.id)! }))
    }
    // startBinding / endBinding: remap arrow bindings, null out externals.
    if (el.startBinding) {
      const remapped = idMap.get(el.startBinding.elementId)
      copy.startBinding = remapped
        ? {
            ...el.startBinding,
            elementId: remapped,
            ...(typeof el.startBinding.gap === 'number' ? { gap: el.startBinding.gap * scale } : {}),
          }
        : null
    }
    if (el.endBinding) {
      const remapped = idMap.get(el.endBinding.elementId)
      copy.endBinding = remapped
        ? {
            ...el.endBinding,
            elementId: remapped,
            ...(typeof el.endBinding.gap === 'number' ? { gap: el.endBinding.gap * scale } : {}),
          }
        : null
    }
    return copy
  })
}
