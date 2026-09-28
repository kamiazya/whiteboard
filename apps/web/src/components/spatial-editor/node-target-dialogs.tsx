import { nodeFile, nodeUrl } from '@kamiazya/whiteboard-model'
import type { FileRefOption } from '../../lib/link-entries.js'
import type { Point } from '../../lib/spatial/viewport.js'
import type { DocumentPickerState, LinkDialogState } from './CanvasContextMenu.js'
import { CREATION_LABELS } from './creation-labels.js'
import { DocumentPickerDialog } from './DocumentPickerDialog.js'
import type { EditorGesture } from './editor-gesture.js'
import { LinkUrlDialog } from './LinkUrlDialog.js'

export interface NodeTargetDialogsProps {
  readonly gesture: EditorGesture
  readonly fileRefOptions: readonly FileRefOption[] | undefined
  readonly picker: DocumentPickerState | null
  readonly setPicker: (state: DocumentPickerState | null) => void
  readonly linkDialog: LinkDialogState | null
  readonly setLinkDialog: (state: LinkDialogState | null) => void
  readonly createFileRefAt: (file: string, at?: Point) => void
  readonly createLinkAt: (url: string, at?: Point) => void
}

/**
 * The two dialogs that choose what a node POINTS AT — a document in the
 * workspace, or a URL — for a node being created or one being retargeted.
 *
 * A retarget edits ONE node, so it may not outlive it: an undo, an import or
 * a peer's delete can take the node while the dialog is open, and a write for
 * a node that is gone is a no-op the user cannot see. That is resolved in the
 * render rather than cleared by an effect — a gate the dialog cannot render
 * without passing is one no future canvas-changing path can forget.
 */
export function NodeTargetDialogs(props: NodeTargetDialogsProps) {
  return (
    <>
      <PickDocument {...props} />
      <EditUrl {...props} />
    </>
  )
}

const nodeOf = (gesture: EditorGesture, id: string) =>
  gesture.canvas.nodes.find((node) => node.id === id)

function PickDocument({
  gesture,
  fileRefOptions,
  picker,
  setPicker,
  createFileRefAt,
}: NodeTargetDialogsProps) {
  if (picker === null || fileRefOptions === undefined) return null
  const target = picker.mode === 'retarget' ? nodeOf(gesture, picker.nodeId) : undefined
  if (picker.mode === 'retarget' && target === undefined) return null
  return (
    <DocumentPickerDialog
      title={picker.mode === 'create' ? `Add ${CREATION_LABELS.document}` : 'Change target'}
      options={fileRefOptions}
      currentFile={target === undefined ? undefined : nodeFile(target)}
      onPick={(file) => {
        if (picker.mode === 'create') {
          createFileRefAt(file, picker.point)
        } else {
          gesture.apply({
            state: { kind: 'idle' },
            commands: [{ kind: 'set-node-file', id: picker.nodeId, file }],
          })
        }
        setPicker(null)
      }}
      onCancel={() => setPicker(null)}
    />
  )
}

function EditUrl({ gesture, linkDialog, setLinkDialog, createLinkAt }: NodeTargetDialogsProps) {
  if (linkDialog === null) return null
  const target = linkDialog.mode === 'edit' ? nodeOf(gesture, linkDialog.nodeId) : undefined
  // An Edit URL that outlived its link would show an empty field and write
  // nothing on OK.
  if (linkDialog.mode === 'edit' && target === undefined) return null
  return (
    <LinkUrlDialog
      title={linkDialog.mode === 'create' ? `Add ${CREATION_LABELS.link}` : 'Edit URL'}
      initialUrl={target === undefined ? undefined : nodeUrl(target)}
      onSubmit={(url) => {
        if (linkDialog.mode === 'create') {
          createLinkAt(url, linkDialog.point)
        } else {
          gesture.apply({
            state: { kind: 'idle' },
            commands: [{ kind: 'set-node-url', id: linkDialog.nodeId, url }],
          })
        }
        setLinkDialog(null)
      }}
      onCancel={() => setLinkDialog(null)}
    />
  )
}
