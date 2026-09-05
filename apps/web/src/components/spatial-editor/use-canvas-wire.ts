import { type ReferenceWire, referenceWireFor } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useMemo, useRef } from 'react'

/**
 * The host's wire, cut down to what laying out THIS canvas can read, and
 * handed back by identity: the same object for as long as those rows are the
 * same bytes.
 *
 * The host's wire is wider than the canvas on purpose — it grows for a body
 * being drafted in the editor overlay, so the overlay's preview resolves a
 * link the moment it is typed. Everything downstream keys on the identity
 * returned here (the seams, the worker request, the content cache on both
 * threads), so growth the canvas cannot read must not produce a new object,
 * or every completed link in a draft would re-lay out the whole canvas.
 */
export function useCanvasWire(
  canvas: SpatialCanvas,
  references: ReferenceWire | undefined,
): ReferenceWire | undefined {
  const last = useRef<{ key: string; wire: ReferenceWire } | null>(null)
  return useMemo(() => {
    if (references === undefined) return undefined
    const own = referenceWireFor(references, { canvases: [canvas] })
    const key = JSON.stringify(own)
    if (last.current?.key === key) return last.current.wire
    last.current = { key, wire: own }
    return own
  }, [canvas, references])
}
