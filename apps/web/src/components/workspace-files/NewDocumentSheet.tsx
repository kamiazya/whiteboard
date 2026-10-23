import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { DocumentNameField } from './DocumentNameField.js'
import { DOCUMENT_KIND_CHOICES } from './document-kind-choice.js'

/**
 * New, on a phone: a sheet from the bottom edge, where the thumb already is.
 *
 * The name comes first because on this surface the sheet IS the create — a
 * kind button commits — so the one thing worth asking before it is what the
 * document is called, and the address follows from that name. Folder and
 * address stay out of the way; the document lands in the folder being
 * browsed, and moving it later is one menu entry.
 *
 * A kind is still confirmed against a word, never an unlabeled glyph (the
 * reason `NewDocumentMenu` gives).
 */
export function NewDocumentSheet({
  open,
  defaultPath,
  pathForName,
  busy,
  error,
  onCancel,
  onCreate,
  onImport,
}: {
  open: boolean
  /** The address a create with no name would use; its folder is shown. */
  defaultPath: string
  /** The address a typed name earns, or the generated one when it earns none. */
  pathForName: (name: string) => string
  busy?: boolean | undefined
  error?: string | null | undefined
  onCancel: () => void
  onCreate: (kind: DocumentKind, options: { path: string; name: string | undefined }) => void
  onImport?: (() => void) | undefined
}) {
  const [name, setName] = useState('')
  const wasOpenRef = useRef(false)
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current
    wasOpenRef.current = open
    if (justOpened) setName('')
  }, [open])

  const trimmed = name.trim()
  const folder = defaultPath.includes('/') ? defaultPath.slice(0, defaultPath.lastIndexOf('/')) : ''
  const path = trimmed === '' ? defaultPath : pathForName(trimmed)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        data-testid="new-document-sheet"
        className="top-auto bottom-0 left-0 max-h-[85dvh] max-w-none translate-x-0 translate-y-0 gap-3 overflow-y-auto rounded-b-none px-4 pt-4 pb-6 sm:max-w-none"
        showCloseButton={false}
      >
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>New document</DialogTitle>
            <DialogDescription>
              {folder === '' ? 'Added to the workspace root.' : `Added to ${folder}.`}
            </DialogDescription>
          </DialogHeader>
          <DocumentNameField value={name} path={defaultPath} onChange={setName} autoFocus />
          {error !== null && error !== undefined && error !== '' && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            {DOCUMENT_KIND_CHOICES.map(({ kind, label, Icon }, index) => (
              <button
                key={kind}
                // The first is the form's default, so Return on the name
                // field makes the same document the first button does.
                type={index === 0 ? 'submit' : 'button'}
                disabled={busy}
                data-testid={`new-document-sheet-${kind}`}
                onClick={() => onCreate(kind, { path, name: trimmed === '' ? undefined : trimmed })}
                className="hover:bg-accent flex min-h-12 flex-1 items-center justify-center gap-2 rounded-md border text-sm font-medium disabled:opacity-50"
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
              </button>
            ))}
          </div>
          {onImport !== undefined && (
            <button
              type="button"
              disabled={busy}
              onClick={onImport}
              className="text-muted-foreground hover:text-foreground flex min-h-11 items-center justify-center gap-2 rounded-md text-sm"
            >
              <Upload aria-hidden="true" className="size-4" />
              Import file…
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground min-h-11 rounded-md text-sm"
          >
            Cancel
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
