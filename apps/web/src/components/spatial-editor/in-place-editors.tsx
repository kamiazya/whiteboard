import { commentCornerOf } from '@kamiazya/whiteboard-model'
import type { ComponentProps } from 'react'
import { CommentComposeOverlay } from './comment-compose-overlay.js'
import type { EditorGesture } from './editor-gesture.js'
import { EdgeLabelEditorOverlay, GroupLabelEditorOverlay } from './label-editor-overlays.js'
import { MarkdownBodyEditorOverlay } from './markdown-body-editor-overlay.js'

type Compose = ComponentProps<typeof CommentComposeOverlay>['compose']
type BodyEditor = ComponentProps<typeof MarkdownBodyEditorOverlay>

/** A label editor that may be open, and how to shut it. */
interface OpenLabel {
  readonly id: string | null
  readonly close: () => void
}

export interface InPlaceEditorsProps {
  readonly gesture: EditorGesture
  readonly fontFamily: BodyEditor['fontFamily']
  readonly palette: BodyEditor['palette']
  readonly theme: BodyEditor['theme']
  readonly edgePaths: ComponentProps<typeof EdgeLabelEditorOverlay>['edgePaths']
  readonly edgeLabel: OpenLabel
  readonly groupLabel: OpenLabel
  readonly compose: Compose | null
  readonly setCompose: (compose: Compose | null) => void
  readonly edgePathOf: ComponentProps<typeof CommentComposeOverlay>['edgePathOf']
  readonly placementObstacles: () => ComponentProps<typeof CommentComposeOverlay>['obstacles']
  readonly createId: ComponentProps<typeof CommentComposeOverlay>['createId']
  /** The text node whose body is being edited, with the box it occupies. */
  readonly textTarget:
    | { readonly node: BodyEditor['node']; readonly box: BodyEditor['selectionBox'] }
    | undefined
  readonly sceneNodes: BodyEditor['sceneNodes']
  readonly sceneCurrent: boolean
  readonly threads: BodyEditor['threads']
}

/**
 * The editors that open ON the canvas rather than in a panel: an edge's
 * label, a group's label, a new comment, and a node's own text. Each draws
 * in the board's palette and the family the scene declares, so a draft does
 * not move when it commits.
 */
export function InPlaceEditors(props: InPlaceEditorsProps) {
  const { gesture, fontFamily, palette, edgeLabel, groupLabel, compose } = props
  const { canvas, viewport, apply } = gesture
  return (
    <>
      {edgeLabel.id !== null && (
        <EdgeLabelEditorOverlay
          editId={edgeLabel.id}
          canvas={canvas}
          fontFamily={fontFamily}
          edgePaths={props.edgePaths}
          zoom={viewport.zoom}
          palette={palette}
          applyResult={apply}
          onClose={edgeLabel.close}
        />
      )}
      {groupLabel.id !== null && (
        <GroupLabelEditorOverlay
          editId={groupLabel.id}
          canvas={canvas}
          fontFamily={fontFamily}
          zoom={viewport.zoom}
          palette={palette}
          applyResult={apply}
          onClose={groupLabel.close}
        />
      )}
      {compose !== null && (
        <CommentComposeOverlay
          compose={compose}
          canvas={canvas}
          edgePathOf={props.edgePathOf}
          obstacles={props.placementObstacles()}
          createId={props.createId}
          zoom={viewport.zoom}
          palette={palette}
          applyResult={apply}
          onClose={() => props.setCompose(null)}
        />
      )}
      <BodyEditor {...props} />
    </>
  )
}

/**
 * A text node's body, edited where it is drawn. A comment asked for from
 * inside it anchors on the node, at the passage the caret or selection holds.
 */
function BodyEditor(props: InPlaceEditorsProps) {
  const { gesture, textTarget } = props
  if (gesture.state.kind !== 'editing-text' || textTarget === undefined) return null
  const { node, box } = textTarget
  return (
    <MarkdownBodyEditorOverlay
      node={node}
      fontFamily={props.fontFamily}
      selectionBox={box}
      sceneNodes={props.sceneNodes}
      sceneCurrent={props.sceneCurrent}
      threads={props.threads}
      onRequestComment={(anchor) => {
        props.setCompose({
          point: commentCornerOf(node),
          targetNodeId: node.id,
          threadAnchor: { ...anchor, nodeId: node.id },
        })
        return true
      }}
      zoom={gesture.viewport.zoom}
      theme={props.theme}
      palette={props.palette}
      canvas={gesture.canvas}
      gestureState={gesture.state}
      applyResult={gesture.apply}
    />
  )
}
