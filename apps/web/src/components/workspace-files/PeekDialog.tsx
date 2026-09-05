import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { DocumentPreview } from './DocumentPreview.js'
import type { DocumentRender } from './load-row-render.js'

/**
 * The peek: look at a document without committing to it.
 *
 * Exists only where a tap OPENS — there the preview pane does not render,
 * so the card menu's Preview verb is the one way to see content before
 * opening. Where the pane renders, selection already answers this and the
 * verb is not offered.
 *
 * Deliberately just the existing DocumentPreview in a dialog, with only the
 * Open handler wired: rename/duplicate/delete stay on the card menu that
 * opened this, so the peek never grows a second set of object verbs.
 */
export function PeekDialog({
  document,
  loadRender,
  onOpen,
  onClose,
}: {
  /** The document being peeked at, or null when closed. */
  readonly document: WorkspaceDocumentEntry | null
  readonly loadRender: (document: WorkspaceDocumentEntry) => Promise<DocumentRender | null>
  readonly onOpen: (document: WorkspaceDocumentEntry) => void
  readonly onClose: () => void
}) {
  return (
    <Dialog open={document !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>
            {document === null ? '' : (document.name ?? document.path.split('/').at(-1))}
          </DialogTitle>
        </DialogHeader>
        {document !== null && (
          <DocumentPreview
            document={document}
            loadRender={loadRender}
            onOpen={(entry) => {
              onClose()
              onOpen(entry)
            }}
            className="min-h-0 flex-1"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
