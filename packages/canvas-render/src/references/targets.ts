import { scanReferences } from '@kamiazya/whiteboard-codec'
import { isImageRef, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { ReferenceGraph } from './loaded-reference.js'

/**
 * What a render has to load: every document its seeds point at, as written.
 *
 * The ONE definition of "what counts as a reference", so a keeper never
 * decides it alone: a body's `[[target]]` and `![[target]]` (the codec
 * scanner's grammar, the same one the reference index uses) and a canvas's
 * file nodes, minus image assets, which are not documents. Passing what is
 * already `loaded` extends the closure one step — a loaded markdown body
 * names further documents — so a prefetch loop calls this until it answers
 * nothing new. The layout's own depth cap bounds what is ever DRAWN;
 * loading past it is the accepted cost of never drawing a placeholder for
 * a document that was one fetch away.
 */
export function referenceTargets(seeds: {
  readonly bodies?: readonly string[]
  readonly canvases?: readonly SpatialCanvas[]
  readonly loaded?: ReferenceGraph
}): readonly string[] {
  const targets = new Set<string>()
  const addBody = (body: string) => {
    for (const match of scanReferences(body)) targets.add(match.target)
  }
  for (const body of seeds.bodies ?? []) addBody(body)
  for (const canvas of seeds.canvases ?? []) {
    for (const node of canvas.nodes) {
      if (node.type === 'file' && !isImageRef(node.file)) targets.add(node.file)
    }
  }
  for (const entry of seeds.loaded?.values() ?? []) {
    if (entry?.body !== undefined) addBody(entry.body)
  }
  return [...targets]
}
