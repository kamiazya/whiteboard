import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { PointerEvent } from 'react'
import type { Point, Viewport } from '../../lib/spatial/viewport.js'
import type { GestureEvent, GestureResult, GestureState } from './gestures.js'

/**
 * What a layer of the editor needs to take part in a gesture, named once so
 * the layer can live in a module of its own: the gesture in flight, the
 * canvas it acts on, where the view and the pointer are, and the three ways
 * to act on them.
 *
 * Without a name these travelled as a dozen separate values into every
 * layer, which is why the editor's layers stayed closures inside it. The
 * editor builds one per render. A layer reads it and never keeps it, because
 * the next render's gesture is a different value.
 */
export interface EditorGesture {
  readonly state: GestureState
  readonly canvas: SpatialCanvas
  readonly viewport: Viewport
  /** Where the pointer is, in canvas space, while a gesture is live. */
  readonly livePoint: Point | null
  /** Feeds one event through the gesture reducer and applies what it answers. */
  readonly dispatch: (event: GestureEvent) => void
  /** Applies a result a layer built itself, rather than an event. */
  readonly apply: (result: GestureResult) => void
  /**
   * Claims the pointer for a press that began on an overlay control rather
   * than the canvas surface, answering the editor root, or `null` when the
   * root is not mounted.
   */
  readonly beginOverlay: (event: PointerEvent) => HTMLDivElement | null
}
