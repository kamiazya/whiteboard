// What a sync update does to a document's annotation layer — how many comment
// threads and proposed changes it leaves open — judged with the text bounds in
// `sync-text-limits.ts`, by the same keepers on the same bytes. Kept apart
// because none of it reads text: it counts entries of the threads, legacy
// comments and proposals maps.
import {
  DOCUMENT_MAX_OPEN_CHANGES,
  DOCUMENT_MAX_OPEN_THREADS,
  growsPast,
} from '@kamiazya/whiteboard-model'
import { type ContainerID, type LoroDoc, LoroMap } from 'loro-crdt'
import { openThreadCount } from './comment-threads.js'
import { COMMENTS_KEY, PROPOSALS_KEY, THREADS_KEY } from './containers.js'
import { openProposedChangeCount } from './proposals.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/** A document an update left holding too many open threads, or open proposed changes. */
export type OpenAnnotationsBreach<
  S extends 'open-threads' | 'open-changes' = 'open-threads' | 'open-changes',
> = {
  readonly shape: S
  /** How many the document would hold open. */
  readonly count: number
  /** The threads or proposals map, so a caller can name the document. */
  readonly container: ContainerID
}

/** How many legacy comment rows in `commentsMap` are open: a reader still draws each as a thread. */
function openLegacyCommentCount(commentsMap: LoroMap): number {
  let open = 0
  for (const commentId of commentsMap.keys()) {
    const value = commentsMap.get(commentId)
    if (value !== null && typeof value === 'object' && !('resolved' in value && value.resolved)) {
      open += 1
    }
  }
  return open
}

/**
 * Each per-document annotation bound: the maps whose entries it counts, and
 * how an entry counts as open. The thread bound counts the legacy comment
 * rows beside the threads, since `readAnnotations` lifts each into one. Neither
 * a thread nor a change is ever deleted, so only open ones are held to it
 * (`DOCUMENT_MAX_OPEN_THREADS`).
 */
const ANNOTATION_BOUNDS = [
  {
    keys: [THREADS_KEY, COMMENTS_KEY],
    shape: 'open-threads',
    max: DOCUMENT_MAX_OPEN_THREADS,
    count: (key: string, map: LoroMap) =>
      key === THREADS_KEY ? openThreadCount(map) : openLegacyCommentCount(map),
  },
  {
    keys: [PROPOSALS_KEY],
    shape: 'open-changes',
    max: DOCUMENT_MAX_OPEN_CHANGES,
    count: (_key: string, map: LoroMap) => openProposedChangeCount(map),
  },
] as const

type AnnotationBound = (typeof ANNOTATION_BOUNDS)[number]

export type AnnotationWrite = {
  readonly bound: AnnotationBound
  /** The document and bound the write counts toward, as one key. */
  readonly owner: string
  /** The map the write sits under, to name the document by. */
  readonly map: LoroMap
  /** How many the bound counts open on that document, in the doc's current state. */
  readonly open: number
}

/**
 * The bound's maps on the document holding `map`, by key: its siblings under
 * the same tree node, or the roots — opened only where present, so the
 * judgement adds no root to the record.
 */
function annotationMaps(doc: LoroDoc, map: LoroMap, bound: AnnotationBound): [string, LoroMap][] {
  const parent = map.parent() as LoroMap | undefined
  if (parent === undefined) {
    const roots = doc.getShallowValue()
    return bound.keys.filter((key) => key in roots).map((key) => [key, doc.getMap(key)])
  }
  return bound.keys.flatMap((key): [string, LoroMap][] => {
    const sibling = parent.get(key)
    return sibling instanceof LoroMap ? [[key, sibling]] : []
  })
}

/**
 * How deep below its root a write can still open an annotation: a proposal's
 * changes sit two maps under the proposals map, a thread one under the
 * threads map, and a legacy comment is the comments map itself.
 */
function deepestAnnotationDepth(key: unknown): number {
  if (key === PROPOSALS_KEY) return 3
  if (key === THREADS_KEY) return 2
  return 1
}

/**
 * The annotation bound a write to the map `container` can move, when it is
 * one: a threads, legacy comments or proposals map itself (one added), one
 * thread's or proposal's own map (a status set), or a proposal's changes (a
 * change added or decided). A thread's messages open nothing, so a reply is
 * not counted. `undefined` too for a container the doc's current state does
 * not hold, which while detached is one the update itself creates: its
 * parent's write is what the update did to that document. `null` for a
 * document `counted` already holds.
 */
function annotationWrite(
  doc: LoroDoc,
  container: ContainerID,
  counted: ReadonlySet<string>,
): AnnotationWrite | null | undefined {
  let path: ReturnType<LoroDoc['getPathToContainer']>
  try {
    path = doc.getPathToContainer(container)
  } catch {
    return undefined
  }
  if (path === undefined) return undefined
  const base = path[0] === WORKSPACE_TREE_KEY ? 2 : 0
  const key = path[base]
  const bound = ANNOTATION_BOUNDS.find(({ keys }) => (keys as readonly unknown[]).includes(key))
  if (bound === undefined) return undefined
  const depth = path.length - base
  const deepest = deepestAnnotationDepth(key)
  if (depth > deepest) return undefined
  let map = doc.getContainerById(container) as LoroMap | undefined
  for (let up = 1; up < depth && map !== undefined; up += 1) {
    map = map.parent() as LoroMap | undefined
  }
  if (map === undefined) return undefined
  const owner = `${path.slice(0, base).join('/')} ${bound.shape}`
  // Counting walks every thread or change the document holds, and an update
  // writes one container per thread it touches, so a document already
  // counted is not counted again: once per document, not once per write.
  if (counted.has(owner)) return null
  const open = annotationMaps(doc, map, bound).reduce(
    (sum, [mapKey, held]) => sum + bound.count(mapKey, held),
    0,
  )
  return { bound, owner, map, open }
}

/** Each annotation bound's open count, by owner, for every document `written` reaches. */
export function annotationCounts(
  doc: LoroDoc,
  written: ReadonlySet<ContainerID>,
): Map<string, AnnotationWrite> {
  const counts = new Map<string, AnnotationWrite>()
  const counted = new Set<string>()
  for (const container of written) {
    const write = annotationWrite(doc, container, counted)
    if (write === undefined || write === null) continue
    counted.add(write.owner)
    counts.set(write.owner, write)
  }
  return counts
}

/**
 * A document the update left holding more open threads or open proposed
 * changes than its bound, and more than before. A document that held none of
 * a bound's maps before the update held none open.
 */
export function annotationBreach(
  doc: LoroDoc,
  written: ReadonlySet<ContainerID>,
  before: ReadonlyMap<string, AnnotationWrite>,
): OpenAnnotationsBreach | null {
  for (const [owner, { bound, map, open }] of annotationCounts(doc, written)) {
    if (growsPast(bound.max, before.get(owner)?.open ?? 0, open)) {
      return { shape: bound.shape, count: open, container: map.id }
    }
  }
  return null
}

/**
 * The most open threads or open proposed changes any document in `doc`
 * holds, at its root or under any workspace-tree node — opened only where
 * present, as `longestBody` does.
 */
export function mostOpenAnnotations(doc: LoroDoc): number {
  const roots = doc.getShallowValue()
  let most = 0
  for (const bound of ANNOTATION_BOUNDS) {
    const open = bound.keys.reduce(
      (sum, key) => sum + (key in roots ? bound.count(key, doc.getMap(key)) : 0),
      0,
    )
    most = Math.max(most, open)
  }
  if (!(WORKSPACE_TREE_KEY in roots)) return most
  for (const node of doc.getTree(WORKSPACE_TREE_KEY).getNodes()) {
    for (const bound of ANNOTATION_BOUNDS) {
      const open = bound.keys.reduce((sum, key) => {
        const map = node.data.get(key)
        return sum + (map instanceof LoroMap ? bound.count(key, map) : 0)
      }, 0)
      most = Math.max(most, open)
    }
  }
  return most
}

/** No update this short can open more threads or changes than either bound from where `mostOpenAnnotations` found them. */
export const SMALLEST_ANNOTATION_BOUND = Math.min(...ANNOTATION_BOUNDS.map(({ max }) => max))
