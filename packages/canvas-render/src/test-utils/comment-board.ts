/**
 * A board written with its comments inline — the shorthand a layout test reads
 * most easily — laid out the way a caller really hands the annotation layer
 * over: as the threads those comments are, BESIDE the canvas (ADR-0026
 * decision 1b). The canvas itself never carries them.
 */
import {
  type CanvasComment,
  type CommentThread,
  type SpatialCanvas,
  threadFromCanvasComment,
} from '@kamiazya/whiteboard-model'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type { SpatialLayoutOptions } from '../layout/layout-options.js'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'

export type CommentBoard = SpatialCanvas & { readonly comments?: readonly CanvasComment[] }

/** Each comment as the one-message thread it stands for. */
export function threadsOf(comments: readonly CanvasComment[]): CommentThread[] {
  return comments.map(threadFromCanvasComment)
}

/** The canvas and the layout options a board stands for; threads already given win by id. */
function splitBoard(
  board: CommentBoard,
  options: SpatialLayoutOptions,
): { readonly canvas: SpatialCanvas; readonly options: SpatialLayoutOptions } {
  const { comments = [], ...canvas } = board
  const given = options.threads ?? []
  const held = new Set(given.map((thread) => thread.id))
  const inline = threadsOf(comments).filter((thread) => !held.has(thread.id))
  return { canvas, options: { ...options, threads: [...given, ...inline] } }
}

export function layoutBoard(board: CommentBoard, options: SpatialLayoutOptions): Scene {
  const split = splitBoard(board, options)
  return layoutSpatialCanvas(split.canvas, split.options)
}
