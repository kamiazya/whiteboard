/**
 * "Show me this conversation": moves the viewport to what a thread is about
 * and marks the spot for a moment.
 *
 * The caller holds an id, never a box — the anchor may be a node that has
 * since moved, so it is resolved against the canvas at the moment of the
 * request. `revealThread` is stable and reads the latest state through a ref,
 * so an imperative handle that never re-creates itself still sees the
 * current viewport.
 */
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { Box } from '../../lib/spatial/geometry.js'
import { anchorBox, viewportRevealing } from '../../lib/spatial/reveal-anchor.js'
import type {
  ContainerSize,
  Point,
  Viewport,
  ViewportOcclusion,
} from '../../lib/spatial/viewport.js'
import { DOCK_OCCLUSION_PX } from './ToolPalette.js'

/** Long enough to be seen after a pan, short enough not to read as state. */
const PULSE_MS = 1400

export interface RevealPulse {
  readonly box: Box
  /** Distinguishes two reveals of the same box, so the animation restarts. */
  readonly key: number
}

/** The dock paints over the bottom edge too; whichever covers more wins. */
const withDock = (insets: ViewportOcclusion): ViewportOcclusion => ({
  ...insets,
  bottom: Math.max(DOCK_OCCLUSION_PX, insets.bottom ?? 0),
})

type RevealInputs = Parameters<typeof useCommentReveal>[0]

function viewportFor(box: Box, inputs: RevealInputs): Viewport | undefined {
  const { viewport, rootRef, containerSizeOf, insetsOf } = inputs
  const occlusion = withDock(insetsOf?.() ?? {})
  return viewportRevealing(box, viewport, containerSizeOf(rootRef.current), occlusion)
}

export function useCommentReveal(inputs: {
  readonly threads: readonly CommentThread[] | undefined
  readonly canvas: SpatialCanvas
  readonly edgePathOf: (edgeId: string) => readonly Point[] | undefined
  readonly viewport: Viewport
  readonly setViewport: (viewport: Viewport) => void
  readonly rootRef: RefObject<HTMLDivElement | null>
  readonly containerSizeOf: (root: HTMLDivElement | null) => ContainerSize | null
  /**
   * Called when the thread asked for is resolved, which the canvas hides
   * unless told otherwise: a conversation the reader went looking for must
   * be drawn where the view lands, not pan to an empty spot.
   */
  readonly showResolved: () => void
  /** What panels paint over the root; the dock is added to the bottom here. */
  readonly insetsOf?: () => ViewportOcclusion
}): { readonly revealThread: (threadId: string) => boolean; readonly pulse: RevealPulse | null } {
  const latest = useRef(inputs)
  latest.current = inputs
  const [pulse, setPulse] = useState<RevealPulse | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sequence = useRef(0)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const revealThread = useCallback((threadId: string): boolean => {
    const { threads, canvas, edgePathOf, setViewport, showResolved } = latest.current
    const thread = threads?.find((entry) => entry.id === threadId)
    if (thread === undefined) return false
    const box = anchorBox(thread.anchor, canvas, edgePathOf)
    if (box === null) return false
    if (thread.status === 'resolved') showResolved()
    const next = viewportFor(box, latest.current)
    if (next !== undefined) setViewport(next)
    sequence.current += 1
    setPulse({ box, key: sequence.current })
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPulse(null), PULSE_MS)
    return true
  }, [])

  return { revealThread, pulse }
}
