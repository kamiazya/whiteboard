import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/** A document's content, as much of it as search needs to see. */
export type SearchableContent =
  | { readonly kind: 'markdown'; readonly body: string }
  | { readonly kind: 'spatial'; readonly canvas: SpatialCanvas }

/**
 * What text a document contributes to search, as one definition.
 *
 * A canvas means through its RELATIONS, so edge labels are content rather
 * than decoration; group labels name a region the way a heading names a
 * section. Each string stays separate so a snippet can say WHICH source
 * matched instead of splicing two unrelated sentences together.
 *
 * It lives here, beside the ranking, because the daemon and the browser
 * must answer a query the same way: a second definition of "the text" is a
 * second set of results, and the difference would surface as one mode
 * finding a document the other cannot.
 *
 * It takes content already READ rather than a document, so this package
 * needs neither the CRDT nor the bridge — every caller is somewhere that
 * holds the body or the canvas anyway.
 *
 * What it returns is ALSO the embedding input on the semantic path
 * (`ContentFactsCache.vectorsFor` embeds name + path + these texts), and
 * that input is truncated at the model's token limit — so their ORDER
 * decides which part of a long document a vector sees at all. Changing
 * this function with only lexical search in mind moves semantic results
 * too; the quality scoreboard prints the truncation rate, so measure.
 */
export function searchableTexts(content: SearchableContent): string[] {
  if (content.kind === 'markdown') return [content.body]
  const texts: string[] = []
  for (const node of content.canvas.nodes) {
    if (node.type === 'text') texts.push(node.text)
    if (node.type === 'group' && node.label !== undefined) texts.push(node.label)
  }
  for (const edge of content.canvas.edges) if (edge.label !== undefined) texts.push(edge.label)
  return texts
}
