/**
 * A row's picture of its document: the real render, scaled to fit.
 *
 * Not an approximation of the arrangement — the same SVG the preview beside
 * it enlarges, so the two panes cannot disagree about what a document looks
 * like. At row size nothing readable survives, and that is fine: the shape
 * is what tells one document from another.
 *
 * Loading is deferred to first sight (`useOnScreen`). A folder lists far
 * more rows than fit, and each picture costs a fetch of that document's
 * bytes plus a worker slot — both are spent only on what someone can see.
 */

import { FileText, LayoutGrid } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useOnScreen } from '../../hooks/useOnScreen.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { cn } from '../../lib/utils.js'
import { fitSvgToBox } from './fit-svg.js'
import type { DocumentRender } from './load-row-render.js'

export interface DocumentThumbnailProps {
  readonly document: WorkspaceDocumentEntry
  /**
   * Renders a document. Injected rather than fetched here so this component
   * stays free of the daemon client, and so a test can answer without a
   * network or a worker.
   */
  readonly loadRender: (document: WorkspaceDocumentEntry) => Promise<DocumentRender | null>
  readonly className?: string
}

export function DocumentThumbnail({ document, loadRender, className }: DocumentThumbnailProps) {
  const [ref, onScreen] = useOnScreen<HTMLSpanElement>()
  const [drawn, setDrawn] = useState<DocumentRender | null>(null)

  useEffect(() => {
    if (!onScreen) return
    let live = true
    loadRender(document)
      .then((render) => {
        if (live && render !== null) setDrawn(render)
      })
      // A row that cannot be drawn keeps its kind icon. A picture is a
      // convenience; failing to make one must not cost the row itself.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [onScreen, document, loadRender])

  return (
    <span
      ref={ref}
      data-testid="document-thumbnail"
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden', className)}
    >
      {drawn === null ? (
        document.kind === 'spatial' ? (
          <LayoutGrid data-kind="spatial" className="text-muted-foreground size-full" />
        ) : (
          <FileText
            data-kind={document.kind ?? 'markdown'}
            className="text-muted-foreground size-full"
          />
        )
      ) : (
        // The SVG is produced by this app's own renderer from the document's
        // own content, never by a remote party.
        // The rule lives on the span that actually PARENTS the svg. jsdom has
        // no layout, so a selector aimed one level too high still passes every
        // test and draws a 2000px canvas inside a 24px row in a real browser.
        <span
          className="size-full [&>svg]:size-full"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: same-origin render output from canvas-render, as the markdown preview pane does
          dangerouslySetInnerHTML={{ __html: fitSvgToBox(drawn.svg) }}
        />
      )}
    </span>
  )
}
