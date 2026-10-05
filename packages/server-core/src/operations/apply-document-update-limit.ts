import {
  isEngineTrap,
  MARKDOWN_BODY_KEY,
  readWorkspaceDocuments,
  WORKSPACE_TREE_KEY,
} from '@kamiazya/whiteboard-loro-adapter'
import { documentPathSchema, MARKDOWN_MAX_CHARS, messageOf } from '@kamiazya/whiteboard-model'
import type {
  ContainerID,
  Frontiers,
  JsonSchema,
  LoroDoc,
  LoroText,
  MapOp,
  TextOp,
} from 'loro-crdt'
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

/**
 * A sync write refused because it would put documents at paths the
 * document-path grammar refuses — a path every listing and search of the
 * workspace then fails on. Nothing of the write was kept.
 */
export class OffGrammarPathError extends Error {
  constructor(public readonly paths: readonly string[]) {
    super(
      `This update would put documents at paths this keeper cannot store: ${paths.map((path) => `"${path}"`).join(', ')}. A path segment may hold only ASCII letters, digits and interior hyphens`,
    )
    this.name = 'OffGrammarPathError'
  }
}

/** A throw the sync write raises on purpose and its caller answers, not a refused import. */
export function isSyncWriteRefusal(err: unknown): boolean {
  return (
    err instanceof DocumentEngineTrapError ||
    err instanceof MarkdownBodyTooLargeError ||
    err instanceof OffGrammarPathError
  )
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
  /** Whether any operation can move a document's path: a tree op, or a node's segment set. */
  touchesPaths: boolean
}

/** The tree op, or the segment write, that can change where a document's path points. */
function movesPaths(op: JsonSchema['changes'][number]['ops'][number]): boolean {
  if (op.container === `cid:root-${WORKSPACE_TREE_KEY}:Tree`) return true
  if (!op.container.endsWith(':Map')) return false
  const content = op.content as MapOp
  return content.type === 'insert' && content.key === 'segment'
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
  let touchesPaths = false
  for (const change of json.changes) {
    const peer = change.id.slice(change.id.indexOf('@') + 1)
    for (const op of change.ops) {
      touchesPaths ||= movesPaths(op)
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
  return { longestRun, net, touchesPaths }
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

function refuse(
  target: CachedTarget,
  error: MarkdownBodyTooLargeError | OffGrammarPathError,
): never {
  target.evict()
  log.warning('sync write refused', { ...target.fields, reason: error.message })
  throw error
}

/** Where each document of a workspace record sits, by id. */
function pathsById(doc: LoroDoc): Map<string, string> {
  return new Map(readWorkspaceDocuments(doc).map((entry) => [entry.documentId, entry.path]))
}

/**
 * The paths the update MOVED a document onto that the grammar refuses. A
 * document already at such a path and left there is not the update's doing,
 * and moving it off one is how it gets repaired, so both are let through.
 *
 * One walk of the tree in the usual case — no path off the grammar at all.
 * Only when one is found is the state taken back to `before` for a second
 * walk, which costs re-applying this update: that is the rare case of a
 * workspace still holding a path written before the grammar was enforced.
 */
function newOffGrammarPaths(
  doc: LoroDoc,
  before: Frontiers,
  update: Uint8Array,
  target: CachedTarget,
): string[] {
  const offGrammar = [...pathsById(doc)].filter(
    ([, path]) => !documentPathSchema.safeParse(path).success,
  )
  if (offGrammar.length === 0) return []
  doc.checkout(before)
  const earlier = pathsById(doc)
  attachEvictingOnEngineTrap(doc, update, target)
  return offGrammar
    .filter(([documentId, path]) => earlier.get(documentId) !== path)
    .map(([, path]) => path)
}

/** Brings a detached doc's state up to its oplog: the costly half of an import. */
function attachEvictingOnEngineTrap(doc: LoroDoc, update: Uint8Array, target: CachedTarget): void {
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
}

/**
 * Imports a client's update into a CACHED document unless it breaks the
 * markdown size limit or, for a workspace record, the document-path grammar —
 * in which case nothing of it is kept.
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
 * edit that makes a document smaller would leave it stuck.
 *
 * Paths are checked only for an update carrying a tree op or a segment write,
 * and then by one walk of the tree (`newOffGrammarPaths`); a body edit pays
 * nothing for them.
 *
 * Every refusal drops the cached instance instead of saving, so the next
 * read rebuilds it from storage and nothing of the write survives.
 * Everything from the detach to the refusal is synchronous, so no other
 * request sees the half-taken state.
 */
export function importWithinSyncLimits(
  doc: LoroDoc,
  update: Uint8Array,
  target: CachedTarget,
  options: { readonly workspaceRecord: boolean },
): void {
  const from = doc.oplogVersion()
  const fromFrontiers = doc.oplogFrontiers()
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
  attachEvictingOnEngineTrap(doc, update, target)
  for (const [container, net] of growth.net) {
    if (net <= 0 || !isMarkdownBody(doc, container)) continue
    const length = (doc.getContainerById(container) as LoroText).length
    if (length > MARKDOWN_MAX_CHARS) refuse(target, new MarkdownBodyTooLargeError('body', length))
  }
  if (!(options.workspaceRecord && growth.touchesPaths)) return
  const offGrammar = newOffGrammarPaths(doc, fromFrontiers, update, target)
  if (offGrammar.length > 0) refuse(target, new OffGrammarPathError(offGrammar))
}
