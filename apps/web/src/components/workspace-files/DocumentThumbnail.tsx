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

import { SceneSvg } from '@kamiazya/whiteboard-canvas-viewer'
import { FileText, LayoutGrid } from 'lucide-react'
import { type MouseEvent, useEffect, useState } from 'react'
import { useOnScreen } from '../../hooks/useOnScreen.js'
import { useThemeFontsGeneration } from '../../hooks/useThemeFonts.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { PREVIEW_PADDING_PX } from '../../lib/preview-padding.js'
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

/**
 * The row's title names the document, so the picture is decoration: hidden
 * from assistive technology, and `inert` so nothing drawn in it — a link in
 * a note, say — is reachable by Tab inside a span the tree is told to skip.
 */
// `geometricPrecision` (the thumbnail's SVG class below) because the picture is
// laid out at full size and shrunk by its viewBox: the default text rendering
// rounds each glyph advance at the SHRUNK pixel size, which spaces a word's
// letters apart instead of scaling the layout.
const PICTURE_HOST = { 'data-testid': 'document-thumbnail', 'aria-hidden': true, inert: true }

/**
 * A link drawn in the picture must not navigate: the card around it is the
 * click target, and the renderer's bare document-id href, followed by the
 * browser, reloads the tab onto a route naming no document. The click still
 * bubbles, so the card opens. `inert` already keeps a real pointer off the
 * link; this capture is what holds for a click that is not hit-tested.
 */
function keepLinksInert(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('a') !== null) event.preventDefault()
}

/** Wider than this, a note's picture is a line of text, not a page. */
const STRIP_ASPECT = 2.5

function fitFor(document: WorkspaceDocumentEntry, bounds: DocumentRender['bounds']) {
  const isStrip = bounds.h > 0 && bounds.w / bounds.h > STRIP_ASPECT
  return document.kind !== 'spatial' && isStrip ? 'cover-start' : 'contain'
}

/**
 * A note's picture as a thumbnail: cropped to its ink. Its `bounds` reach
 * from the viewBox origin to the far edge of the text, the near margin
 * included, so the far margin is the one added here.
 */
function thumbnailSvg(document: WorkspaceDocumentEntry, drawn: DocumentRender): string {
  const fit = fitFor(document, drawn.bounds)
  if (document.kind !== 'markdown') return fitSvgToBox(drawn.svg, fit)
  return fitSvgToBox(drawn.svg, fit, {
    w: drawn.bounds.w + PREVIEW_PADDING_PX,
    h: drawn.bounds.h + PREVIEW_PADDING_PX,
  })
}

/**
 * The kind icon, before a picture lands or in place of one. An empty
 * document says so under it: a blank pane reads as a picture that failed to
 * draw.
 */
function Undrawn({ document, empty }: { document: WorkspaceDocumentEntry; empty: boolean }) {
  const KindIcon = document.kind === 'spatial' ? LayoutGrid : FileText
  return (
    <span className="flex size-full flex-col items-center justify-center gap-1">
      <KindIcon
        data-kind={document.kind ?? 'markdown'}
        className={cn('text-muted-foreground min-h-0 w-full flex-1', empty && 'opacity-60')}
      />
      {empty && <span className="text-muted-foreground text-xs leading-none">Empty</span>}
    </span>
  )
}

export function DocumentThumbnail({ document, loadRender, className }: DocumentThumbnailProps) {
  const [ref, onScreen] = useOnScreen<HTMLSpanElement>()
  const [drawn, setDrawn] = useState<DocumentRender | null>(null)
  const [empty, setEmpty] = useState(false)
  // Read for its CHANGE, not its value: a board that names a theme is drawn
  // in the bundled family until this tab holds that theme's face, and the
  // ask for the face is made by the render below — so the row that triggered
  // the fetch is the row that has to be drawn again once it lands.
  const fontsGeneration = useThemeFontsGeneration()

  useEffect(() => {
    if (!onScreen) return
    let live = true
    loadRender(document)
      .then((render) => {
        if (!live) return
        if (render !== null) setDrawn(render)
        // The loader answers nothing for a document with nothing in it.
        setEmpty(render === null)
      })
      // A row that cannot be drawn keeps its kind icon. A picture is a
      // convenience; failing to make one must not cost the row itself.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [onScreen, document, loadRender, fontsGeneration])

  const KindIcon = document.kind === 'spatial' ? LayoutGrid : FileText
  return (
    <span
      ref={ref}
      {...PICTURE_HOST}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        className,
      )}
    >
      {drawn === null ? (
        // Sole content, and the only place `data-kind` appears: its ABSENCE
        // is how a test knows the render landed, so the copy that stays
        // behind during the cross-fade below must not carry it.
        <Undrawn document={document} empty={empty} />
      ) : (
        <>
          {/* The render comes FIRST in document order, and rides above the
              icon on z-10 rather than by being later in the tree. Both halves
              are svgs now, and this box is reached for with
              `querySelector('svg')` in more than one place — the same hazard
              DocumentMinimap and MinimapOverlay each carry a note about. Put
              the leaving icon first and that selector starts answering with
              a 24x24 kind glyph instead of the document's own render.

              The SVG is produced by this app's own renderer from the
              document's own content, never by a remote party. The size rule
              lives on the span that actually PARENTS the svg: jsdom has no
              layout, so a selector aimed one level too high still passes
              every test and draws a 2000px canvas inside a 24px row in a
              real browser.

              Linear, not the shared ease-out: that curve is built for
              movement and front-loads opacity — measured, it reached 0.80 in
              51ms of its nominal 220ms, which is what read as a pop. A
              dissolve wants the two halves to trade evenly, and they now do:
              their opacities sum to 1.00 across the whole 220ms. */}
          <SceneSvg
            as="span"
            svg={thumbnailSvg(document, drawn)}
            onClickCapture={keepLinksInert}
            className="animate-in fade-in-0 relative z-10 size-full duration-(--motion-duration-normal) ease-linear [&>svg]:size-full [&>svg]:[text-rendering:geometricPrecision]"
          />
          {/* The icon LEAVES rather than vanishing. Measured on the real app
              before this: it unmounted in the same frame the render mounted
              at opacity 0 (1913ms icon=1.00 -> 1929ms icon gone, render=0.00),
              so the box was empty for a frame and the picture arrived over
              nothing. No `data-kind` here: its absence is how a test knows a
              render landed. */}
          <KindIcon className="text-muted-foreground animate-out fade-out-0 fill-mode-forwards absolute inset-0 size-full duration-(--motion-duration-normal) ease-linear" />
        </>
      )}
    </span>
  )
}
