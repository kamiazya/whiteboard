/**
 * A comment message's prose, drawn as the markdown it is.
 *
 * A comment's body has always been markdown on the canvas —
 * `layoutSpatialCanvas` sends it through the same mdast pipeline a text
 * node's body takes — and it was raw text everywhere in this app, so
 * `**tighten**` read as emphasis in the bubble and as four asterisks in
 * the rail beside it. `commentMessageSchema.body` is a bare string and
 * declares no format, so nothing was red; the two surfaces had simply
 * never been asked to agree.
 *
 * It renders through canvas-render, NOT through a markdown-to-HTML step,
 * for the reason `package-codec.md` records for the preview pane: a second
 * renderer is how a surface comes to disagree with the export. The
 * producer is `layoutCommentBody`, which fixes the metrics a comment is
 * laid out with, so this and the bubble cannot pick different ones.
 *
 * What that costs, said plainly because it is a real cost and not an
 * oversight: the body is `<text>` elements rather than a paragraph, so it
 * carries no heading or list semantics into the accessibility tree. That is
 * the same trade the document preview already makes, and making a different
 * one here would leave the app with two conventions for the same question.
 */
import {
  layoutCommentBody,
  type MeasureText,
  renderSceneToKeyedSvg,
  SPATIAL_THEME_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useKeyedSvg } from '../../lib/use-keyed-svg.js'
import { cn } from '../../lib/utils.js'

/**
 * Until the container has been measured. A comment is read in a rail whose
 * width is a layout outcome, so the first paint has to guess — and it
 * guesses the bubble's own measure, which is the width this body is drawn
 * at everywhere else.
 */
const UNMEASURED_WIDTH_PX = 200

/** Room for a descender and the fade a truncated run paints. */
const BODY_PADDING_PX = 1

export interface CommentBodyProps {
  readonly body: string
  /** The panel's dense typography; the card inherits the bubble's own. */
  readonly compact?: boolean
  readonly className?: string
  /** Injected by tests and by a host that already has one. */
  readonly measure?: MeasureText
}

export function CommentBody({ body, compact, className, measure }: CommentBodyProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])

  useEffect(() => {
    const element = host.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      // A rail mid-transition reports 0, and laying prose out to zero width
      // is one glyph per line. Keep the last real measure until there is a
      // new real one.
      if (next !== undefined && next > 1) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const keyed = useMemo(() => {
    const scene = layoutCommentBody(body, {
      measure: resolvedMeasure,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
      maxWidth: width ?? UNMEASURED_WIDTH_PX,
    })
    return renderSceneToKeyedSvg(scene, { padding: BODY_PADDING_PX })
  }, [body, resolvedMeasure, width])

  const mount = useKeyedSvg(keyed)
  // One stable callback: an inline arrow here changes identity every render,
  // and React answers a changed ref callback by calling it with null first —
  // which detaches the patcher's container and remounts the SVG from scratch
  // on every keystroke in the box above it.
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      host.current = element
      mount(element)
    },
    [mount],
  )
  return (
    <div
      ref={attach}
      data-comment-body=""
      className={cn(compact === true && 'text-xs', className)}
      // `currentColor`, not a palette value: canvas-render assigns markdown
      // body runs no fill of their own precisely so they inherit one, and
      // each `<text>` would otherwise take the SVG default — black — on
      // every theme. Taking the colour the host's own CSS already resolves
      // means this follows the theme with no theme prop threaded down to it
      // and no second copy of the palette. (The preview pane needs the
      // literal value instead, because it also feeds a `--preview-fill`
      // custom property that Chromium's :visited handling will not read
      // through `inherit`.)
      style={{ fill: 'currentColor' } as CSSProperties}
    />
  )
}
