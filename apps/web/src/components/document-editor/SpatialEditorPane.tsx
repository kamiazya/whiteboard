import type { ReactNode, Ref } from 'react'
import type { DocumentFileSeams } from '../../hooks/use-document-file-seams.js'
import { readLastTool, resolveInitialTool } from '../../lib/initial-tool.js'
import {
  HistoryCluster,
  type HistoryClusterVersionsProps,
} from '../history-cluster/HistoryCluster.js'
import {
  SpatialEditor,
  type SpatialEditorHandle,
  type SpatialEditorProps,
} from '../spatial-editor/index.js'
import { NodeTextEditorOverlay, type NodeTextEditorOverlayProps } from './NodeTextEditorOverlay.js'
import type { NodeInEditor } from './use-node-in-editor.js'

/**
 * The spatial editor pane, assembled once for both document pages.
 *
 * The editor takes ~23 props, and each page used to spell the assembly out
 * itself — 19 of them shared, 14 with byte-identical expressions. That is
 * the arrangement that shipped the file-seam defect: a prop added to one
 * call site and not the other diverges silently, because each page's tests
 * only exercise its own mode. Here a new prop is added in one place or it
 * does not compile. `useNodeInEditor` made the same move for the same
 * reason, one hook earlier.
 *
 * Prop types are `Pick`ed from the components they reach rather than
 * restated, so this file cannot drift from the editor's own contract.
 */
type PassedThrough = Pick<
  SpatialEditorProps,
  | 'canvas'
  | 'onChange'
  | 'externalVersion'
  | 'theme'
  | 'fileRefOptions'
  | 'missingFileRef'
  | 'lockedNodeIds'
  | 'lockedEdgeIds'
  | 'onToggleNodeLock'
  | 'onToggleEdgeLock'
  | 'agentTouchedNodeIds'
>

export interface SpatialEditorPaneProps extends PassedThrough {
  /** Keys the editor on canvas identity — see the comment at the render. */
  editorKey: string
  /**
   * Whether the document behind `canvas` has loaded. The initial tool is
   * decided from the canvas's own shape, but only then — at mount every
   * canvas still looks empty.
   */
  canvasLoaded: boolean
  /** From `useDocumentFileSeams`; spread onto the editor here, once. */
  fileSeams: DocumentFileSeams
  /** From `useNodeInEditor`; wires the editor and the overlay coherently. */
  nodeInEditor: NodeInEditor
  /**
   * One navigation for both surfaces that follow a document reference —
   * the editor's file-ref cards and the overlay's links. The pages each
   * passed the same function to both under two prop names.
   */
  onOpenDocument: (id: string) => void
  history: {
    onUndo: () => void
    onRedo: () => void
    canUndo: boolean
    canRedo: boolean
    versions?: HistoryClusterVersionsProps
  }
  overlayTitle: string
  resolveAlias: NodeTextEditorOverlayProps['resolveAlias']
  resolveEmbed: NodeTextEditorOverlayProps['resolveEmbed']
  linkTargets: NodeTextEditorOverlayProps['linkTargets']
  /** The container's classes — the two pages sit in different grid shells. */
  className: string
  editorRef?: Ref<SpatialEditorHandle>
  /** Page-specific chrome inside the container (the agent presence chip). */
  children?: ReactNode
}

export function SpatialEditorPane({
  editorKey,
  canvasLoaded,
  fileSeams,
  nodeInEditor,
  onOpenDocument,
  history,
  overlayTitle,
  resolveAlias,
  resolveEmbed,
  linkTargets,
  className,
  editorRef,
  children,
  canvas,
  onChange,
  externalVersion,
  theme,
  fileRefOptions,
  missingFileRef,
  lockedNodeIds,
  lockedEdgeIds,
  onToggleNodeLock,
  onToggleEdgeLock,
  agentTouchedNodeIds,
}: SpatialEditorPaneProps) {
  return (
    <div data-testid="spatial-editor-container" className={className}>
      {children}
      {/* Keyed on canvas identity: the editor's pan/zoom, in-flight gesture
          and open text editor all describe ONE canvas, and `SpatialCanvas`
          carries no id for the editor to notice a switch by. Without the
          key, switching documents silently inherits the previous canvas's
          viewport. */}
      <SpatialEditor
        key={editorKey}
        initialTool={
          canvasLoaded
            ? resolveInitialTool({
                isEmpty: canvas.nodes.length === 0,
                lastTool: readLastTool(),
              })
            : undefined
        }
        ref={editorRef}
        agentTouchedNodeIds={agentTouchedNodeIds}
        canvas={canvas}
        onChange={onChange}
        externalVersion={externalVersion}
        theme={theme}
        fileRefOptions={fileRefOptions}
        onOpenFileRef={onOpenDocument}
        missingFileRef={missingFileRef}
        {...fileSeams}
        lockedNodeIds={lockedNodeIds}
        lockedEdgeIds={lockedEdgeIds}
        onToggleNodeLock={onToggleNodeLock}
        onOpenInEditor={nodeInEditor.open}
        onToggleEdgeLock={onToggleEdgeLock}
        paletteLeading={<HistoryCluster {...history} />}
      />
      {nodeInEditor.editing !== null && (
        <NodeTextEditorOverlay
          title={overlayTitle}
          initialText={nodeInEditor.editing.text}
          theme={theme}
          resolveAlias={resolveAlias}
          resolveEmbed={resolveEmbed}
          linkTargets={linkTargets}
          onCommit={nodeInEditor.commit}
          onClose={nodeInEditor.close}
          onOpenDocument={onOpenDocument}
        />
      )}
    </div>
  )
}
