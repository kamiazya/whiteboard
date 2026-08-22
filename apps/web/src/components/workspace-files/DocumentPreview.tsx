/**
 * The preview pane: the selected document, drawn.
 *
 * It used to pour the OKF source into a `<pre>` — frontmatter, `[[links]]`
 * and all — which showed the file rather than the document, and showed
 * nothing at all for a spatial one. This draws the same SVG the card
 * beside it draws small, so the two panes cannot disagree about what a
 * document looks like.
 *
 * Reading, not editing. Opening is a separate, explicit act (the button),
 * for the reason VS Code's preview tab exists: browsing a folder should not
 * keep throwing you into an editor.
 */

import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { fitSvgToBox } from './fit-svg.js'
import { formatRelative } from './format-relative.js'
import type { DocumentRender } from './load-row-render.js'

export interface DocumentPreviewProps {
  /** `null` is the honest empty state: nothing is selected. */
  readonly document: WorkspaceDocumentEntry | null
  readonly loadRender: (document: WorkspaceDocumentEntry) => Promise<DocumentRender | null>
  readonly onOpen?: (document: WorkspaceDocumentEntry) => void
  /**
   * Move the document, and everything under it, to a new path. Absent means
   * the pane shows no way to move — reading still works.
   */
  /** Opens the shared Rename dialog (name + path together). */
  readonly onRename?: (document: WorkspaceDocumentEntry) => void
  /** Copy it. Absent means the pane offers no copy. */
  readonly onDuplicate?: (document: WorkspaceDocumentEntry) => void
  /**
   * ASK to delete it. The pane never performs the deletion: it is
   * destructive and takes the whole subtree, so the confirmation belongs to
   * whoever owns the data, not to the pane that happens to be showing it.
   */
  readonly onDelete?: (document: WorkspaceDocumentEntry) => void
  readonly className?: string
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'drawn'; path: string; svg: string }
  | { kind: 'blank'; path: string }

export function DocumentPreview({
  document,
  loadRender,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  className,
}: DocumentPreviewProps) {
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    if (document === null) {
      setState({ kind: 'idle' })
      return
    }
    let live = true
    setState({ kind: 'loading', path: document.path })
    loadRender(document)
      .then((render) => {
        if (!live) return
        setState(
          render === null
            ? { kind: 'blank', path: document.path }
            : { kind: 'drawn', path: document.path, svg: render.svg },
        )
      })
      // A document that will not draw is still a document: the pane keeps
      // its name, path and age rather than becoming an error.
      .catch(() => {
        if (live) setState({ kind: 'blank', path: document.path })
      })
    return () => {
      live = false
    }
  }, [document, loadRender])

  if (document === null) {
    return (
      <p className={cn('text-muted-foreground text-sm', className)}>
        Select a document to preview its content.
      </p>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)} data-testid="okf-preview">
      <div className="bg-muted/30 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border p-2">
        {state.kind === 'drawn' ? (
          // The same injection the editor's preview pane uses: the SVG comes
          // from this app's own renderer, over the document's own content.
          <div
            data-testid="preview-render"
            className="size-full [&>svg]:size-full"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: same-origin render output from canvas-render, as the markdown preview pane does
            dangerouslySetInnerHTML={{ __html: fitSvgToBox(state.svg) }}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            {state.kind === 'loading' ? 'Drawing…' : 'Nothing to draw yet.'}
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="truncate text-sm font-medium">
          {document.name ?? document.path.split('/').at(-1)}
        </h2>
        {/* The path is the address, not the name — so it goes here, quietly,
            where someone who needs it can read it. BOTH are edited in the
            Rename dialog, which is the one place that explains how they
            differ. */}
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-muted-foreground truncate font-mono text-xs">{document.path}</p>
          {onRename !== undefined && (
            <button
              type="button"
              onClick={() => onRename(document)}
              className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline"
            >
              Rename…
            </button>
          )}
        </div>
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 text-xs">
          <dt>Kind</dt>
          <dd className="text-foreground">{document.kind ?? 'markdown'}</dd>
          {document.updatedAt !== undefined && (
            <>
              <dt>Updated</dt>
              <dd className="text-foreground">{formatRelative(document.updatedAt)}</dd>
            </>
          )}
        </dl>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {onOpen !== undefined && (
            <button
              type="button"
              onClick={() => onOpen(document)}
              className="bg-primary text-primary-foreground rounded px-2.5 py-1 text-xs"
            >
              Open
            </button>
          )}
          {onDuplicate !== undefined && (
            <button
              type="button"
              onClick={() => onDuplicate(document)}
              className="rounded border px-2.5 py-1 text-xs"
            >
              Duplicate
            </button>
          )}
          {onDelete !== undefined && (
            <button
              type="button"
              onClick={() => onDelete(document)}
              className="text-destructive rounded border px-2.5 py-1 text-xs"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
