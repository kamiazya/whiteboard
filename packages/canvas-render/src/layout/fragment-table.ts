import { type FragmentAsk, fragmentAskKey } from './fragment-ask.js'
import type { SpatialLayoutOptions } from './layout-options.js'
import type { RenderedSvgFragment } from './nodes/mdast-layout-options.js'

// The fragment seams answered from a table (`SpatialLayoutOptions.fragments`),
// for the layout in this package; the core answers the same table itself.

/** Whether the caller hands its fragments as a table: a table, or a listener for what one lacks. */
export function usesFragmentTable(options: SpatialLayoutOptions): boolean {
  return options.fragments !== undefined || options.onFragmentsAsked !== undefined
}

/**
 * `layout` with the table answering every seam the caller left unset, and
 * what it could not answer handed to `onFragmentsAsked` once each, in the
 * order the layout asked, when there is any. A later row answers ahead of an
 * earlier one with the same key.
 */
export function withFragmentTable<T>(
  options: SpatialLayoutOptions,
  layout: (options: SpatialLayoutOptions) => T,
): T {
  if (!usesFragmentTable(options)) return layout(options)
  const rendered = new Map(options.fragments ?? [])
  const asked = new Map<string, FragmentAsk>()
  const answer = (ask: FragmentAsk): RenderedSvgFragment | undefined => {
    const key = fragmentAskKey(ask)
    const found = rendered.get(key)
    if (found === undefined && !asked.has(key)) asked.set(key, ask)
    return found
  }
  const laid = layout({
    ...options,
    renderMath: options.renderMath ?? ((value) => answer({ kind: 'math', value })),
    renderDiagram:
      options.renderDiagram ?? ((lang, value) => answer({ kind: 'diagram', lang, value })),
  })
  if (asked.size > 0) options.onFragmentsAsked?.([...asked.values()])
  return laid
}
