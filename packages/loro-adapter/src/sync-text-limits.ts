// What a sync update does to text, judged once for every keeper: the daemon's
// sync routes and the browser keeper's own store take or refuse the same
// bytes, so a document cannot hold text one keeper accepted and the other
// would refuse.
import { MARKDOWN_MAX_CHARS, NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import type { ContainerID, JsonSchema, LoroDoc, LoroMap, LoroText, MapOp, TextOp } from 'loro-crdt'
import { MARKDOWN_BODY_KEY, NODES_KEY } from './containers.js'
import { isEngineTrap } from './engine-trap.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/**
 * Why a sync update was refused: one insert longer than `MARKDOWN_MAX_CHARS`
 * (`run`), a markdown body it left past that limit and longer than it was
 * (`body`), or a node's text it added or grew past `NODE_TEXT_MAX_CHARS`
 * (`node-text`). Counts are UTF-16 units, the length both limits count.
 */
export type SyncTextBreach =
  | {
      readonly shape: 'run' | 'body'
      readonly chars: number
      /** The text container that broke it, so a caller can name the document. */
      readonly container: ContainerID
    }
  | { readonly shape: 'node-text'; readonly chars: number; readonly nodeId: string }

export interface SyncTextJudgement {
  /** The first limit the update breaks, or `null` when it may be kept. */
  readonly breach: SyncTextBreach | null
  /**
   * Whether any operation can change what a workspace node says about the
   * document it holds — a tree op, or a write of a key a node's meta carries.
   * A keeper that checks placement checks it only then.
   */
  readonly touchesNodeMeta: boolean
}

/** The keys a workspace-tree node's own meta carries; a write of one can change a path, a kind or a name. */
const NODE_META_KEYS: ReadonlySet<string> = new Set(['documentId', 'segment', 'kind', 'name'])

type Op = JsonSchema['changes'][number]['ops'][number]
type Run = { counter: number; pos: number; units: number }

/** A node value's text as every reader lifts it: the resource's inline content, or the legacy `text` field. */
function nodeTextLength(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const { resource, text } = value as { resource?: { content?: unknown }; text?: unknown }
  if (typeof resource?.content === 'string') return resource.content.length
  return typeof text === 'string' ? text.length : 0
}

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
   * Map entries this update set to a value whose text is past
   * `NODE_TEXT_MAX_CHARS`, by `container key`. A node is one map VALUE, not
   * a text container, so no insert run ever sees its text.
   */
  longNodeText: Map<string, { container: ContainerID; key: string }>
  touchesNodeMeta: boolean
}

function touchesMeta(op: Op): boolean {
  if (op.container === `cid:root-${WORKSPACE_TREE_KEY}:Tree`) return true
  if (!op.container.endsWith(':Map')) return false
  return NODE_META_KEYS.has((op.content as MapOp).key)
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
function readWrites(json: JsonSchema): UpdateWrites {
  const runs = new Map<string, Run>()
  const writes: UpdateWrites = {
    longestRun: { units: 0, container: null },
    net: new Map(),
    longNodeText: new Map(),
    touchesNodeMeta: false,
  }
  const grow = (container: ContainerID, by: number) =>
    writes.net.set(container, (writes.net.get(container) ?? 0) + by)
  for (const change of json.changes) {
    const peer = change.id.slice(change.id.indexOf('@') + 1)
    for (const op of change.ops) {
      writes.touchesNodeMeta ||= touchesMeta(op)
      if (op.container.endsWith(':Map')) {
        const content = op.content as MapOp
        if (content.type === 'insert' && nodeTextLength(content.value) > NODE_TEXT_MAX_CHARS) {
          const at = { container: op.container, key: content.key }
          writes.longNodeText.set(`${op.container} ${content.key}`, at)
        }
        continue
      }
      if (!op.container.endsWith(':Text')) continue
      const content = op.content as TextOp
      if (content.type === 'insert') {
        const key = `${op.container} ${peer}`
        const run = extendRun(runs.get(key), op.counter, content.pos, content.text)
        runs.set(key, run)
        if (run.units > writes.longestRun.units) {
          writes.longestRun = { units: run.units, container: op.container }
        }
        grow(op.container, scalarLength(content.text))
      } else if (content.type === 'delete') {
        grow(op.container, -Math.abs(content.len))
      }
    }
  }
  return writes
}

/**
 * Whether `container` is the content container `key` names: at a document's
 * root, or under a workspace-tree node.
 */
function isContentContainer(doc: LoroDoc, container: ContainerID, key: string): boolean {
  const path = doc.getPathToContainer(container)
  if (path === undefined || path.at(-1) !== key) return false
  return path.length === 1 || (path.length === 3 && path[0] === WORKSPACE_TREE_KEY)
}

/** The text of the node a map holds at `key` in the doc's current state; 0 when there is none. */
function nodeTextIn(doc: LoroDoc, container: ContainerID, key: string): number {
  try {
    return nodeTextLength((doc.getContainerById(container) as LoroMap | undefined)?.get(key))
  } catch {
    // A container the update itself creates does not exist in the earlier state.
    return 0
  }
}

function nodeTextBreach(
  doc: LoroDoc,
  long: UpdateWrites['longNodeText'],
  before: ReadonlyMap<string, number>,
): SyncTextBreach | null {
  for (const [id, { container, key }] of long) {
    if (!isContentContainer(doc, container, NODES_KEY)) continue
    const length = nodeTextIn(doc, container, key)
    if (length > NODE_TEXT_MAX_CHARS && length > (before.get(id) ?? 0)) {
      return { shape: 'node-text', chars: length, nodeId: key }
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
  const writes = readWrites(doc.exportJsonUpdates(from, doc.oplogVersion(), false))
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
    replays
      ? [...writes.longNodeText].map(([id, at]) => [id, nodeTextIn(doc, at.container, at.key)])
      : [],
  )
  if (replays) doc.attach()
  return judged(bodyBreach(doc, writes.net) ?? nodeTextBreach(doc, writes.longNodeText, before))
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
 * The verdict `importWithinTextLimits` gives `update`, leaving `record` as it
 * was — for a keeper with no cached instance to discard.
 *
 * An update's bytes hold every string it writes uncompressed, and a UTF-16
 * unit never takes less than one byte, so no insert, body growth or node
 * text it carries is longer than its byte length (`sync-text-limits.test.ts` pins
 * that encoding). An update short enough that no limit can be reached is
 * therefore answered without being applied; only one that might is judged on
 * a fork. A fork copies the whole record — 6 to 74 ms for records of 0.1 to
 * 5 M characters — which a keystroke must not pay.
 */
export function syncTextLimitBreach(record: LoroDoc, update: Uint8Array): SyncTextBreach | null {
  const most = update.byteLength
  if (most <= NODE_TEXT_MAX_CHARS && longestBody(record) + most <= MARKDOWN_MAX_CHARS) return null
  return importWithinTextLimits(record.fork(), update).breach
}
