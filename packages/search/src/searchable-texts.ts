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
 * section. The test for a node kind is whether the reader can SEE the text
 * on the canvas — which is why a link contributes its url and a file
 * contributes nothing (see the branches below). Each string stays separate
 * so a snippet can say WHICH source matched instead of splicing two
 * unrelated sentences together.
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
    switch (node.type) {
      case 'text':
        texts.push(node.text)
        break
      case 'link':
        // The url IS the label canvas-render draws for a link node, so it is
        // text the reader can see on the canvas and expects to find by.
        texts.push(node.url)
        break
      case 'group':
        if (node.label !== undefined) texts.push(node.label)
        break
      case 'file':
        // Nothing, deliberately. A file node's readable label is the resolved
        // reference's, and resolving needs a lookup this package does not take
        // (see the note above about content already READ). The raw `node.file`
        // is an opaque id: indexing it would add a token no one will ever
        // query, and match a document for a string it does not display.
        break
      default:
        // A fifth node kind has to answer this question rather than fall
        // through it — an exhaustive switch is what makes forgetting one a
        // build failure instead of a silent gap in search.
        node satisfies never
    }
  }
  for (const edge of content.canvas.edges) if (edge.label !== undefined) texts.push(edge.label)
  return texts
}
