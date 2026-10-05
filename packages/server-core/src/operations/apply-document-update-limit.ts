import {
  isEngineTrap,
  MARKDOWN_BODY_KEY,
  WORKSPACE_TREE_KEY,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS, messageOf } from '@kamiazya/whiteboard-model'
import type { ContainerID, JsonSchema, LoroDoc, LoroText, TextOp } from 'loro-crdt'
import { DocumentEngineTrapError, importEvictingOnEngineTrap } from '../document-io.js'
import { getLogger } from '../log.js'

const log = getLogger('sync-write-limit')

/**
 * A sync write refused because of what its bytes would do to a body: insert
 * one piece longer than `MARKDOWN_MAX_CHARS`, or leave a markdown body longer
 * than that and longer than it was. Nothing of the write was kept.
 */
export class MarkdownBodyTooLargeError extends Error {
  constructor(
    public readonly shape: 'run' | 'body',
    public readonly chars: number,
  ) {
    super(
      shape === 'run'
        ? `This update inserts ${chars} characters in one piece, past the ${MARKDOWN_MAX_CHARS}-character limit for one write; split the content across documents`
        : `This update would make a document body ${chars} characters long, past the ${MARKDOWN_MAX_CHARS}-character limit for one document; split the content across documents`,
    )
    this.name = 'MarkdownBodyTooLargeError'
  }
}

interface CachedTarget {
  readonly subject: string
  readonly fields: Record<string, unknown>
  /** Drops the cached instance, so the next read rebuilds it from what was stored. */
  evict(): void
}

/** What an update's new operations do to each text container it touches. */
interface TextGrowth {
  /** The longest contiguous insert, in UTF-16 units — the length `MARKDOWN_MAX_CHARS` counts. */
  longestRun: number
  /** Characters inserted minus characters deleted, per container. */
  net: Map<ContainerID, number>
}

/** Unicode scalar values, the unit Loro's counters and text positions advance by. */
function scalarLength(text: string): number {
  let length = text.length
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xdc00 && unit <= 0xdfff) length -= 1
  }
  return length
}

type Run = { counter: number; pos: number; units: number }

/**
 * Reads the inserts and deletes out of an update's JSON form.
 *
 * A run is what the engine charges for: adjacent inserts by one peer join
 * into one run however many changes carried them (measured: one 256 Ki
 * insert and the same characters appended over 16 changes cost the same,
 * while 16 inserts at scattered positions cost 1/30 of it), so the same rule
 * (next counter, next position, same container) joins them here.
 */
function textGrowth(json: JsonSchema): TextGrowth {
  const runs = new Map<string, Run>()
  const net = new Map<ContainerID, number>()
  const grow = (container: ContainerID, by: number) =>
    net.set(container, (net.get(container) ?? 0) + by)
  let longestRun = 0
  for (const change of json.changes) {
    const peer = change.id.slice(change.id.indexOf('@') + 1)
    for (const op of change.ops) {
      if (!op.container.endsWith(':Text')) continue
      const content = op.content as TextOp
      if (content.type === 'insert') {
        const key = `${op.container} ${peer}`
        const run = extendRun(runs.get(key), op.counter, content.pos, content.text)
        runs.set(key, run)
        longestRun = Math.max(longestRun, run.units)
        grow(op.container, scalarLength(content.text))
      } else if (content.type === 'delete') {
        grow(op.container, -Math.abs(content.len))
      }
    }
  }
  return { longestRun, net }
}

/** The run an insert at `counter`/`pos` belongs to: `previous` extended when it is adjacent, else its own. */
function extendRun(previous: Run | undefined, counter: number, pos: number, text: string): Run {
  const scalars = scalarLength(text)
  const adjacent = previous !== undefined && previous.counter === counter && previous.pos === pos
  return {
    counter: counter + scalars,
    pos: pos + scalars,
    units: adjacent ? previous.units + text.length : text.length,
  }
}

/** A markdown body: the root `body` text of a document, or the one under a workspace-tree node. */
function isMarkdownBody(doc: LoroDoc, container: ContainerID): boolean {
  const path = doc.getPathToContainer(container)
  if (path === undefined) return false
  const last = path.at(-1)
  if (last !== MARKDOWN_BODY_KEY) return false
  return path.length === 1 || (path.length === 3 && path[0] === WORKSPACE_TREE_KEY)
}

function refuse(target: CachedTarget, error: MarkdownBodyTooLargeError): never {
  target.evict()
  log.warning('sync write refused: past the markdown size limit', {
    ...target.fields,
    shape: error.shape,
    chars: error.chars,
  })
  throw error
}

/**
 * Imports a client's update into a CACHED document unless it breaks the
 * markdown size limit, in which case nothing of it is kept.
 *
 * The limit is judged on what the bytes DO, before the costly half of the
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
 * A body the update grows past the limit is refused after the state is
 * brought up, since only the state knows the resulting length. Shrinking a
 * body already past it is allowed, as `wb_body_edit` allows it: refusing the
 * edit that makes a document smaller would leave it stuck. Either refusal
 * drops the cached instance instead of saving, so the next read rebuilds it
 * from storage and nothing of the write survives. Everything from the detach
 * to the refusal is synchronous, so no other request sees the half-taken
 * state.
 */
export function importWithinMarkdownLimit(
  doc: LoroDoc,
  update: Uint8Array,
  target: CachedTarget,
): void {
  const from = doc.oplogVersion()
  doc.detach()
  try {
    importEvictingOnEngineTrap(doc, update, target)
  } catch (err) {
    // A refused import left the oplog as it was; a trapped instance was
    // dropped and is never touched again.
    if (!(err instanceof DocumentEngineTrapError)) doc.attach()
    throw err
  }
  // Uncompressed peers, so a container id in the JSON is one the document resolves.
  const growth = textGrowth(doc.exportJsonUpdates(from, doc.oplogVersion(), false))
  if (growth.longestRun > MARKDOWN_MAX_CHARS) {
    refuse(target, new MarkdownBodyTooLargeError('run', growth.longestRun))
  }
  try {
    doc.attach()
  } catch (err) {
    if (!isEngineTrap(err)) throw err
    target.evict()
    log.error('the CRDT engine trapped applying an update; the cached copy was dropped', {
      ...target.fields,
      updateBytes: update.byteLength,
      err: messageOf(err),
    })
    throw new DocumentEngineTrapError(target.subject, 'importing an update into', err)
  }
  for (const [container, net] of growth.net) {
    if (net <= 0 || !isMarkdownBody(doc, container)) continue
    const length = (doc.getContainerById(container) as LoroText).length
    if (length > MARKDOWN_MAX_CHARS) refuse(target, new MarkdownBodyTooLargeError('body', length))
  }
}
