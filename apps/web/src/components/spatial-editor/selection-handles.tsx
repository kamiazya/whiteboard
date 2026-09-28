import type { KeyboardEvent } from 'react'
import type { Box, ResizeHandleKind } from '../../lib/spatial/geometry.js'
import { clientPointToRootLocal, type Point, screenToCanvas } from '../../lib/spatial/viewport.js'
import type { EditorGesture } from './editor-gesture.js'
import type { GestureEvent } from './gestures.js'
import { SelectionOverlay } from './SelectionOverlay.js'

type ResizeMembers = Extract<GestureEvent, { type: 'pointerdown-handle' }>['members']

export interface SelectionHandlesProps {
  readonly gesture: EditorGesture
  readonly target: { readonly id: string; readonly box: Box }
  /** The group the handles surround, or `undefined` for a lone node. */
  readonly members: ResizeMembers
  readonly onHandleKeyDown: (handle: ResizeHandleKind, box: Box, e: KeyboardEvent) => void
  readonly onConnectKeyDown: (e: KeyboardEvent) => void
  readonly onOpenInEditor: (() => void) | undefined
  readonly onMoreActions: (anchor: Point) => void
}

/**
 * What is drawn AROUND the selection: its outline, its handles, and the
 * verbs that act on it. A press on a handle starts the gesture here; what
 * the verbs open is the host's to decide.
 */
export function SelectionHandles(props: SelectionHandlesProps) {
  const { gesture, target, members } = props
  return (
    <SelectionOverlay
      // Keyed by TARGET: a new selection remounts the overlay and replays
      // the outline's draw-once; dragging or resizing the same node keeps
      // the element and stays still.
      key={target.id}
      box={target.box}
      zoom={gesture.viewport.zoom}
      onHandlePointerDown={(handle, _handleBox, e) => {
        const root = gesture.beginOverlay(e)
        if (root === null) return
        gesture.dispatch({
          type: 'pointerdown-handle',
          nodeId: target.id,
          handle,
          point: screenToCanvas(clientPointToRootLocal(e, root), gesture.viewport),
          // The resize anchor is the box the HANDLES surround, not the
          // handle's own tiny hit-box `_handleBox` describes — using the
          // handle box would seed `reducePointerUpResizing`'s
          // anchor-preserving math from an 8px square, growing/shrinking
          // from the wrong origin.
          box: target.box,
          // Omitted for a lone node, which keeps the single-command path —
          // including its collapse-to-zero behavior, which group members
          // deliberately do not share.
          ...(members === undefined ? {} : { members }),
        })
      }}
      // Connecting and editing act on ONE node; from handles that surround
      // a group they would claim to apply to all of them.
      onConnectPointerDown={
        members === undefined
          ? (e) => {
              if (gesture.beginOverlay(e) === null) return
              gesture.dispatch({ type: 'pointerdown-connect', nodeId: target.id })
            }
          : undefined
      }
      onHandleKeyDown={props.onHandleKeyDown}
      onConnectKeyDown={props.onConnectKeyDown}
      onOpenInEditor={props.onOpenInEditor}
      onMoreActions={props.onMoreActions}
    />
  )
}
