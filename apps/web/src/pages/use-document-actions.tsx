/**
 * The document-page kebab's own rows, and everything they need: Duplicate,
 * Delete, the confirmation the second one opens, and the alert row either
 * one reports a refusal through.
 *
 * One bundle rather than four pieces threaded through a page, because they
 * are one affordance: the rows, the dialog they open, the focus the dialog
 * hands back to the kebab, and the alert line are useless apart. A page asks
 * for it and spreads the answer into its `slots`.
 *
 * The verbs are passed IN: what deleting a document means is the keeper's
 * business (the daemon's is one DELETE and a list refresh; the browser's is a
 * cleanup with its own terminal state), and what a refusal SAYS is
 * `destructive-copy.ts`'s. This holds only the shape that is the same either
 * way.
 */
import { serializeSpatial } from '@kamiazya/whiteboard-codec'
import type { DuplicateDocumentRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { DocumentKind, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Braces, Copy, FolderInput, Trash2 } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { DeleteOpenDocumentDialog } from '../components/document-editor/DeleteOpenDocumentDialog.js'
import { DropdownMenuItem } from '../components/ui/dropdown-menu.js'
import {
  MoveOpenDocument,
  type OpenMovePicker,
} from '../components/workspace-files/MoveOpenDocument.js'
import { codecsReady } from '../lib/codec-cores.js'
import {
  DUPLICATE_WITHOUT_COMMENTS,
  WITHOUT_ANNOTATIONS,
} from '../lib/duplicate-without-comments.js'
import type { WorkspaceFilesSource } from '../lib/files-source.js'
import { type AnnounceNotice, useAnnounceNotice } from './document-notice.js'
import { useDeleteDocument } from './use-delete-document.js'
import { useDuplicateDocument } from './use-duplicate-document.js'

export interface UseDocumentActionsOptions {
  /** The document on screen, or undefined while the list has not named one. */
  readonly documentId: string | undefined
  readonly documentKind: DocumentKind
  /**
   * Resolves with the copy, or rejects; this bundle watches only the refusal.
   * `request` asks for the copy without its comments.
   */
  readonly duplicateDocument: (request?: DuplicateDocumentRequest) => Promise<unknown>
  /** Resolves once the document is gone, or rejects. */
  readonly deleteDocument: () => Promise<void>
  /** Runs once the delete resolved; the page leaves the document it showed. */
  readonly onDeleted?: (() => void) | undefined
  /**
   * The decoded canvas, when this document HAS one — what the JSON Canvas row
   * copies. Null for a markdown document, and for a board whose bytes have
   * not arrived, which is the same answer either way: no row.
   */
  readonly canvas: SpatialCanvas | null
  /**
   * What "Move to folder…" needs: the keeper's files source (null hides the
   * row), the open document's path, and the page's own move, which follows
   * the document to its new address.
   */
  readonly move?: {
    readonly source: WorkspaceFilesSource | null
    readonly path: string | null
    readonly moveTo: (newPath: string) => Promise<void>
  }
}

export interface DocumentActionSlots {
  readonly menuTriggerRef: React.RefObject<HTMLButtonElement | null>
  readonly menuItems: ReactNode
  readonly afterMenu: ReactNode
  /** Absent when neither verb has a refusal to show. */
  readonly rowAlerts?: ReactNode
}

async function copyAsJsonCanvas(canvas: SpatialCanvas, announce: AnnounceNotice): Promise<void> {
  await codecsReady()
  const json = serializeSpatial(canvas, 'extended')
  announce(null)
  await navigator.clipboard
    ?.writeText(json)
    .then(() =>
      announce(
        json.includes('asset:')
          ? 'Copied as JSON Canvas — images are referenced, not embedded'
          : 'Copied as JSON Canvas',
      ),
    )
    .catch(() => {})
}

/**
 * Text on the clipboard survives any chat/paste channel intact, which a
 * binary download cannot — the phone-friendly way to hand the exact canvas
 * (coordinates included) to a debugger. An image is written as a reference
 * to the workspace's file, so the confirmation says it is not in the text.
 */
function CopyAsJsonCanvasItem({ canvas }: { canvas: SpatialCanvas }) {
  // Read here, below the page's provider: the hook that builds this item runs
  // in the keeper page, above it.
  const announce = useAnnounceNotice()
  return (
    <DropdownMenuItem
      onSelect={() => {
        void copyAsJsonCanvas(canvas, announce)
      }}
    >
      <Braces aria-hidden="true" className="size-3.5" />
      Copy as JSON Canvas
    </DropdownMenuItem>
  )
}

/** Duplicate, and the copy that leaves the comments behind; both off while one is in flight. */
function DuplicateItems({
  disabled,
  onDuplicate,
}: {
  disabled: boolean
  onDuplicate: (request?: DuplicateDocumentRequest) => Promise<void>
}) {
  return (
    <>
      <DropdownMenuItem disabled={disabled} onSelect={() => void onDuplicate()}>
        <Copy aria-hidden="true" className="size-3.5" />
        Duplicate
      </DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => void onDuplicate(WITHOUT_ANNOTATIONS)}>
        <Copy aria-hidden="true" className="size-3.5" />
        {DUPLICATE_WITHOUT_COMMENTS}
      </DropdownMenuItem>
    </>
  )
}

export function useDocumentActions({
  documentId,
  documentKind,
  canvas,
  duplicateDocument,
  deleteDocument,
  onDeleted,
  move,
}: UseDocumentActionsOptions): DocumentActionSlots {
  // The document on screen NOW, for an async handler that started under a
  // different one: a page switches documents in place rather than remounting,
  // so a closure can only answer with the render it was made in.
  const currentDocumentIdRef = useRef<string | null>(null)
  currentDocumentIdRef.current = documentId ?? null
  const documentOpsButtonRef = useRef<HTMLButtonElement | null>(null)
  const openMovePickerRef = useRef<OpenMovePicker | null>(null)
  const movable = move !== undefined && move.source !== null && move.path !== null

  const { isDuplicating, duplicateError, handleDuplicate } = useDuplicateDocument({
    documentId: documentId ?? null,
    currentDocumentIdRef,
    documentKind,
    duplicateDocument,
  })
  const { confirmDelete, setConfirmDelete, deleteError, handleDelete } = useDeleteDocument({
    documentId,
    documentKind,
    deleteDocument,
    onDeleted,
  })

  return {
    menuTriggerRef: documentOpsButtonRef,
    menuItems: (
      <>
        {canvas !== null && <CopyAsJsonCanvasItem canvas={canvas} />}
        {movable && (
          <DropdownMenuItem onSelect={() => openMovePickerRef.current?.()}>
            <FolderInput aria-hidden="true" className="size-3.5" />
            Move to folder…
          </DropdownMenuItem>
        )}
        <DuplicateItems disabled={isDuplicating} onDuplicate={handleDuplicate} />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => setConfirmDelete(true)}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          Delete
        </DropdownMenuItem>
      </>
    ),
    afterMenu: (
      <>
        <DeleteOpenDocumentDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          documentKind={documentKind}
          triggerRef={documentOpsButtonRef}
          onConfirm={() => void handleDelete()}
        />
        {movable && move.source !== null && (
          <MoveOpenDocument
            source={move.source}
            path={move.path}
            moveTo={move.moveTo}
            openRef={openMovePickerRef}
          />
        )}
      </>
    ),
    ...(duplicateError === null && deleteError === null
      ? {}
      : {
          rowAlerts: (
            <div role="alert" aria-live="assertive" className="text-destructive text-xs">
              {duplicateError ?? deleteError}
            </div>
          ),
        }),
  }
}
