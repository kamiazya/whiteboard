import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type MutableRefObject, useEffect, useRef } from 'react'
import { announceOnCanvas } from '../../lib/canvas-announcer.js'
import { nudgeSettledMessage } from './canvas-announcement-text.js'

/**
 * How long the arrow keys must rest before a run of nudges is said. Longer
 * than key auto-repeat's gap and a deliberate run of presses, short enough
 * that the answer still reads as the answer to them.
 */
const NUDGE_SETTLE_MS = 700

interface NudgeRun {
  readonly ids: readonly string[]
  readonly dx: number
  readonly dy: number
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index])

/**
 * Says where a run of arrow-key nudges took the selection, once the keys
 * have rested (`nudgeSettledMessage`). Returns the function each nudge
 * reports itself to; a nudge of a different selection starts a new run.
 */
export function useNudgeAnnouncement(
  canvasRef: MutableRefObject<SpatialCanvas>,
): (ids: readonly string[], dx: number, dy: number) => void {
  const run = useRef<NudgeRun | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (ids, dx, dy) => {
    const current = run.current
    run.current =
      current !== null && sameIds(current.ids, ids)
        ? { ids, dx: current.dx + dx, dy: current.dy + dy }
        : { ids, dx, dy }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const settled = run.current
      run.current = null
      if (settled === null) return
      const message = nudgeSettledMessage(canvasRef.current, settled.ids, settled)
      if (message !== undefined) announceOnCanvas(message)
    }, NUDGE_SETTLE_MS)
  }
}
