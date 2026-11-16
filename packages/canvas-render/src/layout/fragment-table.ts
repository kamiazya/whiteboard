import { type FragmentAsk, fragmentAskKey } from '../fragment-ask.js'
import type { ResolvedLayoutOptions, SpatialLayoutOptions } from './layout-options.js'
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
  layout: (options: SpatialLayoutOptions & Pick<ResolvedLayoutOptions, 'fragmentTableReads'>) => T,
): T {
  if (!usesFragmentTable(options)) return layout(options)
  const rendered = new Map(options.fragments ?? [])
  const asked = new Map<string, FragmentAsk>()
  const reads = { count: 0 }
  const answer = (ask: FragmentAsk): RenderedSvgFragment | undefined => {
    reads.count += 1
    const key = fragmentAskKey(ask)
    const found = rendered.get(key)
    if (found === undefined && !asked.has(key)) asked.set(key, ask)
    return found
  }
  const { renderMath, renderDiagram } = options
  // A caller's own seam is counted too: a body it drew beside a table would
  // otherwise be kept and served to a layout whose table answers that seam.
  const laid = layout({
    ...options,
    renderMath: (value) => {
      if (renderMath === undefined) return answer({ kind: 'math', value })
      reads.count += 1
      return renderMath(value)
    },
    renderDiagram: (lang, value) => {
      if (renderDiagram === undefined) return answer({ kind: 'diagram', lang, value })
      reads.count += 1
      return renderDiagram(lang, value)
    },
    fragmentTableReads: reads,
  })
  if (asked.size > 0) options.onFragmentsAsked?.([...asked.values()])
  return laid
}
