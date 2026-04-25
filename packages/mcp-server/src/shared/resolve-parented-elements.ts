// Pure helper that resolves parent-referenced annotations to absolute
// coordinates immediately before rendering.
//
// Background:
//   MCP computes annotation coordinates from a snapshot using image position and
//   relative target coordinates. If the image moves before update POST happens,
//   the annotation drifts. This layer stores parentId + relX + relY in LoroMap
//   and recomputes from the parent's latest coordinates right before rendering.
//
// Fallback:
//   - if the parent is missing or deleted, use the element's own x/y
//   - this keeps the annotation visible even if the parent is removed
//
// Purity:
//   - do not mutate the input array or element objects
//   - return a new array with shallow-copied elements

export type ParentedElement = {
  id: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
  parentId?: string
  relX?: number
  relY?: number
  // Allow extra Excalidraw fields through an index signature.
  [key: string]: unknown
}

export function resolveParentedElements<T extends ParentedElement>(elements: T[]): T[] {
  // Memoized map of resolved bounding boxes, including transitive parent chains.
  const resolvedById = new Map<string, { x: number; y: number; width: number; height: number }>()
  const indexById = new Map<string, T>()
  for (const el of elements) indexById.set(el.id, el)

  // Detect cycles to avoid infinite recursion.
  const resolving = new Set<string>()

  function resolveBBox(id: string): { x: number; y: number; width: number; height: number } {
    const cached = resolvedById.get(id)
    if (cached) return cached
    const el = indexById.get(id)
    if (!el) {
      // Callers should already guard against this, but keep a safe fallback.
      return { x: 0, y: 0, width: 0, height: 0 }
    }
    // No parent reference: keep the current bounding box.
    const parentId = el.parentId
    if (typeof parentId !== 'string' || typeof el.relX !== 'number' || typeof el.relY !== 'number') {
      const bbox = { x: el.x, y: el.y, width: el.width, height: el.height }
      resolvedById.set(id, bbox)
      return bbox
    }
    // Cycle detected: fall back to the element's own coordinates.
    if (resolving.has(id)) {
      const bbox = { x: el.x, y: el.y, width: el.width, height: el.height }
      resolvedById.set(id, bbox)
      return bbox
    }
    const parent = indexById.get(parentId)
    // Missing or tombstoned parent: use the element's own coordinates.
    if (!parent || parent.isDeleted === true) {
      const bbox = { x: el.x, y: el.y, width: el.width, height: el.height }
      resolvedById.set(id, bbox)
      return bbox
    }
    // Resolve the parent recursively to support transitive chains.
    resolving.add(id)
    const pbb = resolveBBox(parentId)
    resolving.delete(id)
    const bbox = {
      x: pbb.x + el.relX * pbb.width,
      y: pbb.y + el.relY * pbb.height,
      width: el.width,
      height: el.height,
    }
    resolvedById.set(id, bbox)
    return bbox
  }

  return elements.map((el) => {
    const bbox = resolveBBox(el.id)
    // Strip parent reference fields from the output because Excalidraw does not
    // know about them.
    const { parentId: _pid, relX: _rx, relY: _ry, ...rest } = el
    return { ...(rest as object), x: bbox.x, y: bbox.y } as T
  })
}
