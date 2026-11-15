import {
  overlayReferences,
  type ReferenceSeams,
  type ReferenceWire,
  referenceSeamsFromWire,
  referenceWire,
  referenceWireFor,
} from '@kamiazya/whiteboard-canvas-render'
import { nodeFile, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useMemo, useRef } from 'react'

export interface CanvasReferences {
  /** The rows this canvas can read, as data — what crosses to the worker. */
  readonly wire: ReferenceWire | undefined
  /** The same rows as a bundle, for the layout paths on this thread. */
  readonly seams: ReferenceSeams | undefined
  /**
   * A token that changes exactly when `wire` does — unique in this page, so
   * the worker can key its content cache on it without serialising the wire.
   */
  readonly revision: number | undefined
}

const NOTHING: CanvasReferences = { wire: undefined, seams: undefined, revision: undefined }

/** What a surface layers over the wire: readable labels, and the references it holds as dangling. */
export interface ReferenceChrome {
  readonly labels?: ReadonlyMap<string, string>
  readonly missing?: ReadonlySet<string>
}

const NO_CHROME: ReferenceChrome = {}

const EMPTY_WIRE: ReferenceWire = referenceWire(new Map())

/** The chrome of the file nodes `canvas` and every canvas `wire` loaded draw, and no more. */
function chromeDrawnBy(
  chrome: ReferenceChrome,
  canvas: SpatialCanvas,
  wire: ReferenceWire,
): ReferenceChrome {
  if (!hasChrome(chrome)) return chrome
  const loaded = wire.entries.flatMap(([, entry]) => entry?.canvas ?? [])
  const drawn = new Set(
    [canvas, ...loaded].flatMap((c) => c.nodes.flatMap((node) => nodeFile(node) ?? [])),
  )
  return {
    labels: new Map([...(chrome.labels ?? [])].filter(([ref]) => drawn.has(ref))),
    missing: new Set([...(chrome.missing ?? [])].filter((ref) => drawn.has(ref))),
  }
}

const hasChrome = (chrome: ReferenceChrome): boolean =>
  (chrome.labels?.size ?? 0) > 0 || (chrome.missing?.size ?? 0) > 0

let nextRevision = 0

/**
 * Whether two values of plain data — what a wire's rows hold — are the same,
 * short-circuiting on identity. A loaded record and the strings in it are
 * shared between successive wires, so this costs the rows, not the bodies,
 * where serialising would read every body again on every load that lands.
 */
function samePlainData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => samePlainData(item, b[i]))
  }
  const left = Object.entries(a)
  const right = b as Record<string, unknown>
  if (left.length !== Object.keys(right).length) return false
  return left.every(([key, value]) => Object.hasOwn(right, key) && samePlainData(value, right[key]))
}

/**
 * The host's wire cut down to what laying out THIS canvas can read, with the
 * bundle built from it, handed back by identity: the same object for as long
 * as those rows hold the same data.
 *
 * The host's wire is wider than the canvas on purpose — it grows for a body
 * being drafted in the editor overlay, so the overlay's preview resolves a
 * link the moment it is typed. Everything downstream keys on the identity
 * returned here (the scene memo, the worker request, the content cache on
 * both threads), so growth the canvas cannot read must not produce a new
 * object, or every completed link in a draft would re-lay out the whole
 * canvas. The two forms travel together because they are one decision: the
 * bundle a thread reads has to be built from the bytes the other one gets.
 *
 * `chrome` rides the wire as extras, layered AFTER the cut and kept to the
 * file nodes this canvas and the canvases it loaded draw: the cut stops at
 * the loading budget, which bounds what is fetched, never which card keeps
 * its label or its dangling mark. A host that hands
 * chrome and no wire gets an empty one to carry it, since a wire is the only
 * form both threads and the core read.
 */
export function useCanvasReferences(
  canvas: SpatialCanvas,
  references: ReferenceWire | undefined,
  chrome: ReferenceChrome = NO_CHROME,
): CanvasReferences {
  const last = useRef<CanvasReferences | null>(null)
  return useMemo(() => {
    const base = references ?? (hasChrome(chrome) ? EMPTY_WIRE : undefined)
    if (base === undefined) return NOTHING
    const cut = referenceWireFor(base, { canvases: [canvas] })
    const wire = overlayReferences(cut, chromeDrawnBy(chrome, canvas, cut))
    if (last.current !== null && samePlainData(last.current.wire, wire)) return last.current
    nextRevision += 1
    const own: CanvasReferences = {
      wire,
      seams: referenceSeamsFromWire(wire),
      revision: nextRevision,
    }
    last.current = own
    return own
  }, [canvas, references, chrome])
}
