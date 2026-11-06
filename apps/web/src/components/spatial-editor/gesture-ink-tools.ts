/**
 * The two tools that make the board a sheet of paper: the pen that lays a
 * stroke down and the eraser that takes strokes away. Each is a gesture
 * state of `gestures.ts`'s machine, held here so the machine's own file
 * keeps to the reducer that dispatches them.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { freehandLine, withPen } from '../../lib/spatial/freehand.js'
import type { PenStyle } from '../../lib/spatial/pen-style.js'
import { DEFAULT_PEN } from '../../lib/spatial/pen-style.js'
import type { Point } from '../../lib/spatial/viewport.js'

/**
 * A freehand stroke in progress: every sample the pointer has emitted since
 * it went down, in canvas coordinates.
 *
 * The one gesture that keeps intermediate points, and it has to — see the
 * `pointermove` arm. `zoom` rides along because what counts as jitter, and
 * what counts as a tap, are screen distances, and the release has no viewport
 * to ask.
 */
export interface DrawSnapshot {
  readonly kind: 'drawing'
  /**
   * The mark this stroke joins, decided at the PRESS and carried to the
   * release. Decided there because that is where the timing and the starting
   * point are, and by the caller because the decision reads a clock — see
   * `stroke-group.ts`.
   */
  readonly group?: string
  /** The pen as it was at the press: a pick made mid-stroke is for the next one. */
  readonly pen?: PenStyle
  readonly points: readonly Point[]
  readonly zoom: number
}

/** The pen going down: a stroke of one sample, carrying the press's mark and pen. */
export function strokeStart(press: {
  readonly point: Point
  readonly zoom: number
  readonly group?: string
  readonly pen?: PenStyle
}): DrawSnapshot {
  return {
    kind: 'drawing',
    points: [press.point],
    zoom: press.zoom,
    ...(press.group === undefined ? {} : { group: press.group }),
    ...(press.pen === undefined ? {} : { pen: press.pen }),
  }
}

/** The eraser going down, over whatever drawings the caller found under it. */
export function eraseStart(press: {
  readonly point: Point
  readonly ids: readonly string[]
}): EraseSnapshot {
  return { kind: 'erasing', ids: [...press.ids], at: press.point }
}

/** What a stroke's release writes: the line it became, or nothing for a tap. */
export function strokeRelease(state: DrawSnapshot, at: Point, id: string): EditorCommand[] {
  const line = freehandLine(id, [...state.points, at], state.zoom, state.group)
  if (line === undefined) return []
  return [{ kind: 'create-line', line: withPen(line, state.pen ?? DEFAULT_PEN) }]
}

/**
 * The eraser held down: every drawing it has passed over so far, in the
 * order it touched them.
 *
 * Nothing is removed until the release, so a whole sweep is ONE undo step
 * and the strokes it is about to take can be shown as such while it runs.
 * Which strokes the pointer is over is the CALLER's to say — the paths are
 * the scene's, and the machine never sees geometry.
 */
export interface EraseSnapshot {
  readonly kind: 'erasing'
  readonly ids: readonly string[]
  /** Where the eraser last was, so the caller can test the run since then. */
  readonly at: Point
}

/** The sweep so far, moved to `at`, plus whatever it passed over getting there. */
export function eraseOver(state: EraseSnapshot, at: Point, ids: readonly string[]): EraseSnapshot {
  const fresh = ids.filter((id) => !state.ids.includes(id))
  return { ...state, at, ids: fresh.length === 0 ? state.ids : [...state.ids, ...fresh] }
}

/**
 * What the release writes: one batch removing every touched stroke the
 * canvas still holds, or nothing at all for a sweep that touched none. A
 * stroke a collaborator removed mid-sweep is skipped, not deleted twice.
 */
export function eraseRelease(state: EraseSnapshot, canvas: SpatialCanvas): EditorCommand[] {
  const held = new Set((canvas.lines ?? []).map((line) => line.id))
  const gone = state.ids.filter((id) => held.has(id))
  if (gone.length === 0) return []
  return [{ kind: 'batch', commands: gone.map((id) => ({ kind: 'delete-line', id }) as const) }]
}
