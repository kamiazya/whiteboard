import { scanReferences } from '@kamiazya/whiteboard-codec'
import { isImageRef, nodeFile, nodeText, type SpatialCanvas } from '@kamiazya/whiteboard-model'
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
      const file = nodeFile(node)
      const text = nodeText(node)
      if (file !== undefined && !isImageRef(file)) add(file, depth)
      // A text node's body is markdown the composer lays out with the same
      // seams a note gets, so what it embeds and links has to load too.
      else if (text !== undefined) addBody(text, depth)
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

/**
 * A markdown inline image whose URL is a stored asset, as written.
 *
 * A SCANNER rather than a parse, for the reason `referenceTargets` uses one:
 * this runs over every body the walk reaches, and parsing all of them to
 * decide what to prefetch would charge a render the markdown parser twice.
 * What makes that safe here is the direction of its error — the LAYOUT reads
 * mdast, so a URL this finds inside a code fence costs one store read that
 * answers nothing and paints nothing, while one it missed would be a picture
 * that silently does not draw. Cheap in the wrong direction only.
 *
 * `asset:` (model's one convention) is the filter because it is what a keeper
 * can actually answer. An absolute URL already draws without resolution, and
 * a bare relative path is a different question — relative to what — that this
 * does not decide by asking on its behalf.
 */
const INLINE_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)/g

function addInlineImages(body: string, into: Set<string>): void {
  if (!body.includes('](')) return
  for (const match of body.matchAll(INLINE_IMAGE)) {
    const url = match[1] as string
    if (isImageRef(url)) into.add(url)
  }
}

/**
 * What stored PICTURES a render has to load, as `referenceTargets` answers
 * for documents — and deliberately not the same function, because the two
 * sets are disjoint by construction: an asset is not a document, so that walk
 * subtracts exactly what this one keeps.
 *
 * It exists because a body's inline image was reachable by no other route.
 * A canvas's image file nodes were collected at the call site; the inline
 * `![](asset:…)` in a note, or in a text node on the board, was collected
 * nowhere, so the seam the layout asks had nothing to answer with. Both
 * come from here now, so a surface cannot wire one and forget the other.
 *
 * Follows the same walk, caps and budget as `referenceTargets` — an
 * embedded note is drawn, so its pictures are drawn too.
 */
export function imageTargets(seeds: {
  readonly bodies?: readonly string[]
  readonly canvases?: readonly SpatialCanvas[]
  readonly loaded?: ReferenceGraph
}): readonly string[] {
  const images = new Set<string>()
  const addCanvas = (canvas: SpatialCanvas) => {
    for (const node of canvas.nodes) {
      const file = nodeFile(node)
      const text = nodeText(node)
      if (file !== undefined && isImageRef(file)) images.add(file)
      else if (text !== undefined) addInlineImages(text, images)
    }
  }
  for (const body of seeds.bodies ?? []) addInlineImages(body, images)
  for (const canvas of seeds.canvases ?? []) addCanvas(canvas)
  // The documents this render draws, from the same definition, so what an
  // embedded note holds is reached without a second walk of its own.
  for (const target of referenceTargets(seeds)) {
    const entry = seeds.loaded?.get(target)
    if (entry === undefined || entry === null) continue
    if (entry.body !== undefined) addInlineImages(entry.body, images)
    else if (entry.canvas !== undefined) addCanvas(entry.canvas)
  }
  return [...images]
}
