/**
 * Colour BY INTENT ([ADR-0040](../../../../docs/contributing/adr/0040-scoped-tags.md)
 * decision 5's declared layer): a box or an edge that carries a tag whose
 * value the workspace's tag library colours, and has no colour of its own,
 * is drawn in the declared colour.
 *
 * Applied to the CANVAS, before layout, rather than inside the appearance
 * resolver. Three readers have to agree on what a box is drawn in — the
 * facet score (which judges whether colour is carried by a key), the
 * appearance (which paints it) and the legend (which is judged by the score
 * and swatched by the appearance) — and the score reads `node.color`. An
 * intent applied only in the resolver would paint every `health:failing`
 * box red while the score, reading the canvas, found no colour at all, and
 * the legend would list nothing.
 *
 * A thing's OWN colour always wins: the library supplies a default, never
 * an override, so an author who coloured one box on purpose is not
 * repainted by a declaration made later. And a thing whose tags declare
 * TWO colours gets neither — intent is contested, exactly as the score
 * would call colour contested between two keys, and a first-key-wins rule
 * would paint a choice nobody made.
 */
import {
  type CanvasColor,
  parseScopedTag,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { declaredColourOf, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'

/** The one colour the library declares for this thing's tags, or none — none too when two are declared. */
function intendedColour(
  tags: readonly string[] | undefined,
  library: TagLibrary,
): CanvasColor | undefined {
  let found: CanvasColor | undefined
  for (const tag of tags ?? []) {
    const scoped = parseScopedTag(tag)
    if (scoped === undefined) continue
    const colour = declaredColourOf(library, scoped)
    if (colour === undefined) continue
    if (found !== undefined && found !== colour) return undefined
    found = colour
  }
  return found
}

function coloured<T extends { readonly color?: CanvasColor; readonly tags?: readonly string[] }>(
  element: T,
  library: TagLibrary,
): T {
  if (element.color !== undefined) return element
  const colour = intendedColour(element.tags, library)
  return colour === undefined ? element : { ...element, color: colour }
}

/**
 * `canvas` with every uncoloured node and edge coloured by what the library
 * declares for its tags — or `canvas` itself when nothing changes, so a
 * memo keyed on the canvas's identity still holds for the common board
 * that carries no declared tag.
 */
export function withDeclaredColours(
  canvas: SpatialCanvas,
  library: TagLibrary | undefined,
): SpatialCanvas {
  if (library === undefined || Object.keys(library).length === 0) return canvas
  let changed = false
  const nodes = canvas.nodes.map((node) => {
    const next = coloured<SpatialNode>(node, library)
    if (next !== node) changed = true
    return next
  })
  const edges = canvas.edges.map((edge) => {
    const next = coloured(edge, library)
    if (next !== edge) changed = true
    return next
  })
  return changed ? { ...canvas, nodes, edges } : canvas
}
