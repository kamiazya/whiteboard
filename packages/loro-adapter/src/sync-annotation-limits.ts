// What a sync update does to a document's annotation layer — how many comment
// threads and proposed changes it leaves open, and how many messages one
// thread holds — judged with the text bounds in `sync-text-limits.ts`, by the
// same keepers on the same bytes. Kept apart because none of it reads text:
// it counts entries of the threads, legacy comments, proposals and messages
// maps.
import {
  DOCUMENT_MAX_OPEN_CHANGES,
  DOCUMENT_MAX_OPEN_THREADS,
  growsPast,
  THREAD_MAX_MESSAGES,
} from '@kamiazya/whiteboard-model'
import { type ContainerID, type LoroDoc, LoroMap } from 'loro-crdt'
import { MESSAGES_KEY, openThreadCount } from './comment-threads.js'
import { COMMENTS_KEY, PROPOSALS_KEY, THREADS_KEY } from './containers.js'
import { openProposedChangeCount } from './proposals.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/**
 * A document an update left holding too many open threads or open proposed
 * changes, or one of its threads holding too many messages.
 */
export type AnnotationCountBreach<S extends AnnotationBound['shape'] = AnnotationBound['shape']> = {
  readonly shape: S
  /** How many the document, or the thread, would hold. */
  readonly count: number
  /** The threads, proposals or messages map, so a caller can name the document. */
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

/** How many messages the most-replied thread in `threadsMap` holds. */
function longestThread(threadsMap: LoroMap): number {
  let longest = 0
  for (const threadId of threadsMap.keys()) {
    const thread = threadsMap.get(threadId)
    const messages = thread instanceof LoroMap ? thread.get(MESSAGES_KEY) : undefined
    if (messages instanceof LoroMap) longest = Math.max(longest, messages.size)
  }
  return longest
}

/**
 * Each annotation bound: the maps whose entries it counts, and how an entry
 * counts. A `document` bound counts at the document's own maps, and the
 * thread bound counts the legacy comment rows beside the threads, since
 * `readAnnotations` lifts each into one. Neither a thread nor a change is
 * ever deleted, so only open ones are held to it (`DOCUMENT_MAX_OPEN_THREADS`).
 *
 * The `thread` bound counts at ONE thread's messages map, every entry
 * whether or not a reader accepts it, since each is stored and read
 * (`THREAD_MAX_MESSAGES`); `walk` is what `mostOpenAnnotations` reads of it,
 * the longest thread a document holds.
 */
const ANNOTATION_BOUNDS = [
  {
    scope: 'document',
    keys: [THREADS_KEY, COMMENTS_KEY],
    shape: 'open-threads',
    max: DOCUMENT_MAX_OPEN_THREADS,
    walk: (key: string, map: LoroMap) =>
      key === THREADS_KEY ? openThreadCount(map) : openLegacyCommentCount(map),
  },
  {
    scope: 'document',
    keys: [PROPOSALS_KEY],
    shape: 'open-changes',
    max: DOCUMENT_MAX_OPEN_CHANGES,
    walk: (_key: string, map: LoroMap) => openProposedChangeCount(map),
  },
  {
    scope: 'thread',
    keys: [THREADS_KEY],
    shape: 'thread-messages',
    max: THREAD_MAX_MESSAGES,
    walk: (_key: string, map: LoroMap) => longestThread(map),
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
 * Whether a write to the map at `relative` (its path below the document) can
 * move `bound`: a document bound's maps or the ones under them, as deep as an
 * annotation opens; the thread bound only a thread's messages map itself,
 * which is where a reply is set.
 */
function reaches(bound: AnnotationBound, relative: readonly unknown[]): boolean {
  if (!(bound.keys as readonly unknown[]).includes(relative[0])) return false
  if (bound.scope === 'thread') return relative.length === 3 && relative[2] === MESSAGES_KEY
  return relative.length <= deepestAnnotationDepth(relative[0])
}

/**
 * The annotation bound a write to the map `container` can move, when it is
 * one: a threads, legacy comments or proposals map itself (one added), one
 * thread's or proposal's own map (a status set), a proposal's changes (a
 * change added or decided), or one thread's messages (a reply, counted
 * toward that thread alone). `undefined` too for a container the doc's
 * current state does not hold, which while detached is one the update itself
 * creates: its parent's write is what the update did to that document — and
 * after the update, a thread's new messages map is counted where it now sits.
 * `null` for a document or thread `counted` already holds.
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
  const relative = path.slice(base)
  const bound = ANNOTATION_BOUNDS.find((candidate) => reaches(candidate, relative))
  if (bound === undefined) return undefined
  const prefix = path.slice(0, base).join('/')
  if (bound.scope === 'thread') {
    const messages = doc.getContainerById(container)
    if (!(messages instanceof LoroMap)) return undefined
    const owner = `${prefix} ${bound.shape} ${String(relative[1])}`
    if (counted.has(owner)) return null
    return { bound, owner, map: messages, open: messages.size }
  }
  const depth = relative.length
  let map = doc.getContainerById(container) as LoroMap | undefined
  for (let up = 1; up < depth && map !== undefined; up += 1) {
    map = map.parent() as LoroMap | undefined
  }
  if (map === undefined) return undefined
  const owner = `${prefix} ${bound.shape}`
  // Counting walks every thread or change the document holds, and an update
  // writes one container per thread it touches, so a document already
  // counted is not counted again: once per document, not once per write.
  if (counted.has(owner)) return null
  const open = annotationMaps(doc, map, bound).reduce(
    (sum, [mapKey, held]) => sum + bound.walk(mapKey, held),
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
 * changes than its bound, or a thread holding more messages, and more than
 * before. A document that held none of a bound's maps before the update held
 * none open, and a thread it created held no messages.
 */
export function annotationBreach(
  doc: LoroDoc,
  written: ReadonlySet<ContainerID>,
  before: ReadonlyMap<string, AnnotationWrite>,
): AnnotationCountBreach | null {
  for (const [owner, { bound, map, open }] of annotationCounts(doc, written)) {
    if (growsPast(bound.max, before.get(owner)?.open ?? 0, open)) {
      return { shape: bound.shape, count: open, container: map.id }
    }
  }
  return null
}

/** No update this short can take any annotation bound past itself from where `mostOpenAnnotations` found them. */
export const SMALLEST_ANNOTATION_BOUND = Math.min(...ANNOTATION_BOUNDS.map(({ max }) => max))

/**
 * What `bound` counts of one document, shifted onto `SMALLEST_ANNOTATION_BOUND`
 * — so `mostOpenAnnotations(doc) + n <= SMALLEST_ANNOTATION_BOUND` says that
 * `n` more entries take no bound past its own `max`, whichever it is.
 */
function measured(bound: AnnotationBound, read: (key: string) => LoroMap | undefined): number {
  const held = bound.keys.reduce((sum, key) => {
    const map = read(key)
    return sum + (map === undefined ? 0 : bound.walk(key, map))
  }, 0)
  return held + SMALLEST_ANNOTATION_BOUND - bound.max
}

/**
 * The nearest any document in `doc` comes to an annotation bound — its open
 * threads, its open proposed changes, its longest thread — at its root or
 * under any workspace-tree node, each measured against the smallest bound
 * (`measured`); opened only where present, as `longestBody` does.
 */
export function mostOpenAnnotations(doc: LoroDoc): number {
  const roots = doc.getShallowValue()
  let most = 0
  for (const bound of ANNOTATION_BOUNDS) {
    most = Math.max(
      most,
      measured(bound, (key) => (key in roots ? doc.getMap(key) : undefined)),
    )
  }
  if (!(WORKSPACE_TREE_KEY in roots)) return most
  for (const node of doc.getTree(WORKSPACE_TREE_KEY).getNodes()) {
    for (const bound of ANNOTATION_BOUNDS) {
      const read = (key: string) => {
        const map = node.data.get(key)
        return map instanceof LoroMap ? map : undefined
      }
      most = Math.max(most, measured(bound, read))
    }
  }
  return most
}
