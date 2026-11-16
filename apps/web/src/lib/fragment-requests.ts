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

import {
  type FragmentAsk,
  type FragmentEntry,
  fragmentAskKey,
  type RenderedSvgFragment,
} from '@kamiazya/whiteboard-canvas-render'

// The vocabulary (`FragmentAsk`, `FragmentEntry`, `fragmentAskKey`) is
// canvas-render's: the Rust core rebuilds the same keys from a layout
// request's table, so the key format has one definition.

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

/**
 * The two layout options that carry fragments as data: what has rendered,
 * and a listener for the sources it could not answer. This is the shape
 * every spatial layout this app runs takes, because a function seam is one
 * the Rust core cannot be handed (the request gate skips it), and a table is.
 */
export interface FragmentTable {
  readonly fragments: readonly FragmentEntry[]
  readonly onFragmentsAsked: (asks: readonly FragmentAsk[]) => void
}

/**
 * A table over `entries` that collects every source a layout could not
 * answer, once each, in the order asked — for a layout whose caller reads
 * the asks after it returns (the worker reports them, an export renders them).
 */
export function recordingFragmentTable(entries: readonly FragmentEntry[] = []): FragmentTable & {
  readonly asked: ReadonlyMap<string, FragmentAsk>
} {
  const asked = new Map<string, FragmentAsk>()
  return {
    fragments: entries,
    onFragmentsAsked: (asks) => {
      for (const ask of asks) {
        const key = fragmentAskKey(ask)
        if (!asked.has(key)) asked.set(key, ask)
      }
    },
    asked,
  }
}

/**
 * A layout with its fragments drawn, for a surface that can WAIT — a saved
 * picture. The first pass records what the layout asks for and the second
 * answers from what rendered; a fragment that fails keeps the layout's own
 * fallback, as it does on screen. Nothing asked, the first pass is the answer.
 */
export async function layoutWithFragments<T>(
  layout: (table: FragmentTable) => T,
  loaders: FragmentLoaders,
): Promise<T> {
  const first = recordingFragmentTable()
  const result = layout(first)
  if (first.asked.size === 0) return result
  const rendered = await Promise.all(
    [...first.asked].map(
      async ([key, ask]) => [key, await loadFragment(ask, loaders).catch(() => undefined)] as const,
    ),
  )
  return layout(
    recordingFragmentTable(
      rendered.flatMap(([key, fragment]): FragmentEntry[] =>
        fragment === undefined ? [] : [[key, fragment]],
      ),
    ),
  )
}
