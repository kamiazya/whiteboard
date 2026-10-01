// What the pointer hook reads: the editor's state hooks' return values plus a
// few of its own props. A leaf of its own so the claim modules can name it
// without importing the hook that composes them, and so the hook does not
// import the editor that mounts it — the editor's props stay the editor's.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { PreviousStroke } from '../../lib/spatial/stroke-group.js'
import type { Point } from '../../lib/spatial/viewport.js'
import type { PickInputs } from './element-pick.js'
import type { GestureResult } from './gestures.js'
import type { NavigationEvent, NavigationResult } from './navigation.js'
import type { useCommentState } from './use-comment-state.js'
import type { useEditSessionState } from './use-edit-session-state.js'
import type { useInteractionState } from './use-interaction-state.js'
import type { useLockPolicy } from './use-lock-policy.js'
import type { useNodeBoxes } from './use-node-boxes.js'
import type { useToolState } from './use-tool-state.js'
import type { useViewportControls } from './use-viewport-controls.js'

/**
 * What the pointer surface reads and writes.
 *
 * A field the component gets from a hook is typed FROM that hook
 * (`ReturnType<typeof useX>['field']`) rather than copied: a bag this
 * size hand-written drifts from its sources in silence, and the drift is
 * invisible until a behaviour depends on it. Only what the component
 * derives itself is spelled out.
 */
export interface EditorPointerInputs {
  // `useCommentState`
  readonly commentById: ReturnType<typeof useCommentState>['commentById']
  readonly commentDrag: ReturnType<typeof useCommentState>['commentDrag']
  readonly commentPlacementObstacles: ReturnType<
    typeof useCommentState
  >['commentPlacementObstacles']
  readonly hitTestComment: ReturnType<typeof useCommentState>['hitTestComment']
  readonly openCommentId: ReturnType<typeof useCommentState>['openCommentId']
  readonly pressedCommentRef: ReturnType<typeof useCommentState>['pressedCommentRef']
  readonly setCommentDrag: ReturnType<typeof useCommentState>['setCommentDrag']
  readonly setOpenCommentId: ReturnType<typeof useCommentState>['setOpenCommentId']
  readonly toggleCommentCard: ReturnType<typeof useCommentState>['toggleCommentCard']
  // `useEditSessionState`
  readonly pendingCut: ReturnType<typeof useEditSessionState>['pendingCut']
  readonly selectedEdgeId: ReturnType<typeof useEditSessionState>['selectedEdgeId']
  readonly selectedInkIds: ReturnType<typeof useEditSessionState>['selectedInkIds']
  readonly setEdgeLabelEditId: ReturnType<typeof useEditSessionState>['setEdgeLabelEditId']
  readonly setGroupLabelEditId: ReturnType<typeof useEditSessionState>['setGroupLabelEditId']
  readonly setSelectedEdgeId: ReturnType<typeof useEditSessionState>['setSelectedEdgeId']
  readonly setSelectedInkIds: ReturnType<typeof useEditSessionState>['setSelectedInkIds']
  // `useInteractionState`
  readonly activePointerIdRef: ReturnType<typeof useInteractionState>['activePointerIdRef']
  readonly applySelection: ReturnType<typeof useInteractionState>['applySelection']
  readonly canvasRef: ReturnType<typeof useInteractionState>['canvasRef']
  readonly clearLongPress: ReturnType<typeof useInteractionState>['clearLongPress']
  readonly doublePressRef: ReturnType<typeof useInteractionState>['doublePressRef']
  readonly gestureState: ReturnType<typeof useInteractionState>['gestureState']
  readonly gestureStateRef: ReturnType<typeof useInteractionState>['gestureStateRef']
  readonly lastPressRef: ReturnType<typeof useInteractionState>['lastPressRef']
  readonly longPressRef: ReturnType<typeof useInteractionState>['longPressRef']
  readonly marquee: ReturnType<typeof useInteractionState>['marquee']
  readonly navigationRef: ReturnType<typeof useInteractionState>['navigationRef']
  readonly setLivePoint: ReturnType<typeof useInteractionState>['setLivePoint']
  readonly setMarquee: ReturnType<typeof useInteractionState>['setMarquee']
  readonly setSnapGuides: ReturnType<typeof useInteractionState>['setSnapGuides']
  readonly spaceDownRef: ReturnType<typeof useInteractionState>['spaceDownRef']
  // `useLockPolicy`
  readonly isLocked: ReturnType<typeof useLockPolicy>['isLocked']
  readonly selectableBoxes: ReturnType<typeof useLockPolicy>['selectableBoxes']
  // `useNodeBoxes`
  readonly boxes: ReturnType<typeof useNodeBoxes>['boxes']
  // `useToolState`
  readonly openContextMenuAtRef: ReturnType<typeof useToolState>['openContextMenuAtRef']
  readonly setContextMenu: ReturnType<typeof useToolState>['setContextMenu']
  readonly tool: ReturnType<typeof useToolState>['tool']
  // `useViewportControls`
  readonly viewport: ReturnType<typeof useViewportControls>['viewport']
  // the editor’s own props
  readonly canvas: SpatialCanvas
  readonly createId: (() => string) | undefined
  readonly isImageFileRef: ((file: string) => boolean) | undefined
  readonly missingFileRef: ((file: string) => boolean) | undefined
  readonly onOpenFileRef: ((file: string, subpath?: string) => void) | undefined
  // declared LATER in the component body — the handlers call them at
  // event time, so the forward reference was fine there and becomes an
  // ordinary input here.
  readonly createNodeAt: (point: Point) => void
  readonly pasteClipboard: (at: Point) => void
  readonly openLinkNode: (node: SpatialNode) => void
  // derived in the component body
  readonly applyResult: (result: GestureResult) => void
  readonly capturePointer: (root: HTMLElement, pointerId: number) => void
  readonly extraIds: ReadonlySet<string>
  readonly hitTestProposal: (point: Point) => string | undefined
  readonly isOverlayEvent: (e: React.SyntheticEvent) => boolean
  readonly lastStrokeRef: RefObject<PreviousStroke | null>
  readonly menuPickInputs: PickInputs
  readonly openProposalId: string | null
  readonly pickInputs: PickInputs
  readonly pressedProposalRef: RefObject<{
    readonly id: string
    readonly startScreen: Point
  } | null>
  readonly rootRef: RefObject<HTMLDivElement | null>
  readonly runNavigation: (
    root: HTMLElement,
    event: NavigationEvent,
    at: number,
  ) => NavigationResult
  readonly selectedId: string | null
  readonly setOpenProposalId: Dispatch<SetStateAction<string | null>>
  readonly toggleSelectionMember: (primaryId: string | null, hitId: string) => void
}
