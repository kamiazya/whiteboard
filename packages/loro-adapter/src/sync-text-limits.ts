// What a sync update does to text, judged once for every keeper and every
// kind of document: the daemon's sync routes and the browser keeper's own
// store take or refuse the same bytes — a note's body, a canvas's node text,
// labels and comment messages alike — so a document cannot hold text one
// keeper accepted and the other would refuse, which is what promoting a
// browser-kept workspace to the daemon would otherwise trip over.
import {
  COMMENT_MESSAGE_MAX_CHARS,
  growsPast,
  LABEL_MAX_CHARS,
  MARKDOWN_MAX_CHARS,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  type SyncWriteRefusalCode,
  TAG_MAX_CHARS,
  TAGS_PER_ELEMENT_MAX,
} from '@kamiazya/whiteboard-model'
import type {
  ContainerID,
  JsonSchema,
  LoroDoc,
  LoroMap,
  LoroText,
  MapOp,
  TextOp,
  VersionVector,
} from 'loro-crdt'
import {
  CANVAS_KEY,
  CANVAS_TAGS_FIELD,
  EDGES_KEY,
  LINES_KEY,
  MARKDOWN_BODY_KEY,
  NODES_KEY,
  THREADS_KEY,
} from './containers.js'
import { isEngineTrap } from './engine-trap.js'
import { liftStoredNode } from './legacy-lifts.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/**
 * Why a sync update was refused: one insert longer than `MARKDOWN_MAX_CHARS`
 * (`run`), a markdown body it left past that limit and longer than it was
 * (`body`), a node's text it added or grew past `NODE_TEXT_MAX_CHARS`
 * (`node-text`), a link's URL or a file's path or subpath past
 * `NODE_LOCATION_MAX_CHARS` (`node-location`), an edge's, line's or group's
 * label past `LABEL_MAX_CHARS` (`label`), a comment message past
 * `COMMENT_MESSAGE_MAX_CHARS` (`comment-message`), or a node's, edge's or
 * board's tags past `TAGS_PER_ELEMENT_MAX` in number or with one past
 * `TAG_MAX_CHARS` (`tags`). Lengths are UTF-16 units, the length every limit
 * counts.
 */
export type SyncTextBreach =
  | {
      readonly shape: 'run' | 'body'
      readonly chars: number
      /** The text container that broke it, so a caller can name the document. */
      readonly container: ContainerID
    }
  | {
      readonly shape: 'node-text'
      readonly chars: number
      readonly nodeId: string
      /** The map holding the node, so a caller can name the document. */
      readonly container: ContainerID
    }
  | {
      readonly shape: 'node-location'
      readonly chars: number
      readonly nodeId: string
      readonly container: ContainerID
    }
  | {
      readonly shape: 'label'
      readonly chars: number
      readonly elementId: string
      readonly container: ContainerID
    }
  | {
      readonly shape: 'comment-message'
      readonly chars: number
      readonly messageId: string
      readonly container: ContainerID
    }
  | {
      readonly shape: 'tags'
      /** Which bound: how many tags, or the longest one's length. */
      readonly measure: 'count' | 'chars'
      readonly amount: number
      /** The node or edge carrying them, or `null` for the board's own. */
      readonly elementId: string | null
      readonly container: ContainerID
    }

/**
 * The refusal code each breach is answered with, by either keeper. One table,
 * so the daemon's refusal and the browser keeper's cannot name the same
 * breach differently: a run and a body are both a markdown body too large.
 */
export const SYNC_TEXT_BREACH_CODES = {
  run: 'markdown_too_large',
  body: 'markdown_too_large',
  'node-text': 'node_text_too_large',
  'node-location': 'node_location_too_large',
  label: 'label_too_large',
  'comment-message': 'comment_too_large',
  tags: 'tags_too_large',
} as const satisfies Record<SyncTextBreach['shape'], SyncWriteRefusalCode>

export interface SyncTextJudgement {
  /** The first limit the update breaks, or `null` when it may be kept. */
  readonly breach: SyncTextBreach | null
  /**
   * Whether any operation can change what a workspace node says about itself
   * — a tree op, or any write to a node's own map. A keeper that checks
   * placement checks it only then.
   */
  readonly touchesNodeMeta: boolean
}

type Op = JsonSchema['changes'][number]['ops'][number]
type LongValue = { container: ContainerID; key: string; bound: BoundedValue }
type Run = { counter: number; pos: number; units: number }

/**
 * A node value's text as the reader lifts it (`liftStoredNode`): a value
 * carrying a legacy kind is read from its `text` whatever `resource` it also
 * holds, so the judge measures the lifted value rather than guessing which
 * field wins. The longer of the two, since a value the lift leaves holding
 * both is one the reader drops anyway.
 */
function nodeTextLength(value: unknown): number {
  const lifted = liftStoredNode(value)
  if (typeof lifted !== 'object' || lifted === null) return 0
  const resource = (lifted as { resource?: unknown }).resource
  return Math.max(fieldLength(resource, 'content'), fieldLength(lifted, 'text'))
}

/**
 * A node value's longest location as every reader lifts it: the resource's
 * `location` or `subpath`, or the legacy `url`, `file` or `subpath` field.
 */
function nodeLocationLength(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const resource = (value as { resource?: unknown }).resource
  return Math.max(
    fieldLength(resource, 'location'),
    fieldLength(resource, 'subpath'),
    ...['url', 'file', 'subpath'].map((field) => fieldLength(value, field)),
  )
}

/** The length of a value's string field, 0 when it has none. */
function fieldLength(value: unknown, field: string): number {
  if (typeof value !== 'object' || value === null) return 0
  const held = (value as Record<string, unknown>)[field]
  return typeof held === 'string' ? held.length : 0
}

/**
 * Whether `container` is a thread's message map — under a document's root or
 * a workspace-tree node, `threads` > thread > `messages`.
 */
function isThreadMessages(doc: LoroDoc, container: ContainerID): boolean {
  const path = doc.getPathToContainer(container)
  if (path?.at(-1) !== 'messages' || path.at(-3) !== THREADS_KEY) return false
  return path.length === 3 || (path.length === 5 && path[0] === WORKSPACE_TREE_KEY)
}

/**
 * Text a write bound holds that lives in a map VALUE rather than a text
 * container — a node, an edge, a line, a message is each one value — so no
 * insert run ever sees it. Each says how long a value's text is, which maps
 * hold such values, and how a breach of it is named.
 */
interface BoundedValue {
  readonly max: number
  readonly length: (value: unknown) => number
  readonly holds: (doc: LoroDoc, container: ContainerID, key: string) => boolean
  readonly breach: (amount: number, key: string, container: ContainerID) => SyncTextBreach
}

/**
 * The tags a map value carries: a node's or edge's own `tags` field, or —
 * for the board, whose tags are one value under their own key — the value
 * itself.
 */
function tagsIn(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'object' || value === null) return []
  const held = (value as { tags?: unknown }).tags
  return Array.isArray(held) ? held : []
}

function longestTag(value: unknown): number {
  let longest = 0
  for (const tag of tagsIn(value)) {
    if (typeof tag === 'string' && tag.length > longest) longest = tag.length
  }
  return longest
}

/**
 * Both tag bounds, for one place tags sit: how many, and the longest. Where
 * the board's tags sit, the value under the key IS the list; on a node or an
 * edge it is the element, carrying its list in `tags`.
 */
function tagBounds(
  holds: BoundedValue['holds'],
  elementOf: (key: string) => string | null,
): BoundedValue[] {
  const measured = (measure: 'count' | 'chars', max: number, length: BoundedValue['length']) => ({
    max,
    length,
    holds,
    breach: (amount: number, key: string, container: ContainerID): SyncTextBreach => ({
      shape: 'tags',
      measure,
      amount,
      elementId: elementOf(key),
      container,
    }),
  })
  return [
    measured('count', TAGS_PER_ELEMENT_MAX, (value) => tagsIn(value).length),
    measured('chars', TAG_MAX_CHARS, longestTag),
  ]
}

const BOUNDED_VALUES: readonly BoundedValue[] = [
  {
    max: NODE_TEXT_MAX_CHARS,
    length: nodeTextLength,
    holds: (doc, container) => isContentContainer(doc, container, NODES_KEY),
    breach: (chars, nodeId, container) => ({ shape: 'node-text', chars, nodeId, container }),
  },
  {
    max: NODE_LOCATION_MAX_CHARS,
    length: nodeLocationLength,
    holds: (doc, container) => isContentContainer(doc, container, NODES_KEY),
    breach: (chars, nodeId, container) => ({ shape: 'node-location', chars, nodeId, container }),
  },
  {
    // A group's label is a node field; an edge's and a line's their own.
    max: LABEL_MAX_CHARS,
    length: (value) => fieldLength(value, 'label'),
    holds: (doc, container) =>
      [NODES_KEY, EDGES_KEY, LINES_KEY].some((key) => isContentContainer(doc, container, key)),
    breach: (chars, elementId, container) => ({ shape: 'label', chars, elementId, container }),
  },
  {
    max: COMMENT_MESSAGE_MAX_CHARS,
    length: (value) => fieldLength(value, 'body'),
    holds: isThreadMessages,
    breach: (chars, messageId, container) => ({
      shape: 'comment-message',
      chars,
      messageId,
      container,
    }),
  },
  ...tagBounds(
    (doc, container) =>
      [NODES_KEY, EDGES_KEY].some((key) => isContentContainer(doc, container, key)),
    (elementId) => elementId,
  ),
  ...tagBounds(
    (doc, container, key) =>
      key === CANVAS_TAGS_FIELD && isContentContainer(doc, container, CANVAS_KEY),
    () => null,
  ),
]

/** No map value shorter than this can breach any bound above. */
const SMALLEST_VALUE_BOUND = Math.min(...BOUNDED_VALUES.map((bound) => bound.max))

/** Unicode scalar values, the unit Loro's counters and text positions advance by. */
function scalarLength(text: string): number {
  let length = 0
  for (const _ of text) length += 1
  return length
}

/** The run an insert at `counter`/`pos` belongs to: `previous` extended when it is adjacent, else its own. */
function extendRun(previous: Run | undefined, counter: number, pos: number, text: string): Run {
  const scalars = scalarLength(text)
  const adjacent = previous?.counter === counter && previous.pos === pos
  return {
    counter: counter + scalars,
    pos: pos + scalars,
    units: adjacent ? previous.units + text.length : text.length,
  }
}

/** What an update's new operations write, read off its JSON form. */
interface UpdateWrites {
  /** The longest contiguous insert, in UTF-16 units — the length `MARKDOWN_MAX_CHARS` counts. */
  longestRun: { units: number; container: ContainerID | null }
  /** Characters inserted minus characters deleted, per text container. */
  net: Map<ContainerID, number>
  /**
   * Map entries this update set to a value whose text is past one of
   * `BOUNDED_VALUES`' bounds, by `container key bound`.
   */
  longValues: Map<string, LongValue>
  touchesNodeMeta: boolean
}

/**
 * Whether `op` writes a workspace-tree node's OWN map — the map the node meta
 * schemas read every key of, so a write of any key there can move, rename or
 * hide a node. Decided by where the map sits rather than by which key is
 * written: a page edit writes the content containers below that map and
 * never the map itself, so it pays nothing for the check this answer gates.
 */
function touchesMeta(doc: LoroDoc, op: Op, nodeMaps: Map<ContainerID, boolean>): boolean {
  if (op.container === `cid:root-${WORKSPACE_TREE_KEY}:Tree`) return true
  if (!op.container.endsWith(':Map')) return false
  let known = nodeMaps.get(op.container)
  if (known === undefined) {
    const path = doc.getPathToContainer(op.container)
    known = path?.length === 2 && path[0] === WORKSPACE_TREE_KEY
    nodeMaps.set(op.container, known)
  }
  return known
}

/**
 * Reads the inserts, deletes and long map values out of an update's JSON form.
 *
 * A run is what the engine charges for: adjacent inserts by one peer join
 * into one run however many changes carried them (measured: one 256 Ki
 * insert and the same characters appended over 16 changes cost the same,
 * while 16 inserts at scattered positions cost 1/30 of it), so the same rule
 * (next counter, next position, same container) joins them here.
 */
function readWrites(doc: LoroDoc, json: JsonSchema): UpdateWrites {
  const runs = new Map<string, Run>()
  const nodeMaps = new Map<ContainerID, boolean>()
  const writes: UpdateWrites = {
    longestRun: { units: 0, container: null },
    net: new Map(),
    longValues: new Map(),
    touchesNodeMeta: false,
  }
  for (const change of json.changes) {
    const peer = change.id.slice(change.id.indexOf('@') + 1)
    for (const op of change.ops) {
      writes.touchesNodeMeta ||= touchesMeta(doc, op, nodeMaps)
      if (op.container.endsWith(':Map')) readMapWrite(writes, op)
      else if (op.container.endsWith(':Text')) readTextWrite(writes, runs, peer, op)
    }
  }
  return writes
}

/** A map value long enough to break a bound if it is where that bound applies, kept for the judgement after the import. */
function readMapWrite(writes: UpdateWrites, op: Op): void {
  const content = op.content as MapOp
  if (content.type !== 'insert') return
  BOUNDED_VALUES.forEach((bound, index) => {
    if (bound.length(content.value) <= bound.max) return
    writes.longValues.set(`${op.container} ${content.key} ${index}`, {
      container: op.container,
      key: content.key,
      bound,
    })
  })
}

/** An insert extends its peer's run and grows its container; a delete shrinks it. */
function readTextWrite(writes: UpdateWrites, runs: Map<string, Run>, peer: string, op: Op): void {
  const content = op.content as TextOp
  const grow = (by: number) =>
    writes.net.set(op.container, (writes.net.get(op.container) ?? 0) + by)
  if (content.type === 'delete') {
    grow(-Math.abs(content.len))
    return
  }
  if (content.type !== 'insert') return
  const key = `${op.container} ${peer}`
  const run = extendRun(runs.get(key), op.counter, content.pos, content.text)
  runs.set(key, run)
  if (run.units > writes.longestRun.units) {
    writes.longestRun = { units: run.units, container: op.container }
  }
  grow(scalarLength(content.text))
}

/**
 * Whether `container` is the content container `key` names: at a document's
 * root, or under a workspace-tree node.
 */
function isContentContainer(doc: LoroDoc, container: ContainerID, key: string): boolean {
  const path = doc.getPathToContainer(container)
  if (path?.at(-1) !== key) return false
  return path.length === 1 || (path.length === 3 && path[0] === WORKSPACE_TREE_KEY)
}

/** The bounded text of the value a map holds at `key` in the doc's current state; 0 when there is none. */
function lengthIn(doc: LoroDoc, { container, key, bound }: LongValue): number {
  try {
    return bound.length((doc.getContainerById(container) as LoroMap | undefined)?.get(key))
  } catch {
    // A container the update itself creates does not exist in the earlier state.
    return 0
  }
}

function valueBreach(
  doc: LoroDoc,
  long: UpdateWrites['longValues'],
  before: ReadonlyMap<string, number>,
): SyncTextBreach | null {
  for (const [id, value] of long) {
    if (!value.bound.holds(doc, value.container, value.key)) continue
    const length = lengthIn(doc, value)
    if (growsPast(value.bound.max, before.get(id) ?? 0, length)) {
      return value.bound.breach(length, value.key, value.container)
    }
  }
  return null
}

function bodyBreach(doc: LoroDoc, net: ReadonlyMap<ContainerID, number>): SyncTextBreach | null {
  for (const [container, grew] of net) {
    if (grew <= 0 || !isContentContainer(doc, container, MARKDOWN_BODY_KEY)) continue
    const length = (doc.getContainerById(container) as LoroText).length
    if (length > MARKDOWN_MAX_CHARS) return { shape: 'body', chars: length, container }
  }
  return null
}

/**
 * Imports `update` into `doc` and judges what it did to text.
 *
 * The limits are judged on what the bytes DO, before the costly half of the
 * import runs. Loro applies a contiguous insert to a non-empty document in
 * time quadratic in its length, and that cost is in bringing the document's
 * STATE up to the new operations, not in taking the operations in: with the
 * document detached, the import only appends to the oplog (2 ms for a
 * 512 Ki-character insert whose attached import costs 3.4 s), and the
 * operations can be read back as JSON at a cost linear in the update. So the
 * update is taken in detached, its inserts measured, and the state brought
 * up only once no single insert is past the limit — which caps the blocking
 * half at the cost the limit was sized to (about a second).
 *
 * A body or a node's text is judged after the state is brought up, since
 * only the state knows the resulting length. Shrinking either when it is
 * already past its limit is allowed, as `wb_body_edit` allows it: refusing
 * the edit that makes a document smaller would leave it stuck, and data
 * stored before a bound must still take an edit that does not grow it.
 *
 * On a breach `doc` holds operations it must not keep, possibly still
 * detached: the caller discards the instance. Bytes the engine refuses are
 * rethrown with `doc` as it was. An engine trap is rethrown as it came; the
 * instance it struck is unusable.
 */
export function importWithinTextLimits(doc: LoroDoc, update: Uint8Array): SyncTextJudgement {
  const from = doc.oplogVersion()
  // Into an EMPTY document the engine loads state rather than replaying runs
  // (measured: a 4 Mi-character insert in 26 ms, and a record whose history
  // once held a 300 Ki insert in 3 ms against 1.6 s replayed), so no run
  // costs anything there and none is judged — a long paste deleted long ago
  // does not bar a record from a fresh workspace.
  const replays = from.length() > 0
  if (replays) doc.detach()
  try {
    doc.import(update)
  } catch (err) {
    // A refused import left the oplog as it was; a trapped instance is never touched again.
    if (replays && !isEngineTrap(err)) doc.attach()
    throw err
  }
  // Uncompressed peers, so a container id in the JSON is one the document resolves.
  const writes = readWrites(doc, doc.exportJsonUpdates(from, doc.oplogVersion(), false))
  const judged = (breach: SyncTextBreach | null): SyncTextJudgement => ({
    breach,
    touchesNodeMeta: writes.touchesNodeMeta,
  })
  const { units, container } = writes.longestRun
  if (replays && units > MARKDOWN_MAX_CHARS && container !== null) {
    return judged({ shape: 'run', chars: units, container })
  }
  // While detached, the state read is the one before the update; an empty
  // document had no node before it.
  const before = new Map(
    replays ? [...writes.longValues].map(([id, value]) => [id, lengthIn(doc, value)]) : [],
  )
  if (replays) doc.attach()
  return judged(bodyBreach(doc, writes.net) ?? valueBreach(doc, writes.longValues, before))
}

/**
 * The longest markdown body `doc` holds, at its root or under any
 * workspace-tree node. A root is only opened when the document has one:
 * opening an absent root adds it to the record (measured: 60 bytes on the
 * next snapshot).
 */
function longestBody(doc: LoroDoc): number {
  const roots = doc.getShallowValue()
  let longest = MARKDOWN_BODY_KEY in roots ? doc.getText(MARKDOWN_BODY_KEY).length : 0
  if (!(WORKSPACE_TREE_KEY in roots)) return longest
  for (const node of doc.getTree(WORKSPACE_TREE_KEY).getNodes()) {
    const body = node.data.get(MARKDOWN_BODY_KEY) as LoroText | undefined
    longest = Math.max(longest, body?.length ?? 0)
  }
  return longest
}

/**
 * The verdict `importWithinTextLimits` gives each update offered to `record`,
 * leaving `record` as it was — for a keeper with no cached instance to
 * discard. The caller imports into `record` what the judge lets through.
 *
 * An update's bytes hold every string it writes uncompressed, and a UTF-16
 * unit never takes less than one byte, so no insert, body growth, node text,
 * label, message or tag it carries is longer than its byte length, nor does
 * it carry more tags than bytes (`sync-text-limits.test.ts` and
 * `sync-text-limits.tags.test.ts` pin that encoding). An update short
 * enough that no limit can be reached — no longer than the smallest bound,
 * a label's, and not enough to take the longest body past its own — is
 * therefore answered without being applied.
 *
 * The longest body is not walked for each update: every document's body
 * would be read on every keystroke, in a workspace of hundreds of notes. It
 * is walked once and then held as a bound, raised by the byte length of
 * whatever `record` gained since — the same encoding argument, applied to
 * that gain — and walked again only when the bound would let an update
 * through no more.
 *
 * Any other update is judged on a copy of the record. The copy is made once
 * and brought up to `record` before each judgement by what `record` gained
 * since — whoever wrote it — so a judgement costs about what the update costs
 * to import, rather than a fork of the whole record (6 to 74 ms for records
 * of 0.1 to 5 M characters) each time: a canvas commit that moves several
 * nodes, or edits a long one, is past the short-update bound. A copy that
 * took a refused update holds operations it must not keep, so it is dropped
 * and made again at the next judgement.
 *
 * ponytail: the copy doubles the record's memory while the keeper serves it;
 * judging on the record itself and reloading it from storage after a refusal
 * would not.
 */
export function syncTextLimitJudge(record: LoroDoc): (update: Uint8Array) => SyncTextBreach | null {
  let copy: LoroDoc | null = null
  let bodies: { readonly at: VersionVector; readonly longest: number } | null = null
  /** At least the longest body `record` holds now: the held bound, or a fresh walk when `walk`. */
  const longestBodyAtMost = (walk: boolean): number => {
    const at = record.oplogVersion()
    let longest: number
    if (bodies === null || walk) longest = longestBody(record)
    else if (at.compare(bodies.at) === 0) longest = bodies.longest
    else longest = bodies.longest + record.export({ mode: 'update', from: bodies.at }).byteLength
    bodies = { at, longest }
    return longest
  }
  return (update) => {
    const most = update.byteLength
    if (most <= SMALLEST_VALUE_BOUND) {
      const fits = (walk: boolean) => longestBodyAtMost(walk) + most <= MARKDOWN_MAX_CHARS
      if (fits(false) || fits(true)) return null
    }
    if (copy === null) copy = record.fork()
    else copy.import(record.export({ mode: 'update', from: copy.oplogVersion() }))
    const judging = copy
    // Dropped before the judgement, and kept only once it passes: a breach,
    // refused bytes and an engine trap each leave the copy unusable.
    copy = null
    const { breach } = importWithinTextLimits(judging, update)
    if (breach === null) copy = judging
    return breach
  }
}
