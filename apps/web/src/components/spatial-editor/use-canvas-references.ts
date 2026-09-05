import {
  type ReferenceSeams,
  type ReferenceWire,
  referenceSeamsFromWire,
  referenceWireFor,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useMemo, useRef } from 'react'

export interface CanvasReferences {
  /** The rows this canvas can read, as data — what crosses to the worker. */
  readonly wire: ReferenceWire | undefined
  /** The same rows as a bundle, for the layout paths on this thread. */
  readonly seams: ReferenceSeams | undefined
}

const NOTHING: CanvasReferences = { wire: undefined, seams: undefined }

/**
 * The host's wire cut down to what laying out THIS canvas can read, with the
 * bundle built from it, handed back by identity: the same object for as long
 * as those rows are the same bytes.
 *
 * The host's wire is wider than the canvas on purpose — it grows for a body
 * being drafted in the editor overlay, so the overlay's preview resolves a
 * link the moment it is typed. Everything downstream keys on the identity
 * returned here (the scene memo, the worker request, the content cache on
 * both threads), so growth the canvas cannot read must not produce a new
 * object, or every completed link in a draft would re-lay out the whole
 * canvas. The two forms travel together because they are one decision: the
 * bundle a thread reads has to be built from the bytes the other one gets.
 */
export function useCanvasReferences(
  canvas: SpatialCanvas,
  references: ReferenceWire | undefined,
): CanvasReferences {
  const last = useRef<{ key: string; own: CanvasReferences } | null>(null)
  return useMemo(() => {
    if (references === undefined) return NOTHING
    const wire = referenceWireFor(references, { canvases: [canvas] })
    const key = JSON.stringify(wire)
    if (last.current?.key === key) return last.current.own
    const own: CanvasReferences = { wire, seams: referenceSeamsFromWire(wire) }
    last.current = { key, own }
    return own
  }, [canvas, references])
}
