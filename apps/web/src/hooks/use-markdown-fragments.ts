/**
 * Async pre-rendering for math blocks and diagram fences, the fragment
 * sibling of `useMarkdownEmbedContent`: canvas-render's `renderMath` /
 * `renderDiagram` seams are SYNCHRONOUS by contract, and the real engines
 * (MathJax, mermaid) are async dynamic imports — so this hook renders each
 * source string ahead of layout and hands the preview cache lookups.
 * Totality mirrors the seams: a render failure caches as "missing" (the
 * layout keeps its documented fallback) and is never re-attempted in a
 * retry storm.
 */

import type { RenderedSvgFragment } from '@kamiazya/whiteboard-canvas-render'
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import { useCallback } from 'react'
import { renderDiagramFragment, renderMathFragment } from '../lib/markdown-fragment-renderers.js'
import { type PrefetchRequest, usePrefetchedCache } from './use-prefetched-cache.js'

export interface FragmentRenderers {
  readonly renderMath: (value: string, displayMode: boolean) => RenderedSvgFragment | undefined
  readonly renderDiagram: (lang: string, value: string) => RenderedSvgFragment | undefined
}

export interface FragmentLoaders {
  readonly math: typeof renderMathFragment
  readonly diagram: typeof renderDiagramFragment
}

const DEFAULT_LOADERS: FragmentLoaders = {
  math: renderMathFragment,
  diagram: renderDiagramFragment,
}

/**
 * Every renderable fragment source in one parsed document. Keys carry a
 * kind namespace and the fence language, so a $$ math block and a
 * ```math fence with identical source never share a cache row. Total:
 * a mid-edit body the schema rejects has no fragments to offer.
 */
function collectFragmentSources(
  body: string,
  loaders: FragmentLoaders,
): readonly PrefetchRequest<RenderedSvgFragment>[] {
  try {
    const root = parseMarkdownBody(body)
    const wanted: PrefetchRequest<RenderedSvgFragment>[] = []
    for (const node of root.children) {
      if (node.type === 'math') {
        wanted.push({
          key: `math:${node.value}`,
          load: () => loaders.math(node.value, true),
        })
      }
      if (node.type === 'code' && node.lang) {
        const { lang, value } = node
        wanted.push({
          key: `fence:${lang}:${value}`,
          load: () => loaders.diagram(lang, value),
        })
      }
    }
    return wanted
  } catch {
    return []
  }
}

export function useMarkdownFragments({
  body,
  loaders = DEFAULT_LOADERS,
}: {
  body: string
  /** Injection seam for tests; defaults to the real MathJax/mermaid loaders. */
  loaders?: FragmentLoaders
}): FragmentRenderers {
  // No transitive closure here, unlike the embed sibling: a rendered
  // fragment is an SVG string and cannot reference further sources.
  const lookup = usePrefetchedCache<RenderedSvgFragment>(
    useCallback(() => collectFragmentSources(body, loaders), [body, loaders]),
  )

  const renderMath = useCallback(
    (value: string, _displayMode: boolean) => lookup(`math:${value}`),
    [lookup],
  )
  const renderDiagram = useCallback(
    (lang: string, value: string) => lookup(`fence:${lang}:${value}`),
    [lookup],
  )
  return { renderMath, renderDiagram }
}
