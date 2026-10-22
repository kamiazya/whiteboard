import { findNextReference } from '@kamiazya/whiteboard-codec'
import {
  isImageRef,
  nodeFile,
  nodeText,
  type SpatialCanvas,
  storedImageRefs,
} from '@kamiazya/whiteboard-model'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'

/**
 * How deep the walk follows what has loaded — the same cap the layout draws
 * to (`mdast-blocks.ts` and `compose-node.ts` each pin 3: root is 0, and
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
 * How many distinct targets one body or canvas contributes to a walk. Once a
 * walk has read `REFERENCE_BUDGET` distinct targets of one list, every one of
 * them is in its set — added, or there already — so the set is full and
 * nothing later in the list can be added. That is what lets the scan stop.
 */
const CONTRIBUTION_CAP = REFERENCE_BUDGET

/** Distinct non-image targets in the order written, stopping at the cap. */
class Contribution {
  readonly list: string[] = []
  private readonly seen = new Set<string>()
  get full(): boolean {
    return this.list.length >= CONTRIBUTION_CAP
  }
  add(target: string): void {
    // The one image filter, ahead of the cap, so a body or canvas full of
    // pictures cannot crowd a document out, whichever arm names them.
    if (this.full || isImageRef(target) || this.seen.has(target)) return
    this.seen.add(target)
    this.list.push(target)
  }
  addBody(body: string): void {
    let cursor = 0
    while (!this.full) {
      const match = findNextReference(body, cursor)
      if (match === undefined) return
      this.add(match.target)
      cursor = match.index + match.full.length
    }
  }
}

function bodyTargets(body: string): readonly string[] {
  const out = new Contribution()
  out.addBody(body)
  return out.list
}

/**
 * Remembered per object, because a keeper re-walks on every load that lands
 * and the bodies it has already read are most of what it holds: without this,
 * N notes landing one at a time read their bodies N times over. Sound because
 * a canvas and a loaded record are immutable values — a new revision is a new
 * object.
 */
const canvasTargetsMemo = new WeakMap<SpatialCanvas, readonly string[]>()
const entryTargetsMemo = new WeakMap<LoadedReference, readonly string[]>()
const canvasImagesMemo = new WeakMap<SpatialCanvas, readonly string[]>()
const entryImagesMemo = new WeakMap<LoadedReference, readonly string[]>()

function remembered<K extends object>(
  memo: WeakMap<K, readonly string[]>,
  key: K,
  compute: (key: K) => readonly string[],
): readonly string[] {
  const known = memo.get(key)
  if (known !== undefined) return known
  const value = compute(key)
  memo.set(key, value)
  return value
}

function canvasTargets(canvas: SpatialCanvas): readonly string[] {
  return remembered(canvasTargetsMemo, canvas, () => {
    const out = new Contribution()
    for (const node of canvas.nodes) {
      if (out.full) break
      const file = nodeFile(node)
      const text = nodeText(node)
      if (file !== undefined) out.add(file)
      // A text node's body is markdown the composer lays out with the same
      // seams a note gets, so what it embeds and links has to load too.
      else if (text !== undefined) out.addBody(text)
    }
    return out.list
  })
}

function entryTargets(entry: LoadedReference): readonly string[] {
  return remembered(entryTargetsMemo, entry, () => {
    if (entry.body !== undefined) return bodyTargets(entry.body)
    if (entry.canvas !== undefined) return canvasTargets(entry.canvas)
    return []
  })
}

function canvasImages(canvas: SpatialCanvas): readonly string[] {
  return remembered(canvasImagesMemo, canvas, () => storedImageRefs({ canvas }))
}

function entryImages(entry: LoadedReference): readonly string[] {
  return remembered(entryImagesMemo, entry, () => {
    if (entry.body !== undefined) return storedImageRefs({ body: entry.body })
    if (entry.canvas !== undefined) return canvasImages(entry.canvas)
    return []
  })
}

/**
 * What a render has to load: every document its seeds point at, as written.
 *
 * The ONE definition of "what counts as a reference", so a keeper never
 * decides it alone: a body's `[[target]]` and `![[target]]` (the codec
 * scanner's grammar, the same one the reference index uses), a canvas's
 * file nodes, and whatever its text nodes' bodies write in that grammar —
 * minus image assets in every one of them, which are not documents
 * (`imageTargets` answers for those). Passing what is already `loaded`
 * extends the walk one step through each loaded body and canvas, and
 * `walkReferences` is the loop that calls this until it answers nothing
 * new — but only as far as `DEPTH_CAP`, and never past `REFERENCE_BUDGET`
 * targets in order of discovery. Both bounds live here so every keeper
 * inherits them.
 */
export function referenceTargets(seeds: {
  readonly bodies?: readonly string[]
  readonly canvases?: readonly SpatialCanvas[]
  readonly loaded?: ReferenceGraph
}): readonly string[] {
  const targets = new Set<string>()
  const queue: { readonly target: string; readonly depth: number }[] = []
  const spent = () => targets.size >= REFERENCE_BUDGET
  const addAll = (list: readonly string[], depth: number) => {
    for (const target of list) {
      if (spent()) return
      if (targets.has(target)) continue
      targets.add(target)
      queue.push({ target, depth })
    }
  }

  for (const body of seeds.bodies ?? []) if (!spent()) addAll(bodyTargets(body), 1)
  for (const canvas of seeds.canvases ?? []) if (!spent()) addAll(canvasTargets(canvas), 1)
  for (let i = 0; i < queue.length && !spent(); i += 1) {
    const { target, depth } = queue[i] as (typeof queue)[number]
    if (depth >= DEPTH_CAP) continue
    const entry = seeds.loaded?.get(target)
    if (entry !== undefined && entry !== null) addAll(entryTargets(entry), depth + 1)
  }
  return [...targets]
}

/**
 * What stored PICTURES a render has to load, as `referenceTargets` answers
 * for documents — and deliberately not the same function, because the two
 * sets are disjoint by construction: an asset is not a document, so that walk
 * subtracts exactly what this one keeps.
 *
 * What counts as a stored picture is model's `storedImageRefs` — image file
 * nodes, frame backgrounds and inline `![](asset:…)` in a text node or a body —
 * so a surface cannot wire one and forget another, and the daemon's file GC
 * keeps exactly what this loads.
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
  // One guarded insertion for every branch, so the set cannot outgrow the
  // bound whichever route reaches it. Sharing `referenceTargets`'s walk
  // without sharing its budget left this unbounded, and a keeper starts one
  // read per entry.
  const addAll = (refs: readonly string[]) => {
    for (const ref of refs) {
      if (images.size >= REFERENCE_BUDGET) return
      images.add(ref)
    }
  }
  for (const body of seeds.bodies ?? []) addAll(storedImageRefs({ body }))
  for (const canvas of seeds.canvases ?? []) addAll(canvasImages(canvas))
  // The documents this render draws, from the same definition, so what an
  // embedded note holds is reached without a second walk of its own.
  for (const target of referenceTargets(seeds)) {
    const entry = seeds.loaded?.get(target)
    if (entry !== undefined && entry !== null) addAll(entryImages(entry))
  }
  return [...images]
}

/** What a render starts from: the document it draws, before anything is loaded. */
export interface ReferenceSeeds {
  readonly bodies?: readonly string[]
  readonly canvases?: readonly SpatialCanvas[]
}

export interface WalkReferencesOptions {
  /**
   * What a target whose load threw is recorded as. Absent, the throw ends
   * the walk — right for a caller that must not mistake a failed read for a
   * dangling reference (a cached picture keyed as though the embed named
   * nothing). Supplied, the walk is total: answering `null` draws the
   * reference unresolved and keeps loading the rest.
   */
  readonly onFailure?: (target: string, error: unknown) => LoadedReference | null
}

type Recorded = readonly (readonly [string, LoadedReference | null])[]

/**
 * The targets `referenceTargets` names that the graph has not asked for yet.
 * Each target is asked for exactly once — a `null` answer is recorded too —
 * and the walk ends when a step adds nothing, which it must: the targets
 * are bounded by `REFERENCE_BUDGET` and every step records at least one.
 */
function frontier(seeds: ReferenceSeeds, graph: ReferenceGraph): readonly string[] {
  return referenceTargets({ ...seeds, loaded: graph }).filter((target) => !graph.has(target))
}

/**
 * Loads everything the seeds point at, transitively, into the graph
 * `referenceSeams` and `referenceWire` read — the ONE loop over
 * `referenceTargets`, so depth, budget, the image filter and "never load a
 * target twice" are inherited rather than re-decided by each keeper. The
 * keeper supplies only how one target is read and what a failed read means.
 *
 * Each step's targets load in parallel; the steps themselves are sequential
 * because what the next one asks for is what this one's bodies and canvases
 * name. Entries are recorded in discovery order whatever order loads settle
 * in, so a graph — and every key derived from it — is the same on every run.
 */
export async function walkReferences(
  seeds: ReferenceSeeds,
  load: (target: string) => Promise<LoadedReference | null>,
  options: WalkReferencesOptions = {},
): Promise<ReferenceGraph> {
  const graph = new Map<string, LoadedReference | null>()
  const loadOne = async (target: string): Promise<LoadedReference | null> => {
    try {
      return await load(target)
    } catch (error) {
      if (options.onFailure === undefined) throw error
      return options.onFailure(target, error)
    }
  }
  for (let wanted = frontier(seeds, graph); wanted.length > 0; wanted = frontier(seeds, graph)) {
    // Sequential by necessity, parallel within: see the doc above.
    const step: Recorded = await Promise.all(
      wanted.map(async (target) => [target, await loadOne(target)] as const),
    )
    for (const [target, entry] of step) graph.set(target, entry)
  }
  return graph
}

/**
 * `walkReferences` for a keeper that holds every document in memory already
 * (the offline replica), so a render needs no promise to read one.
 */
export function walkReferencesSync(
  seeds: ReferenceSeeds,
  load: (target: string) => LoadedReference | null,
  options: WalkReferencesOptions = {},
): ReferenceGraph {
  const graph = new Map<string, LoadedReference | null>()
  const loadOne = (target: string): LoadedReference | null => {
    try {
      return load(target)
    } catch (error) {
      if (options.onFailure === undefined) throw error
      return options.onFailure(target, error)
    }
  }
  for (let wanted = frontier(seeds, graph); wanted.length > 0; wanted = frontier(seeds, graph)) {
    for (const target of wanted) graph.set(target, loadOne(target))
  }
  return graph
}
