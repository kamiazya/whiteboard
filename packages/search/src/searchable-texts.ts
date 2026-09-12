import {
  frameLabel,
  type NodeKind,
  nodeKind,
  nodeText,
  nodeUrl,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'

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
/**
 * What each kind of node contributes to the index, one row per kind.
 *
 * This was a `switch` over the node-kind union, and the comment on its
 * `default` is the reason it is a TABLE now rather than a chain of `if`s: a
 * fifth kind has to answer this question instead of falling through it.
 * `NodeKind` is closed — the resource registry's ids plus the frame — so
 * `satisfies` fails the build when the registry grows, which is the same
 * guard `node satisfies never` gave and survives the union's dissolution.
 */
const SEARCHABLE = {
  text: nodeText,
  // The url IS the label canvas-render draws for a link node, so it is text
  // the reader can see on the canvas and expects to find by.
  link: nodeUrl,
  frame: frameLabel,
  // Nothing, deliberately. A file node's readable label is the resolved
  // reference's, and resolving needs a lookup this package does not take. The
  // raw file reference is an opaque id: indexing it would add a token no one
  // will ever query, and match a document for a string it does not display.
  file: () => undefined,
} satisfies Record<NodeKind, (node: SpatialNode) => string | undefined>

export function searchableTexts(content: SearchableContent): string[] {
  if (content.kind === 'markdown') return [content.body]
  const texts: string[] = []
  for (const node of content.canvas.nodes) {
    const own = SEARCHABLE[nodeKind(node)](node)
    if (own !== undefined) texts.push(own)
  }
  for (const edge of content.canvas.edges) if (edge.label !== undefined) texts.push(edge.label)
  return texts
}
