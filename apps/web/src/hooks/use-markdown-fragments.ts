/**
 * Async pre-rendering for math blocks and diagram fences, the fragment
 * sibling of `useReferenceSeams` (which loads what a document points at):
 * canvas-render's `renderMath` / `renderDiagram` seams are SYNCHRONOUS by
 * contract, and the real engines (MathJax, mermaid) are async dynamic
 * imports — so this hook renders each source string ahead of layout and
 * hands the preview cache lookups.
 * Totality mirrors the seams: a render failure caches as "missing" (the
 * layout keeps its documented fallback) and is never re-attempted in a
 * retry storm. A body the layout cannot parse asks for nothing.
 */

import type { RenderedSvgFragment } from '@kamiazya/whiteboard-canvas-render'
import { useCallback } from 'react'
import {
  type FragmentLoaders,
  type FragmentSeams,
  fenceFragmentKey,
  fragmentAskKey,
  loadFragment,
  mathFragmentKey,
} from '../lib/fragment-requests.js'
import { FRAGMENT_ENGINES } from '../lib/markdown-fragment-renderers.js'
import { fragmentRequests, type RenderMarkdownPreviewOptions } from '../lib/render-preview.js'
import { usePrefetchedCache } from './use-prefetched-cache.js'

export function useMarkdownFragments({
  body,
  layout: { measure, maxWidth, references, theme, tagLibrary },
  loaders = FRAGMENT_ENGINES,
}: {
  body: string
  /**
   * What the preview lays `body` out with. The wanted set is what THAT layout
   * asks for, so an embedded note's math and an embedded board's fences are
   * prefetched too — they resolve only through these references.
   */
  layout: Omit<RenderMarkdownPreviewOptions, 'background' | 'renderMath' | 'renderDiagram'>
  /** Injection seam for tests; defaults to the real MathJax/mermaid loaders. */
  loaders?: FragmentLoaders
}): FragmentSeams {
  // No transitive closure here, unlike the embed sibling: a rendered
  // fragment is an SVG string and cannot reference further sources.
  const lookup = usePrefetchedCache<RenderedSvgFragment>(
    useCallback(
      () =>
        fragmentRequests(body, { measure, maxWidth, references, theme, tagLibrary }).map((ask) => ({
          key: fragmentAskKey(ask),
          load: () => loadFragment(ask, loaders),
        })),
      [body, measure, maxWidth, references, theme, tagLibrary, loaders],
    ),
  )

  const renderMath = useCallback((value: string) => lookup(mathFragmentKey(value)), [lookup])
  const renderDiagram = useCallback(
    (lang: string, value: string) => lookup(fenceFragmentKey(lang, value)),
    [lookup],
  )
  return { renderMath, renderDiagram }
}
