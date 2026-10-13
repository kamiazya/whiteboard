/**
 * The canvas editor's math blocks and diagram fences, typeset.
 *
 * The layout's fragment seams are synchronous and the engines are not, and a
 * canvas cannot say up front which sources it holds: a text node's body, a
 * file node's note and a board embedded in either all ask through the same
 * seams. So the asks are learnt FROM the layout — the seams handed out here
 * record every source they could not answer, the layout worker reports its
 * own the same way — and each is rendered once; when it lands the seams
 * change identity, which is what lays the scene out again.
 *
 * A render that fails is terminal, as in the preview: asking again would
 * fail the same way on every layout.
 */

import type { RenderedSvgFragment } from '@kamiazya/whiteboard-canvas-render'
import { useCallback, useMemo, useState } from 'react'
import { usePrefetchedEntries } from '../../hooks/use-prefetched-cache.js'
import {
  type FragmentAsk,
  type FragmentEntry,
  type FragmentLoaders,
  type FragmentSeams,
  fragmentAskKey,
  loadFragment,
  recordingFragmentSeams,
} from '../../lib/fragment-requests.js'
import { FRAGMENT_ENGINES } from '../../lib/markdown-fragment-renderers.js'

export interface CanvasFragments {
  /** The seams every synchronous layout of this canvas takes. */
  readonly seams: FragmentSeams
  /** What has rendered, as plain data for the layout worker. */
  readonly entries: readonly FragmentEntry[]
  /** Sources a layout asked for that `entries` could not answer. */
  readonly onFragmentsAsked: (asks: readonly FragmentAsk[]) => void
}

export function useCanvasFragments(loaders: FragmentLoaders = FRAGMENT_ENGINES): CanvasFragments {
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
  return { seams, entries, onFragmentsAsked }
}
