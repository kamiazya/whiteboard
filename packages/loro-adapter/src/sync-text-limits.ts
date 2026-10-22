// What a sync update does to text, judged once for every keeper and every
// kind of document: the daemon's sync routes and the browser keeper's own
// store take or refuse the same bytes — a note's body, a canvas's node text,
// labels and comment messages alike — so a document cannot hold text one
// keeper accepted and the other would refuse, which is what promoting a
// browser-kept workspace to the daemon would otherwise trip over.
import {
  CANVAS_MAX_EDGES_AND_LINES,
  CANVAS_MAX_NODES,
  CONTAINER_NAME_MAX_CHARS,
  growsPast,
  MARKDOWN_MAX_CHARS,
  type SyncWriteRefusalCode,
} from '@kamiazya/whiteboard-model'
import {
  type ContainerID,
  type JsonSchema,
  LoroDoc,
  type LoroMap,
  type LoroText,
  type MapOp,
  type TextOp,
  type VersionVector,
} from 'loro-crdt'
import { heldBefore, longNameBreach, type NameSuspect, nameSuspectsOf } from './container-names.js'
import { EDGES_KEY, LINES_KEY, MARKDOWN_BODY_KEY, NODES_KEY } from './containers.js'
import { isEngineTrap } from './engine-trap.js'
import { heldBound } from './held-bound.js'
import { isNodeMetaContainer } from './node-meta-containers.js'
import {
  annotationBreach,
  annotationCounts,
  mostOpenAnnotations,
  type OpenAnnotationsBreach,
  SMALLEST_ANNOTATION_BOUND,
} from './sync-annotation-limits.js'
import {
  type ContentRootBreach,
  contentKeyWrites,
  contentRootBreach,
  RESERVED_MAP_KEY,
  type ReservedMapKeyBreach,
  reservedKeyBreach,
  type UnattachedContainerBreach,
  unattachedBreach,
} from './sync-structure-limits.js'
import {
  BOUNDED_VALUES,
  type BoundedValue,
  isContentContainer,
  type ValueBreach,
} from './sync-value-bounds.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/**
 * Why a sync update was refused: one insert longer than `MARKDOWN_MAX_CHARS`
 * (`run`), separate inserts each within it that together cost more to apply
 * than one insert of that length (`runs`), a markdown body it left past that limit and longer than it was
 * (`body`), a node's text it added or grew past `NODE_TEXT_MAX_CHARS`
 * (`node-text`), a link's URL, a file's path or subpath or a group's
 * background past `NODE_LOCATION_MAX_CHARS` (`node-location`), an edge's, line's or group's
 * label past `LABEL_MAX_CHARS` (`label`), a comment message past
 * `COMMENT_MESSAGE_MAX_CHARS` (`comment-message`), a node's, edge's or
 * board's tags past `TAGS_PER_ELEMENT_MAX` in number or with one past
 * `TAG_MAX_CHARS` (`tags`), or a container it brought in named past
 * `CONTAINER_NAME_MAX_CHARS` (`container-name`), or a board it grew past
 * `CANVAS_MAX_NODES` nodes or `CANVAS_MAX_EDGES_AND_LINES` edges and lines
 * together (`canvas-size`), or a comment thread whose anchor it left naming
 * more than `CANVAS_MAX_NODES` nodes (`thread-anchor`), or a document it left holding more than
 * `DOCUMENT_MAX_OPEN_THREADS` open comment threads (`open-threads`) or
 * `DOCUMENT_MAX_OPEN_CHANGES` open proposed changes (`open-changes`), and
 * more than before.
 * Lengths are UTF-16 units, the length every limit counts.
 *
 * Two are about what it leaves standing (`sync-structure-limits.ts`).
 *
 * The board's size is judged here with its text because it is the same
 * judgement on the same bytes, owed by the same keepers: what an update
 * leaves for every later render to lay out again.
 */
export type SyncTextBreach =
  | {
      readonly shape: 'run' | 'body'
      readonly chars: number
      /** The text container that broke it, so a caller can name the document. */
      readonly container: ContainerID
    }
  | {
      readonly shape: 'runs'
      /** Every unit the update inserts, over all its runs. */
      readonly chars: number
      /** How many separate runs carried them. */
      readonly runs: number
      /** The container holding the longest of them, so a caller can name a document. */
      readonly container: ContainerID
    }
  | ValueBreach
  | {
      readonly shape: 'container-name'
      /** The name's length, or the key's for a child a peer's op id names, which a copy names by it. */
      readonly chars: number
      /** The container whose name is past the bound. */
      readonly container: ContainerID
    }
  | {
      readonly shape: 'canvas-size'
      /** Which bound: the board's nodes, or its edges and lines together. */
      readonly measure: 'nodes' | 'edges-and-lines'
      /** How many the board would hold. */
      readonly count: number
      /** The map holding them, so a caller can name the document. */
      readonly container: ContainerID
    }
  | OpenAnnotationsBreach<'open-threads'>
  | OpenAnnotationsBreach<'open-changes'>
  | ContentRootBreach
  | UnattachedContainerBreach
  | ReservedMapKeyBreach

/**
 * The refusal code each breach is answered with, by either keeper. One table,
 * so the daemon's refusal and the browser keeper's cannot name the same
 * breach differently: a run and a body are both a markdown body too large.
 */
export const SYNC_TEXT_BREACH_CODES = {
  run: 'markdown_too_large',
  runs: 'markdown_too_large',
  body: 'markdown_too_large',
  'node-text': 'node_text_too_large',
  'node-location': 'node_location_too_large',
  label: 'label_too_large',
  'comment-message': 'comment_too_large',
  tags: 'tags_too_large',
  'container-name': 'container_name_too_long',
  'canvas-size': 'too_many_nodes_or_edges',
  'thread-anchor': 'comment_anchor_too_large',
  'anchor-quote': 'anchor_quote_too_long',
  'open-threads': 'too_many_open_threads',
  'open-changes': 'too_many_open_changes',
  'content-root': 'invalid_document_root',
  'reserved-map-key': 'reserved_map_key',
  // Sent built on the change that creates the container, it is an ordinary write.
  'unattached-container': 'causal_gap',
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
  /**
   * Every map the update set or deleted a `kind` key in — the only maps
   * where it can have changed what a document's envelope says it is
   * (`envelopeKindBreach`).
   */
  readonly kindWrittenIn: ReadonlySet<ContainerID>
  /**
   * Whether the import parked changes that build on a change the document
   * does not hold. Loro keeps them outside the oplog, so the judgement never
   * read them, and applies them as soon as a later import supplies what they
   * build on — so a keeper refuses the update and drops the instance, the
   * one way to be rid of them.
   */
  readonly pending: boolean
}

type Op = JsonSchema['changes'][number]['ops'][number]
type LongValue = { container: ContainerID; key: string; bound: BoundedValue }
type Run = { counter: number; pos: number; units: number }

/**
 * No update this short can breach any of `BOUNDED_VALUES`' bounds, nor name a container past
 * `CONTAINER_NAME_MAX_CHARS` or nest one under a key past it: the bytes carry
 * the name or key whole (`sync-text-limits.container-names.test.ts` pins that
 * encoding).
 */
const SMALLEST_VALUE_BOUND = Math.min(
  CONTAINER_NAME_MAX_CHARS,
  ...BOUNDED_VALUES.map((bound) => bound.max),
)

/**
 * What attaching an update may cost, in the engine's terms: one run at
 * `MARKDOWN_MAX_CHARS`, the cost the limit was sized to (about a second).
 */
const RUN_COST_BUDGET = MARKDOWN_MAX_CHARS ** 2

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
  /**
   * What applying every run costs, as the engine charges it: the sum of each
   * run's squared length in units. Units inserted and runs counted beside it,
   * for the refusal to say.
   */
  runCost: { squared: number; units: number; runs: number }
  /** Characters inserted minus characters deleted, per text container. */
  net: Map<ContainerID, number>
  /**
   * Map entries this update set to a value whose text is past one of
   * `BOUNDED_VALUES`' bounds, by `container key bound`.
   */
  longValues: Map<string, LongValue>
  /** Where the update may bring in a container named past `CONTAINER_NAME_MAX_CHARS`. */
  names: NameSuspect[]
  /** Every map the update set a key in — the only maps a board can have grown in. */
  setInto: Set<ContainerID>
  /** Every map the update set or deleted a key in — the only maps whose size it changed. */
  mapsWritten: Set<ContainerID>
  /** Every map the update set or deleted a `kind` key in. */
  kindWrittenIn: Set<ContainerID>
  touchesNodeMeta: boolean
}

/**
 * Whether `op` writes a workspace-tree node's meta: the node's OWN map — the
 * map the node meta schemas read every key of, so a write of any key there
 * can move, rename or hide a node — or anything inside a container held at a
 * meta key, which a reader refuses but which an edit could otherwise reach
 * from below the map. Decided by where the container sits rather than by
 * which key is written: a page edit writes the content containers below that
 * map and never the map itself, so it pays one path lookup per container and
 * none of the placement walk this answer gates.
 */
function touchesMeta(doc: LoroDoc, op: Op, nodeMaps: Map<ContainerID, boolean>): boolean {
  if (op.container === `cid:root-${WORKSPACE_TREE_KEY}:Tree`) return true
  let known = nodeMaps.get(op.container)
  if (known === undefined) {
    known = isNodeMetaContainer(doc.getPathToContainer(op.container), op.container)
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
    runCost: { squared: 0, units: 0, runs: 0 },
    net: new Map(),
    longValues: new Map(),
    names: [],
    setInto: new Set(),
    mapsWritten: new Set(),
    kindWrittenIn: new Set(),
    touchesNodeMeta: false,
  }
  for (const change of json.changes) {
    const peer = change.id.slice(change.id.indexOf('@') + 1)
    for (const op of change.ops) {
      writes.touchesNodeMeta ||= touchesMeta(doc, op, nodeMaps)
      writes.names.push(...nameSuspectsOf(op))
      if (op.container.endsWith(':Map')) readMapWrite(writes, op)
      else if (op.container.endsWith(':Text')) readTextWrite(writes, runs, peer, op)
    }
  }
  return writes
}

/** A map value long enough to break a bound if it is where that bound applies, kept for the judgement after the import. */
function readMapWrite(writes: UpdateWrites, op: Op): void {
  const content = op.content as MapOp
  writes.mapsWritten.add(op.container)
  if (content.key === 'kind') writes.kindWrittenIn.add(op.container)
  if (content.type !== 'insert') return
  writes.setInto.add(op.container)
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
  // The run's length before this insert: the run it extended, or nothing.
  const was = run.units - content.text.length
  writes.runCost = {
    squared: writes.runCost.squared + run.units ** 2 - was ** 2,
    units: writes.runCost.units + content.text.length,
    runs: writes.runCost.runs + (was === 0 ? 1 : 0),
  }
  if (run.units > writes.longestRun.units) {
    writes.longestRun = { units: run.units, container: op.container }
  }
  grow(scalarLength(content.text))
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
      return value.bound.breach(length, value.key, value.container, doc)
    }
  }
  return null
}

/**
 * Each per-canvas bound and the maps it counts together. Edges and lines
 * share one: the layout routes both through one pipeline, so a line costs
 * what an edge costs (`canvas-size`).
 */
const CANVAS_BOUNDS = [
  { keys: [NODES_KEY], measure: 'nodes', max: CANVAS_MAX_NODES },
  { keys: [EDGES_KEY, LINES_KEY], measure: 'edges-and-lines', max: CANVAS_MAX_EDGES_AND_LINES },
] as const

type CanvasBound = (typeof CANVAS_BOUNDS)[number]

/** How many entries the map `container` holds in the doc's current state; 0 when there is none. */
function entriesIn(doc: LoroDoc, container: ContainerID): number {
  try {
    return (doc.getContainerById(container) as LoroMap | undefined)?.size ?? 0
  } catch {
    // A container the update itself creates does not exist in the earlier state.
    return 0
  }
}

/** The bound `container` counts toward, when it is one of a board's element maps. */
function canvasBoundOf(doc: LoroDoc, container: ContainerID): CanvasBound | undefined {
  return CANVAS_BOUNDS.find(({ keys }) =>
    keys.some((key) => isContentContainer(doc, container, key)),
  )
}

/**
 * The maps `bound` counts on the board holding `container`, in the doc's
 * current state; a sibling the board does not hold yet is absent. A root is
 * opened only when present, so the judgement adds none to the record.
 */
function boardMaps(doc: LoroDoc, container: ContainerID, bound: CanvasBound): LoroMap[] {
  const parent = (doc.getContainerById(container) as LoroMap | undefined)?.parent() as
    | LoroMap
    | undefined
  if (parent === undefined) {
    const roots = doc.getShallowValue()
    return bound.keys.filter((key) => key in roots).map((key) => doc.getMap(key))
  }
  return bound.keys.flatMap((key) => {
    const map = parent.get(key) as LoroMap | undefined
    return map === undefined ? [] : [map]
  })
}

/**
 * A board the update grew past a per-canvas bound. Only the maps it set a key
 * in can have grown, and a board past a bound before the update is judged
 * against itself, by `growsPast`, so removing is how it shrinks. `before`
 * holds the size, as the update found it, of every map the update wrote;
 * any other map on the board it left as it was.
 */
function canvasBreach(
  doc: LoroDoc,
  setInto: ReadonlySet<ContainerID>,
  before: ReadonlyMap<ContainerID, number>,
): SyncTextBreach | null {
  for (const container of setInto) {
    const bound = canvasBoundOf(doc, container)
    if (bound === undefined) continue
    const maps = boardMaps(doc, container, bound)
    const count = maps.reduce((sum, map) => sum + map.size, 0)
    const was = maps.reduce((sum, map) => sum + (before.get(map.id) ?? map.size), 0)
    if (growsPast(bound.max, was, count)) {
      return { shape: 'canvas-size', measure: bound.measure, count, container }
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
 * up only once it is within budget.
 *
 * The attach pays for EVERY run, so the budget is on their sum of squared
 * lengths, at the cost of one run at the limit (`RUN_COST_BUDGET`): one run
 * past `MARKDOWN_MAX_CHARS` is refused as a `run`, and separate runs each
 * within it whose squares together pass the budget as `runs`. A cap on the
 * longest run alone let an update of many runs just under it block for the
 * sum of them (measured: 8 runs of 200 k characters, 6.3 s). Editor traffic
 * is many short runs, which this leaves alone: runs of at most 4 Ki units
 * pass the budget only past 16 Mi units in total, more than a request body
 * carries. That holds the blocking half at about the second the limit was
 * sized to.
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
 * instance it struck is unusable. Anything else thrown once the import has
 * landed is rethrown as `UnjudgedImportError`, so a caller cannot read it as
 * refused bytes and keep an instance holding operations nobody judged.
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
  let pending: boolean
  try {
    pending = (doc.import(update).pending?.size ?? 0) > 0
  } catch (err) {
    // A refused import left the oplog as it was; a trapped instance is never touched again.
    if (replays && !isEngineTrap(err)) doc.attach()
    throw err
  }
  try {
    return { ...judgeImported(doc, from, replays), pending }
  } catch (err) {
    if (isEngineTrap(err)) throw err
    throw new UnjudgedImportError(err)
  }
}

/**
 * An update landed in a document and its judgement threw before it could
 * answer. The document holds the update's operations, judged or not, so it
 * must be discarded exactly as a refused one is.
 */
export class UnjudgedImportError extends Error {
  constructor(cause: unknown) {
    super('The update was imported but could not be judged', { cause })
    this.name = 'UnjudgedImportError'
  }
}

function judgeImported(
  doc: LoroDoc,
  from: VersionVector,
  replays: boolean,
): Omit<SyncTextJudgement, 'pending'> {
  // Uncompressed peers, so a container id in the JSON is one the document resolves.
  const json = doc.exportJsonUpdates(from, doc.oplogVersion(), false)
  const structural = unattachedBreach(doc, json) ?? reservedKeyBreach(json)
  if (structural !== null) {
    return { breach: structural, touchesNodeMeta: true, kindWrittenIn: new Set() }
  }
  const writes = readWrites(doc, json)
  const judged = (breach: SyncTextBreach | null): Omit<SyncTextJudgement, 'pending'> => ({
    breach,
    touchesNodeMeta: writes.touchesNodeMeta,
    kindWrittenIn: writes.kindWrittenIn,
  })
  const { units, container } = writes.longestRun
  if (replays && units > MARKDOWN_MAX_CHARS && container !== null) {
    return judged({ shape: 'run', chars: units, container })
  }
  const cost = writes.runCost
  if (replays && cost.squared > RUN_COST_BUDGET && container !== null) {
    return judged({ shape: 'runs', chars: cost.units, runs: cost.runs, container })
  }
  // While detached, the state read is the one before the update; an empty
  // document had no node before it.
  const before = new Map(
    replays ? [...writes.longValues].map(([id, value]) => [id, lengthIn(doc, value)]) : [],
  )
  const namedBefore = replays ? heldBefore(doc, writes.names) : new Set<ContainerID>()
  const entriesBefore = new Map(
    [...writes.mapsWritten].map((container) => [
      container,
      replays ? entriesIn(doc, container) : 0,
    ]),
  )
  const annotationsBefore = replays ? annotationCounts(doc, writes.mapsWritten) : new Map()
  if (replays) doc.attach()
  const longName = longNameBreach(doc, writes.names, namedBefore)
  return judged(
    longName === null
      ? (contentRootBreach(doc, contentKeyWrites(json)) ??
          bodyBreach(doc, writes.net) ??
          valueBreach(doc, writes.longValues, before) ??
          canvasBreach(doc, writes.setInto, entriesBefore) ??
          annotationBreach(doc, writes.mapsWritten, annotationsBefore))
      : { shape: 'container-name', ...longName },
  )
}

/**
 * The verdict `importWithinTextLimits` gives the state `doc` is in, as though
 * that state were written into an empty document — for a state no sync write
 * produced, such as a saved version checked out of a carried record, which
 * the judge never saw as a head. One judgement rather than a second set of
 * bounds, so a version cannot be refused or admitted by a rule the sync
 * surface does not apply. Every bound is judged against nothing before, and
 * no run is, as for any write into an empty document.
 *
 * `forkAt` so a checked-out `doc` is judged at the state it shows, not at its
 * oplog's head. `doc` is left as it was.
 */
export function judgeStateWithinTextLimits(doc: LoroDoc): SyncTextBreach | null {
  const state = doc.forkAt(doc.frontiers()).export({ mode: 'snapshot' })
  return importWithinTextLimits(new LoroDoc(), state).breach
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
 * The most any board in `doc` holds against one per-canvas bound — its nodes,
 * or its edges and lines together — at its root or under any workspace-tree
 * node, opened only where present, as `longestBody` does.
 */
function largestBoard(doc: LoroDoc): number {
  const roots = doc.getShallowValue()
  let largest = 0
  for (const { keys } of CANVAS_BOUNDS) {
    const held = keys.reduce((sum, key) => sum + (key in roots ? doc.getMap(key).size : 0), 0)
    largest = Math.max(largest, held)
  }
  if (!(WORKSPACE_TREE_KEY in roots)) return largest
  for (const node of doc.getTree(WORKSPACE_TREE_KEY).getNodes()) {
    for (const { keys } of CANVAS_BOUNDS) {
      const held = keys.reduce(
        (sum, key) => sum + ((node.data.get(key) as LoroMap | undefined)?.size ?? 0),
        0,
      )
      largest = Math.max(largest, held)
    }
  }
  return largest
}

const RESERVED_KEY_BYTES = new TextEncoder().encode(RESERVED_MAP_KEY)

/**
 * Whether `update`'s bytes hold `RESERVED_MAP_KEY` anywhere — they carry every
 * key and root name whole, so one that does not cannot write it. Text that
 * merely spells it is judged in full and let through there.
 */
function mayNameReservedKey(update: Uint8Array): boolean {
  const [first] = RESERVED_KEY_BYTES
  for (
    let at = update.indexOf(first as number);
    at !== -1;
    at = update.indexOf(first as number, at + 1)
  ) {
    if (RESERVED_KEY_BYTES.every((byte, offset) => update[at + offset] === byte)) return true
  }
  return false
}

/** No update this short can take a board past either per-canvas bound from where `largestBoard` found it. */
const SMALLEST_CANVAS_BOUND = Math.min(...CANVAS_BOUNDS.map(({ max }) => max))

/**
 * The verdict `importWithinTextLimits` gives each update offered to `record`,
 * leaving `record` as it was — for a keeper with no cached instance to
 * discard. The caller imports into `record` what the judge lets through.
 *
 * An update's bytes hold every string it writes uncompressed, and a UTF-16
 * unit never takes less than one byte, so no insert, body growth, node text,
 * label, message or tag it carries is longer than its byte length, nor does
 * it carry more tags, or name more anchor nodes, than bytes
 * (`sync-text-limits.test.ts`, `sync-text-limits.tags.test.ts` and
 * `sync-text-limits.thread-anchors.test.ts` pin that encoding). An update short
 * enough that no limit can be reached — no longer than the smallest bound,
 * a label's, and not enough to take the longest body past its own, nor the
 * largest board past a node or edge-and-line bound, nor any document past an
 * open-thread or open-change bound, since an update adds no more map entries
 * (nor sets more statuses) than it has bytes — is therefore answered without
 * being applied.
 *
 * What it leaves standing (`sync-structure-limits.ts`) needs its operations,
 * so it is not judged here: the page's own session, this keeper's only
 * writer, cannot produce either, and the daemon judges every operation of a
 * promoted record's history.
 *
 * Neither the longest body, the largest board nor the most open annotations is walked for each update:
 * every document would be read on every keystroke, in a workspace of
 * hundreds of notes. Each is walked once and then held as a bound
 * (`heldBound`), raised by the byte length of whatever `record` gained since
 * — the same encoding argument, applied to that gain — and walked again only
 * when the bound would let an update through no more.
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
  const longestBodyAtMost = heldBound(record, longestBody)
  const largestBoardAtMost = heldBound(record, largestBoard)
  const mostOpenAtMost = heldBound(record, mostOpenAnnotations)
  return (update) => {
    const most = update.byteLength
    if (most <= SMALLEST_VALUE_BOUND && !mayNameReservedKey(update)) {
      const bodyFits = (walk: boolean) => longestBodyAtMost(walk) + most <= MARKDOWN_MAX_CHARS
      const boardFits = (walk: boolean) => largestBoardAtMost(walk) + most <= SMALLEST_CANVAS_BOUND
      const openFits = (walk: boolean) => mostOpenAtMost(walk) + most <= SMALLEST_ANNOTATION_BOUND
      if (
        (bodyFits(false) || bodyFits(true)) &&
        (boardFits(false) || boardFits(true)) &&
        (openFits(false) || openFits(true))
      ) {
        return null
      }
    }
    if (copy === null) copy = record.fork()
    else copy.import(record.export({ mode: 'update', from: copy.oplogVersion() }))
    const judging = copy
    // Dropped before the judgement, and kept only once it passes: a breach,
    // refused bytes and an engine trap each leave the copy unusable.
    copy = null
    const { breach, pending } = importWithinTextLimits(judging, update)
    // A copy holding parked changes would apply them when a later update
    // fills their gap, and judge that update by them.
    if (breach === null && !pending) copy = judging
    return breach
  }
}
