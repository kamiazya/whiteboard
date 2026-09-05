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

  const KindIcon = document.kind === 'spatial' ? LayoutGrid : FileText

  return (
    <span
      ref={ref}
      data-testid="document-thumbnail"
      aria-hidden="true"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        className,
      )}
    >
      {drawn === null ? (
        // Sole content, and the only place `data-kind` appears: its ABSENCE
        // is how a test knows the render landed, so the copy that stays
        // behind during the cross-fade below must not carry it.
        <KindIcon
          data-kind={document.kind ?? 'markdown'}
          className="text-muted-foreground size-full"
        />
      ) : (
        <>
          {/* The icon LEAVES rather than vanishing. Measured on the real app
              before this: it unmounted in the same frame the render mounted
              at opacity 0 (1913ms icon=1.00 -> 1929ms icon gone, render=0.00),
              so the box was empty for a frame and the picture arrived over
              nothing. */}
          <KindIcon className="text-muted-foreground animate-out fade-out-0 fill-mode-forwards absolute inset-0 size-full duration-(--motion-duration-normal) ease-linear" />
          {/* The SVG is produced by this app's own renderer from the
              document's own content, never by a remote party.
              The rule lives on the span that actually PARENTS the svg. jsdom
              has no layout, so a selector aimed one level too high still
              passes every test and draws a 2000px canvas inside a 24px row in
              a real browser.

              Linear, not the shared ease-out: that curve is built for
              movement and front-loads opacity — measured, it reached 0.80 in
              51ms of its nominal 220ms, which is what read as a pop. A
              dissolve wants the two halves to trade evenly, and they now do:
              their opacities sum to 1.00 across the whole 220ms. */}
          <span
            className="animate-in fade-in-0 relative size-full duration-(--motion-duration-normal) ease-linear [&>svg]:size-full"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: same-origin render output from canvas-render, as the markdown preview pane does
            dangerouslySetInnerHTML={{ __html: fitSvgToBox(drawn.svg) }}
          />
        </>
      )}
    </span>
  )
}
