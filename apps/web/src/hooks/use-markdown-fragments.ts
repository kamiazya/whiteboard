/**
 * Async pre-rendering for math blocks and diagram fences, the fragment
 * sibling of `useReferenceSeams` (which loads what a document points at):
 * canvas-render's `renderMath` / `renderDiagram` seams are SYNCHRONOUS by
 * contract, and the real engines (MathJax, mermaid) are async dynamic
 * imports — so this hook renders each source string ahead of layout and
 * hands the preview cache lookups.
 * Totality mirrors the seams: a render failure caches as "missing" (the
 * layout keeps its documented fallback) and is never re-attempted in a
 * retry storm.
 */

import type { RenderedSvgFragment } from '@kamiazya/whiteboard-canvas-render'
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { MdastFlowContent, MdastListItem } from '@kamiazya/whiteboard-model/mdast'
import { useCallback } from 'react'
import {
  fenceFragmentKey,
  mathFragmentKey,
  renderDiagramFragment,
  renderMathFragment,
} from '../lib/markdown-fragment-renderers.js'
import { type PrefetchRequest, usePrefetchedCache } from './use-prefetched-cache.js'

export interface FragmentRenderers {
  readonly renderMath: (value: string) => RenderedSvgFragment | undefined
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
 * Every renderable fragment source in one parsed document, at ANY depth: the
 * layout reaches a math block in a blockquote or a fence in a list item, so
 * a collector that stopped at the top level would leave those on their
 * source placeholder on screen while the export typesets them. Total: a
 * mid-edit body the schema rejects has no fragments to offer.
 */
function collectFragmentSources(
  body: string,
  loaders: FragmentLoaders,
): readonly PrefetchRequest<RenderedSvgFragment>[] {
  try {
    const wanted: PrefetchRequest<RenderedSvgFragment>[] = []
    const visit = (nodes: readonly (MdastFlowContent | MdastListItem)[]): void => {
      for (const node of nodes) {
        if (node.type === 'math') {
          const { value } = node
          wanted.push({ key: mathFragmentKey(value), load: () => loaders.math(value) })
        } else if (node.type === 'code' && node.lang) {
          const { lang, value } = node
          wanted.push({
            key: fenceFragmentKey(lang, value),
            load: () => loaders.diagram(lang, value),
          })
        } else if (node.type === 'blockquote' || node.type === 'list' || node.type === 'listItem') {
          visit(node.children)
        }
      }
    }
    visit(parseMarkdownBody(body).children)
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

  const renderMath = useCallback((value: string) => lookup(mathFragmentKey(value)), [lookup])
  const renderDiagram = useCallback(
    (lang: string, value: string) => lookup(fenceFragmentKey(lang, value)),
    [lookup],
  )
  return { renderMath, renderDiagram }
}
