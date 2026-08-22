import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DOCUMENT_KIND_CHOICES } from './document-kind-choice.js'

/**
 * The long way to create a document, for the person who already knows what
 * it is called and where it goes.
 *
 * It sits BEHIND a menu entry rather than in front of every create, because
 * the moment before a document exists is the worst moment to name it —
 * there is nothing yet to name. An empty field at that point reads as
 * something to fill in, and the honest answer is usually `untitled`. That is
 * ADR-0006 point 3, and it is why `Path` arrives pre-filled with the very
 * address the plain menu entries would have used: submitting this form
 * untouched produces exactly what not opening it would have.
 *
 * Neither field derives the other (ADR-0008: a path is never invented from a
 * name), which is the same contract `RenameDocumentDialog` states — and this
 * form deliberately mirrors its layout, since the two edit the same two
 * addresses at different moments.
 *
 * Kind is the one field here that is not a convenience: nothing rewrites it
 * later, so it is chosen now or it is wrong for good.
 */
export function NewDocumentDialog({
  open,
  defaultPath,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  open: boolean
  /** Where a create with no opinion would have put it. */
  defaultPath: string
  busy?: boolean
  /** Shown verbatim — the server names the path that actually collided. */
  error?: string | null
  onCancel: () => void
  onSubmit: (kind: DocumentKind, options: { path: string; name: string | undefined }) => void
}) {
  const [kind, setKind] = useState<DocumentKind>('spatial')
  const [name, setName] = useState('')
  const [path, setPath] = useState(defaultPath)
  // The form's own refusal, kept apart from the host's `error` so a stale
  // server message cannot outlive the field that has since been corrected.
  const [pathIssue, setPathIssue] = useState<string | null>(null)

  // Re-prime on each opening: a cancelled edit must not leak into the next
  // one, and `defaultPath` moves as documents are created around it.
  useEffect(() => {
    if (!open) return
    setKind('spatial')
    setName('')
    setPath(defaultPath)
    setPathIssue(null)
  }, [open, defaultPath])

  const shownError =
    pathIssue ?? (error !== null && error !== undefined && error !== '' ? error : null)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const trimmedPath = path.trim()
            if (trimmedPath === '') {
              // Returning in silence made Create look like a dead button: the
              // one field with no default a person could fall back on is the
              // one that has to say why it was refused.
              setPathIssue('A path is required — it is where the document lives.')
              return
            }
            setPathIssue(null)
            const trimmedName = name.trim()
            onSubmit(kind, {
              path: trimmedPath,
              name: trimmedName === '' ? undefined : trimmedName,
            })
          }}
        >
          <DialogHeader>
            <DialogTitle>New document</DialogTitle>
            <DialogDescription>
              A document has a kind, a name, and an address. Only the kind is fixed once it exists.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Kind</legend>
              <div className="flex gap-2 pt-1">
                {DOCUMENT_KIND_CHOICES.map((choice) => (
                  <label
                    key={choice.kind}
                    className="has-checked:border-primary flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="new-document-kind"
                      value={choice.kind}
                      checked={kind === choice.kind}
                      onChange={() => setKind(choice.kind)}
                    />
                    <choice.Icon aria-hidden="true" className="size-4" />
                    {choice.label}
                  </label>
                ))}
              </div>
              <span className="text-muted-foreground text-xs">
                What it is. Nothing changes this afterwards — a document of the wrong kind has to be
                deleted and made again.
              </span>
            </fieldset>
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
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Path</span>
              <input
                type="text"
                value={path}
                onChange={(event) => {
                  setPath(event.target.value)
                  setPathIssue(null)
                }}
                className="rounded-md border bg-background px-2 py-1.5 font-mono text-sm"
              />
              <span className="text-muted-foreground text-xs">
                Where it lives in the workspace. Folders are the path, so design/login sits under
                design.
              </span>
            </label>
            {/* The form's own refusal wins: it names the field the person is
                looking at, while `error` describes a submission that has
                already been superseded by whatever they typed next. */}
            {shownError !== null && (
              <p role="alert" className="text-destructive text-sm">
                {shownError}
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
              Create
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
