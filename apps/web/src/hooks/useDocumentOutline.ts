/**
 * A document's shape, whichever kind it is — the one input every small
 * rendition of it takes: the favicon, a tree row's icon, a list card.
 *
 * A spatial canvas already IS boxes, so its outline costs a map. A markdown
 * document has none of its own and has to be laid out, which happens in the
 * shared worker pool at background priority. Both answer the same shape, so
 * a consumer never branches on kind.
 */

import type { DocumentKind, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useMemo } from 'react'
import { outlineFromSpatial } from '../lib/document-outline.js'
import type { FaviconRect } from '../lib/favicon.js'
import { useMarkdownOutline } from './useMarkdownOutline.js'

/**
 * The width a markdown document is laid out at for these renditions. Fixed
 * rather than the editor's measured pane: an icon has no pane, and a shape
 * that changed with the window would make the same document look different
 * on two screens.
 */
const OUTLINE_LAYOUT_WIDTH = 640

export function useDocumentOutline({
  kind,
  canvas,
  markdownBody,
}: {
  kind: DocumentKind
  canvas: SpatialCanvas
  markdownBody: string | null
}): readonly FaviconRect[] {
  const spatial = useMemo(
    () => (kind === 'markdown' ? [] : outlineFromSpatial(canvas)),
    [kind, canvas],
  )
  const markdown = useMarkdownOutline(markdownBody ?? '', {
    enabled: kind === 'markdown',
    maxWidth: OUTLINE_LAYOUT_WIDTH,
  })
  return kind === 'markdown' ? markdown.blocks : spatial
}
