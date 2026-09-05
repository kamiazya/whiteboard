import { scanReferences } from '@kamiazya/whiteboard-codec'
import { isImageRef, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'

/**
 * How deep the walk follows what has loaded — the same cap the layout draws
 * to (`embed-recursion.ts` and `mdast-blocks.ts` each pin 3: root is 0, and
 * a document at depth 3 is drawn while what IT names is a placeholder). A
 * target past the cap is never asked for, so a workspace whose notes all
 * link each other is not loaded whole to render one of them.
 */
const DEPTH_CAP = 3

/**
 * The most targets one render asks for. A document that names more than
 * this is drawn with the rest unresolved rather than turned into that many
 * store reads; 256 is far above any document seen and far below what a
 * link-dense workspace could reach through the walk.
 */
export const REFERENCE_BUDGET = 256

/**
 * What a render has to load: every document its seeds point at, as written.
 *
 * The ONE definition of "what counts as a reference", so a keeper never
 * decides it alone: a body's `[[target]]` and `![[target]]` (the codec
 * scanner's grammar, the same one the reference index uses), a canvas's
 * file nodes, minus image assets, which are not documents, and whatever
 * its text nodes' bodies write in that grammar. Passing what is
 * already `loaded` extends the walk one step through each loaded body and
 * canvas — so a prefetch loop calls this until it answers nothing new — but
 * only as far as `DEPTH_CAP`, and never past `REFERENCE_BUDGET` targets in
 * order of discovery. Both bounds live here so every keeper inherits them.
 */
export function referenceTargets(seeds: {
  readonly bodies?: readonly string[]
  readonly canvases?: readonly SpatialCanvas[]
  readonly loaded?: ReferenceGraph
}): readonly string[] {
  const targets = new Set<string>()
  const queue: { readonly target: string; readonly depth: number }[] = []
  const add = (target: string, depth: number) => {
    if (targets.size >= REFERENCE_BUDGET || targets.has(target)) return
    targets.add(target)
    queue.push({ target, depth })
  }
  const addBody = (body: string, depth: number) => {
    for (const match of scanReferences(body)) add(match.target, depth)
  }
  const addCanvas = (canvas: SpatialCanvas, depth: number) => {
    for (const node of canvas.nodes) {
      if (node.type === 'file' && !isImageRef(node.file)) add(node.file, depth)
      // A text node's body is markdown the composer lays out with the same
      // seams a note gets, so what it embeds and links has to load too.
      else if (node.type === 'text') addBody(node.text, depth)
    }
  }
  const addEntry = (entry: LoadedReference, depth: number) => {
    if (entry.body !== undefined) addBody(entry.body, depth)
    else if (entry.canvas !== undefined) addCanvas(entry.canvas, depth)
  }

  for (const body of seeds.bodies ?? []) addBody(body, 1)
  for (const canvas of seeds.canvases ?? []) addCanvas(canvas, 1)
  for (let i = 0; i < queue.length; i += 1) {
    const { target, depth } = queue[i] as (typeof queue)[number]
    if (depth >= DEPTH_CAP) continue
    const entry = seeds.loaded?.get(target)
    if (entry !== undefined && entry !== null) addEntry(entry, depth + 1)
  }
  return [...targets]
}
