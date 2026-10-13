/**
 * Which math blocks and diagram fences a layout asks for, answered by the
 * layout itself.
 *
 * canvas-render's `renderMath` / `renderDiagram` seams are synchronous and
 * the engines behind them (MathJax, mermaid) are not, so every surface that
 * typesets has to know the sources BEFORE the layout that draws them. The
 * only complete answer is the layout's own: an embedded note, an embedded
 * board's text nodes and a file node's note each ask through the same seams,
 * and a hand walk over one body's tree misses whatever the layout learns to
 * reach next. So every surface records what the seams were asked for, here.
 *
 * Pure and engine-free: the layout worker imports this, and the engines
 * themselves stay behind `markdown-fragment-renderers.ts`'s dynamic imports.
 */

import type { RenderedSvgFragment } from '@kamiazya/whiteboard-canvas-render'
import { z } from 'zod'

/**
 * One source a layout asked a fragment seam for. Plain data: it crosses to and
 * from the worker, and the render store persists it as JSON — so the stored
 * reply parses it with this schema, and a kind added here reaches both.
 */
export const fragmentAskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('math'), value: z.string() }),
  z.object({ kind: z.literal('diagram'), lang: z.string(), value: z.string() }),
])

export type FragmentAsk = Readonly<z.infer<typeof fragmentAskSchema>>

/** A rendered fragment by its key, as it crosses to the layout worker. */
export type FragmentEntry = readonly [key: string, fragment: RenderedSvgFragment]

/** The async engines behind the two seams. */
export interface FragmentLoaders {
  readonly math: (value: string) => Promise<RenderedSvgFragment | undefined>
  readonly diagram: (lang: string, value: string) => Promise<RenderedSvgFragment | undefined>
}

/** The two layout seams, in the shape every layout this app runs accepts. */
export interface FragmentSeams {
  readonly renderMath: (value: string) => RenderedSvgFragment | undefined
  readonly renderDiagram: (lang: string, value: string) => RenderedSvgFragment | undefined
}

/**
 * The cache key of a rendered math block and of a rendered fence. The kind
 * prefix keeps a `$$` block and a same-source ```math fence in separate rows.
 */
const mathFragmentKey = (value: string): string => `math:${value}`
const fenceFragmentKey = (lang: string, value: string): string => `fence:${lang}:${value}`

export function fragmentAskKey(ask: FragmentAsk): string {
  return ask.kind === 'math' ? mathFragmentKey(ask.value) : fenceFragmentKey(ask.lang, ask.value)
}

export function loadFragment(
  ask: FragmentAsk,
  loaders: FragmentLoaders,
): Promise<RenderedSvgFragment | undefined> {
  return ask.kind === 'math' ? loaders.math(ask.value) : loaders.diagram(ask.lang, ask.value)
}

/**
 * Seams that answer from `lookup` and hand every source they could not
 * answer to `onMiss`. A lookup that answers nothing makes this a pure
 * recording pass.
 */
export function recordingFragmentSeams(
  lookup: (key: string) => RenderedSvgFragment | undefined,
  onMiss: (ask: FragmentAsk, key: string) => void,
): FragmentSeams {
  const answer = (ask: FragmentAsk): RenderedSvgFragment | undefined => {
    const key = fragmentAskKey(ask)
    const found = lookup(key)
    if (found === undefined) onMiss(ask, key)
    return found
  }
  return {
    renderMath: (value) => answer({ kind: 'math', value }),
    renderDiagram: (lang, value) => answer({ kind: 'diagram', lang, value }),
  }
}

/** Runs `layout` once with recording seams; the distinct sources it asked for, in order. */
function recordFragmentAsks<T>(layout: (seams: FragmentSeams) => T): {
  readonly result: T
  readonly asks: readonly FragmentAsk[]
} {
  const asked = new Map<string, FragmentAsk>()
  const seams = recordingFragmentSeams(
    () => undefined,
    (ask, key) => {
      if (!asked.has(key)) asked.set(key, ask)
    },
  )
  const result = layout(seams)
  return { result, asks: [...asked.values()] }
}

/**
 * A layout with its fragments drawn, for a surface that can WAIT — a saved
 * picture. The first pass records what the layout asks for and the second
 * answers from what rendered; a fragment that fails keeps the layout's own
 * fallback, as it does on screen. Nothing asked, the first pass is the answer.
 */
export async function layoutWithFragments<T>(
  layout: (seams: FragmentSeams) => T,
  loaders: FragmentLoaders,
): Promise<T> {
  const { result, asks } = recordFragmentAsks(layout)
  if (asks.length === 0) return result
  const rendered = new Map(
    await Promise.all(
      asks.map(
        async (ask) =>
          [fragmentAskKey(ask), await loadFragment(ask, loaders).catch(() => undefined)] as const,
      ),
    ),
  )
  return layout(
    recordingFragmentSeams(
      (key) => rendered.get(key),
      () => {},
    ),
  )
}
