import { type RefObject, useCallback, useEffect } from 'react'
import type { RailBlock } from '../../lib/rail-geometry.js'
import type { PreviewBlockAnchor } from '../../lib/render-preview.js'
import { lineForDocumentY } from './anchor-mapping.js'
import {
  centredPreviewTop,
  followingPreviewTop,
  railContentHeight,
  totalSourceLines,
} from './preview-geometry.js'
import type { SourcePaneApi } from './SourcePane.js'

/**
 * Keeps the two panes pointing at the same place: the preview follows the
 * source as it scrolls, and a press on the rail moves whichever pane is on
 * screen. The anchors and blocks are read through refs, lazily, because the
 * preview fills them on every render and a scroll handler must see the
 * latest without re-subscribing.
 */
export interface PaneScrollSyncInput {
  readonly value: string
  readonly sourceWrapRef: RefObject<HTMLDivElement | null>
  readonly previewScrollRef: RefObject<HTMLDivElement | null>
  readonly sourceApiRef: RefObject<SourcePaneApi | null>
  readonly anchorsRef: RefObject<readonly PreviewBlockAnchor[]>
  readonly blocksRef: RefObject<readonly RailBlock[]>
}

/** Moves the pane on screen to a laid-out document position (a rail press). */
export interface PaneSeeks {
  readonly seekSource: (documentY: number) => void
  readonly seekPreview: (documentY: number) => void
}

export function usePaneScrollSync(input: PaneScrollSyncInput): PaneSeeks {
  const { value, sourceWrapRef, previewScrollRef, sourceApiRef, anchorsRef, blocksRef } = input
  // Source -> preview. Line-accurate through the anchors; the proportional
  // map is the fallback while they are unavailable (an unparseable mid-edit
  // body, the first render), which keeps the preview in the neighbourhood —
  // what split editors (VS Code's markdown preview, HackMD) ship as their
  // baseline.
  useEffect(() => {
    const scroller = sourceWrapRef.current?.querySelector('.cm-scroller')
    if (!(scroller instanceof HTMLElement)) return
    const onScroll = () => {
      const preview = previewScrollRef.current
      if (!preview) return
      const top = followingPreviewTop(
        scroller,
        preview,
        anchorsRef.current,
        sourceApiRef.current,
        totalSourceLines(value),
      )
      if (top !== undefined) preview.scrollTop = top
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [value])

  // Write mode has no preview on screen, so the rail drives the SOURCE:
  // a press is a document position, and the anchors say which line that is.
  const seekSource = useCallback(
    (documentY: number) => {
      const api = sourceApiRef.current
      if (api === null) return
      api.revealLine(
        lineForDocumentY(anchorsRef.current, documentY, {
          totalLines: totalSourceLines(value),
          contentHeight: railContentHeight(blocksRef.current),
        }),
      )
    },
    [value],
  )

  const seekPreview = useCallback((documentY: number) => {
    const preview = previewScrollRef.current
    if (preview !== null) preview.scrollTop = centredPreviewTop(preview, documentY)
  }, [])

  return { seekSource, seekPreview }
}
