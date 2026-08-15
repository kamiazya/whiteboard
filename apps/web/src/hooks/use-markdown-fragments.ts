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
import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { RenderedSvgFragment } from '@kamiazya/whiteboard-canvas-render'
import { useCallback, useEffect, useRef, useState } from 'react'
import { renderDiagramFragment, renderMathFragment } from '../lib/markdown-fragment-renderers.js'

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

type Wanted = {
  readonly key: string
  readonly render: () => Promise<RenderedSvgFragment | undefined>
}

/**
 * Every renderable fragment source in one parsed document. Keys carry the
 * kind and language so `x^2` as math and as a fence never collide. Total:
 * a mid-edit body the schema rejects has no fragments to offer.
 */
function collectFragmentSources(body: string, loaders: FragmentLoaders): readonly Wanted[] {
  try {
    const root = parseMarkdownBody(body)
    const wanted: Wanted[] = []
    for (const node of root.children) {
      if (node.type === 'math') {
        wanted.push({
          key: `math:${node.value}`,
          render: () => loaders.math(node.value, true),
        })
      }
      if (node.type === 'code' && node.lang) {
        const { lang, value } = node
        wanted.push({
          key: `${lang}:${value}`,
          render: () => loaders.diagram(lang, value),
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
  // `null` = render failed: a terminal answer that keeps the layout on its
  // fallback without re-rendering the same source forever.
  const [cache, setCache] = useState<ReadonlyMap<string, RenderedSvgFragment | null>>(new Map())
  const inflight = useRef<Set<string>>(new Set())
  // Unmount-scoped, NOT effect-scoped: a keystroke re-runs the effect while
  // a render is in flight and skips it as inflight — cancelling the old
  // completion per-effect would drop the result with nothing left to
  // re-fire it (the stuck-placeholder bug class).
  const unmounted = useRef(false)
  useEffect(() => {
    // Reset on the effect BODY, not just initialization: StrictMode's dev
    // double-mount runs this cleanup once before the real session, and a
    // flag that only ever goes true would silently drop every completion
    // for the component's whole life (dev-only, invisible in prod builds).
    unmounted.current = false
    return () => {
      unmounted.current = true
    }
  }, [])

  useEffect(() => {
    for (const { key, render } of collectFragmentSources(body, loaders)) {
      if (cache.has(key) || inflight.current.has(key)) continue
      inflight.current.add(key)
      void render()
        .catch(() => undefined)
        .then((fragment) => {
          inflight.current.delete(key)
          if (unmounted.current) return
          setCache((prev) => new Map(prev).set(key, fragment ?? null))
        })
    }
  }, [body, cache, loaders])

  const renderMath = useCallback(
    (value: string, _displayMode: boolean) => cache.get(`math:${value}`) ?? undefined,
    [cache],
  )
  const renderDiagram = useCallback(
    (lang: string, value: string) => cache.get(`${lang}:${value}`) ?? undefined,
    [cache],
  )
  return { renderMath, renderDiagram }
}
