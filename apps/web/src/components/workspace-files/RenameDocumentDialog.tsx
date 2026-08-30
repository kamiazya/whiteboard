import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DocumentPathField } from './DocumentPathField.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'

/**
 * The one place a document's two addresses are edited together, each field
 * saying what it is — the answer to "why are there two names?" is given
 * where the question arises, not in a doc nobody opens.
 *
 * The model stays untouched underneath: the name lives in the workspace and
 * may be empty (readers fall back to the path's last segment), the path is
 * placement and moving it takes everything under it. Neither field derives
 * the other (ADR-0008: a path is never invented from a name).
 */
export function RenameDocumentDialog({
  document,
  workspace,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  /** The document being renamed, or null when the dialog is closed. */
  document: WorkspaceDocumentEntry | null
  /** The handle its URL carries, so the path field can show where it lands. */
  workspace?: string | undefined
  busy: boolean
  /** Shown verbatim — the server names the path that actually collided. */
  error: string | null
  onCancel: () => void
  /** An empty trimmed name arrives as undefined: "clear it". */
  onSubmit: (name: string | undefined, newPath: string) => void
}) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')

  // Re-prime the fields for each newly targeted document; edits in a
  // cancelled dialog must not leak into the next one.
  useEffect(() => {
    setName(document?.name ?? '')
    setPath(document?.path ?? '')
  }, [document])

  return (
    <Dialog open={document !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-md">
        <form
          // `min-w-0`: this form is a GRID item of DialogContent, so its
          // automatic minimum size is its min-content width — and the path
          // field's URL prefix is unbreakable text. Measured without it, a
          // segment-less workspace's 26-character handle pushed the form to
          // 464px inside a 448px dialog, overflowing on every viewport
          // including a phone. With it the row is bounded and the handle
          // truncates instead.
          className="min-w-0"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmedName = name.trim()
            const trimmedPath = path.trim()
            if (trimmedPath === '') return
            onSubmit(trimmedName === '' ? undefined : trimmedName, trimmedPath)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>
              A document has a name and an address; change either here.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Name</span>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={path.split('/').at(-1) ?? ''}
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
              />
              <span className="text-muted-foreground text-xs">
                What it is called, everywhere it appears. Leave empty to show the last part of the
                path instead.
              </span>
            </label>
            <DocumentPathField
              workspace={workspace}
              value={path}
              onChange={setPath}
              hint="Where it lives in the workspace. Moving it takes everything under it along."
            />
            {error !== null && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Save
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
