import { z } from 'zod'
import type { RenderedSvgFragment } from './nodes/mdast-layout-options.js'

// Rendered math blocks and diagram fences as DATA. The engines behind the
// `renderMath` / `renderDiagram` seams (MathJax, mermaid) are asynchronous and
// a layout is not, so a host renders what a layout asked for and lays it out
// again. A table, unlike a function seam, is something the Rust core can be
// handed, so this is the form a host passes where the core may answer.

/**
 * One source a layout asked a fragment seam for. Plain data: it crosses to and
 * from a worker and the core, and a render store persists it, so whoever reads
 * one back parses it with this schema.
 */
export const fragmentAskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('math'), value: z.string() }),
  z.object({ kind: z.literal('diagram'), lang: z.string(), value: z.string() }),
])

export type FragmentAsk = Readonly<z.infer<typeof fragmentAskSchema>>

/** A rendered fragment by its key (`fragmentAskKey`). */
export type FragmentEntry = readonly [key: string, fragment: RenderedSvgFragment]

/**
 * The key of a rendered math block and of a rendered fence. The kind prefix
 * keeps a `$$` block and a same-source ```math fence in separate rows. The
 * core builds the same keys (`spatial_layout::fragments`).
 */
export function fragmentAskKey(ask: FragmentAsk): string {
  return ask.kind === 'math' ? `math:${ask.value}` : `fence:${ask.lang}:${ask.value}`
}
