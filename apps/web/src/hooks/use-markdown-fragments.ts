/**
 * Math blocks and diagram fences, typeset — for every surface that lays a
 * body out: the note preview, the canvas editor, version history.
 *
 * The layout's fragment seams are synchronous and the engines are not, and a
 * surface cannot say up front which sources it holds: a note's own blocks, an
 * embedded note's, a canvas text node's body, a file node's note and a board
 * embedded in any of them all ask through the same seams. So the asks are
 * learnt FROM the layout — the seams handed out here record every source they
 * could not answer, the layout worker reports its own the same way — and each
 * is rendered once; when it lands the seams change identity, which is what
 * lays the surface out again. A surface that lays nothing out (the note
 * editor's Write mode) therefore asks for nothing and loads no engine.
 *
 * A render that fails is terminal: asking again would fail the same way on
 * every layout.
 */

import {
  type FragmentAsk,
  type FragmentEntry,
  fragmentAskKey,
  type RenderedSvgFragment,
} from '@kamiazya/whiteboard-canvas-render'
import { useCallback, useMemo, useState } from 'react'
import {
  type FragmentLoaders,
  type FragmentSeams,
  type FragmentTable,
  loadFragment,
  recordingFragmentSeams,
} from '../lib/fragment-requests.js'
import { FRAGMENT_ENGINES } from '../lib/markdown-fragment-renderers.js'
import { usePrefetchedEntries } from './use-prefetched-cache.js'

export interface MarkdownFragments {
  /** The seams every synchronous layout of this surface takes. */
  readonly seams: FragmentSeams
  /** What has rendered, as plain data for the layout worker. */
  readonly entries: readonly FragmentEntry[]
  /** Sources a layout asked for that `entries` could not answer. */
  readonly onFragmentsAsked: (asks: readonly FragmentAsk[]) => void
  /**
   * `entries` as the table a synchronous spatial layout of this surface
   * takes, whose misses are reported once the render is over. The table, not
   * `seams`, is what the Rust core can be handed (ADR-0054 step 7).
   */
  readonly table: FragmentTable
}

/** @param loaders Injection seam for tests; defaults to the real MathJax/mermaid loaders. */
export function useMarkdownFragments(
  loaders: FragmentLoaders = FRAGMENT_ENGINES,
): MarkdownFragments {
  const [asked, setAsked] = useState<ReadonlyMap<string, FragmentAsk>>(new Map())
  const cache = usePrefetchedEntries<RenderedSvgFragment>(
    useCallback(
      () => [...asked].map(([key, ask]) => ({ key, load: () => loadFragment(ask, loaders) })),
      [asked, loaders],
    ),
  )
  const onFragmentsAsked = useCallback((asks: readonly FragmentAsk[]) => {
    setAsked((prev) => {
      const fresh = asks.filter((ask) => !prev.has(fragmentAskKey(ask)))
      if (fresh.length === 0) return prev
      return new Map([...prev, ...fresh.map((ask) => [fragmentAskKey(ask), ask] as const)])
    })
  }, [])

  const seams = useMemo(
    () =>
      recordingFragmentSeams(
        (key) => cache.get(key) ?? undefined,
        (ask, key) => {
          // A synchronous layout runs during render, where state cannot be
          // set, so the miss is reported once the render is over.
          if (!cache.has(key)) queueMicrotask(() => onFragmentsAsked([ask]))
        },
      ),
    [cache, onFragmentsAsked],
  )
  const entries = useMemo(
    () =>
      [...cache].flatMap(([key, fragment]): FragmentEntry[] =>
        fragment === null ? [] : [[key, fragment]],
      ),
    [cache],
  )
  const table = useMemo<FragmentTable>(
    () => ({
      fragments: entries,
      // A synchronous layout runs during render, where state cannot be set.
      onFragmentsAsked: (asks) => queueMicrotask(() => onFragmentsAsked(asks)),
    }),
    [entries, onFragmentsAsked],
  )
  return { seams, entries, onFragmentsAsked, table }
}
