// What a sync update does to text, judged once for every keeper: the daemon's
// sync routes and the browser keeper's own store take or refuse the same
// bytes, so a document cannot hold text one keeper accepted and the other
// would refuse.
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import type { ContainerID, JsonSchema, LoroDoc, LoroText, MapOp, TextOp } from 'loro-crdt'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { isEngineTrap } from './engine-trap.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/**
 * Why a sync update was refused: one insert longer than `MARKDOWN_MAX_CHARS`
 * (`run`), or a markdown body it left past that limit and longer than it was
 * (`body`). Counts are UTF-16 units, the length the limit counts.
 */
export interface SyncTextBreach {
  readonly shape: 'run' | 'body'
  readonly chars: number
}

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
  longestRun: number
  /** Characters inserted minus characters deleted, per text container. */
  net: Map<ContainerID, number>
  touchesNodeMeta: boolean
}

function touchesMeta(op: Op): boolean {
  if (op.container === `cid:root-${WORKSPACE_TREE_KEY}:Tree`) return true
  if (!op.container.endsWith(':Map')) return false
  return NODE_META_KEYS.has((op.content as MapOp).key)
}

/**
 * Reads the inserts and deletes out of an update's JSON form.
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
    longestRun: 0,
    net: new Map(),
    touchesNodeMeta: false,
  }
  const grow = (container: ContainerID, by: number) =>
    writes.net.set(container, (writes.net.get(container) ?? 0) + by)
  for (const change of json.changes) {
    const peer = change.id.slice(change.id.indexOf('@') + 1)
    for (const op of change.ops) {
      writes.touchesNodeMeta ||= touchesMeta(op)
      if (!op.container.endsWith(':Text')) continue
      const content = op.content as TextOp
      if (content.type === 'insert') {
        const key = `${op.container} ${peer}`
        const run = extendRun(runs.get(key), op.counter, content.pos, content.text)
        runs.set(key, run)
        writes.longestRun = Math.max(writes.longestRun, run.units)
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

function bodyBreach(doc: LoroDoc, net: ReadonlyMap<ContainerID, number>): SyncTextBreach | null {
  for (const [container, grew] of net) {
    if (grew <= 0 || !isContentContainer(doc, container, MARKDOWN_BODY_KEY)) continue
    const length = (doc.getContainerById(container) as LoroText).length
    if (length > MARKDOWN_MAX_CHARS) return { shape: 'body', chars: length }
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
 * A body is judged after the state is brought up, since only the state
 * knows the resulting length. Shrinking one already past the limit is
 * allowed, as `wb_body_edit` allows it: refusing the edit that makes a
 * document smaller would leave it stuck.
 *
 * On a breach `doc` holds operations it must not keep, possibly still
 * detached: the caller discards the instance. Bytes the engine refuses are
 * rethrown with `doc` as it was. An engine trap is rethrown as it came; the
 * instance it struck is unusable.
 */
export function importWithinTextLimits(doc: LoroDoc, update: Uint8Array): SyncTextJudgement {
  const from = doc.oplogVersion()
  doc.detach()
  try {
    doc.import(update)
  } catch (err) {
    // A refused import left the oplog as it was; a trapped instance is never touched again.
    if (!isEngineTrap(err)) doc.attach()
    throw err
  }
  // Uncompressed peers, so a container id in the JSON is one the document resolves.
  const writes = readWrites(doc.exportJsonUpdates(from, doc.oplogVersion(), false))
  const judged = (breach: SyncTextBreach | null): SyncTextJudgement => ({
    breach,
    touchesNodeMeta: writes.touchesNodeMeta,
  })
  if (writes.longestRun > MARKDOWN_MAX_CHARS) {
    return judged({ shape: 'run', chars: writes.longestRun })
  }
  doc.attach()
  return judged(bodyBreach(doc, writes.net))
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
 * unit never takes less than one byte, so no insert or body growth it
 * carries is longer than its byte length (`sync-text-limits.test.ts` pins
 * that encoding). An update short enough that no limit can be reached is
 * therefore answered without being applied; only one that might is judged on
 * a fork. A fork copies the whole record — 6 to 74 ms for records of 0.1 to
 * 5 M characters — which a keystroke must not pay.
 */
export function syncTextLimitBreach(record: LoroDoc, update: Uint8Array): SyncTextBreach | null {
  const most = update.byteLength
  if (longestBody(record) + most <= MARKDOWN_MAX_CHARS) return null
  return importWithinTextLimits(record.fork(), update).breach
}
