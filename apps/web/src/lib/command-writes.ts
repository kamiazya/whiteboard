// How one editor command reaches the document: what it writes (`planCommand`,
// pure over the canvas pair and two lazy reads), the whole-canvas reconcile it
// falls back to, and the key a debounce window dedupes repeat edits to one
// target under. A plan is engine wire writes, so a plain LoroDoc and an engine
// handle apply the same one; the session owns the debounce, the undo manager
// and everything that outlives one write.

import type { WriteTarget } from '@kamiazya/whiteboard-loro-adapter'
import type { documentEngine, SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { getAppLogger } from './app-logger.js'
import { applyAdoptedPassages } from './apply-adopted-passages.js'
import type { EditorCommand, EditorLeafCommand } from './spatial/commands.js'

const log = getAppLogger('document-sync')

/**
 * Stable key identifying the single node/edge a command targets, so a
 * debounce window can dedupe repeat edits to the SAME target down to one
 * write while still keeping edits to DIFFERENT targets separate. Commands
 * with no mapped target (see `planElement`'s `default` case) get a
 * fresh key per call — each one already falls back to a full
 * whole-canvas reconcile, so there is nothing to dedupe.
 */
let unmappedCommandCounter = 0
export function commandTargetKey(command: EditorCommand): string {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text':
    case 'delete-node':
      return `node:${command.id}`
    case 'connect-nodes':
      return `edge:${command.edgeId}`
    case 'create-node':
      return `node:${command.node.id}`
    case 'move-thread':
      return `thread-anchor:${command.threadId}`
    case 'reply-to-thread':
      // Keyed by MESSAGE, not by thread. Every other key here dedupes to the
      // last value for one target, which is right when the target holds one
      // value — a node's position, a thread's status. A reply APPENDS: two
      // replies to the same thread inside one debounce window are two
      // messages, and a `thread:` key would silently commit only the second.
      return `message:${command.message.id}`
    case 'edit-thread-message':
      // Keyed by the message it rewrites, so an edit and a reply to the same
      // thread inside one window are two writes, and two edits of the same
      // message are the last one.
      return `message:${command.message.id}`
    case 'set-thread-status':
      return `thread-status:${command.threadId}`
    case 'create-thread':
      // Keyed by THREAD, unlike the reply above: what this command carries is
      // the whole conversation, so two of them for the same id inside one
      // window really are one target written twice — while two different
      // threads keep separate keys and both commit.
      return `thread:${command.thread.id}`
    case 'set-body':
      // One key for the whole body: `text` is always the complete document,
      // so a burst of keystrokes inside one debounce window collapses to the
      // last one — which is the entire point of deduping here.
      return 'body'
    case 'set-facets':
      return 'facets'
    case 'decide-proposal':
      // Keyed by PROPOSAL: a decision is the whole proposal answered once,
      // so two presses inside one window really are one target written
      // twice — while two proposals decided in a burst keep separate keys.
      return `proposal:${command.proposalId}`
    case 'batch':
      // Mapped in writeCommandTarget (unlike the default arm), but each
      // batch is one distinct user action — never deduped against another.
      return `batch:${++unmappedCommandCounter}`
    default:
      return `unmapped:${++unmappedCommandCounter}`
  }
}

/**
 * What a plan reads of the document, lazily: a body is as long as a document
 * may be and most commands never look at it. A plan is made against the
 * document as the previous command left it, so a caller applies one plan
 * before it makes the next.
 */
type PlanReads = Pick<WriteTarget, 'documentId' | 'body' | 'coreFacets'>

type Write = documentEngine.Write
type Refusal = 'target-missing' | 'unmapped'
type Planned = Write[] | Refusal

/**
 * What one command writes. `fallback` is the whole-canvas reconcile to apply
 * when `writes` throws; absent when `writes` already is that reconcile.
 */
interface CommandPlan {
  readonly writes: readonly Write[]
  readonly fallback: readonly Write[] | undefined
  /** The command named a target `next` does not hold, which is worth a warning. */
  readonly missingTarget: boolean
}

type DocumentWriteArgs = Record<string, unknown>

/** Where the write lands: a hosted document names itself, the root of its own LoroDoc does not. */
function writeOf(reads: PlanReads, op: documentEngine.WriterName, args: DocumentWriteArgs): Write {
  return {
    op,
    args: reads.documentId === undefined ? args : { ...args, documentId: reads.documentId },
  }
}

/**
 * The leaf kinds a batch can write fine-grained: exactly the operations the
 * batch writer exposes. `delete-edge` is deliberately included here even
 * though the non-batch path has no case for it (multi-delete needs it); the
 * other kinds send the whole batch to the whole-canvas reconcile.
 */
function batchStep(next: SpatialCanvas, command: EditorLeafCommand): DocumentWriteArgs | Refusal {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text':
    case 'create-node': {
      const id = command.kind === 'create-node' ? command.node.id : command.id
      const node = next.nodes.find((n) => n.id === id)
      return node ? { op: 'writeNode', node } : 'target-missing'
    }
    case 'connect-nodes':
    case 'create-edge': {
      const id = command.kind === 'create-edge' ? command.edge.id : command.edgeId
      const edge = next.edges.find((e) => e.id === id)
      return edge ? { op: 'writeEdge', edge } : 'target-missing'
    }
    // Deletes are no-ops for absent ids: always writable.
    case 'delete-node':
      return { op: 'deleteNode', id: command.id }
    case 'delete-edge':
      return { op: 'deleteEdge', id: command.id }
    default:
      return 'unmapped'
  }
}

/** Pre-validated before any write: a batch is all-or-nothing at this layer, one commit and one undo step. */
function planBatch(
  reads: PlanReads,
  next: SpatialCanvas,
  commands: readonly EditorLeafCommand[],
): Planned {
  const steps = commands.map((command) => batchStep(next, command))
  for (const step of steps) if (typeof step === 'string') return step
  return [writeOf(reads, 'withSpatialBatch', { steps })]
}

/**
 * Every plane in ONE commit, because a decision is one act: the changes are
 * stamped where the proposal lives, and an ADOPTED one also rewrites the
 * board and the body. A commit each would be independent deltas for one
 * press, and a transport dying between them would leave a half-made decision.
 * The canvas write is a whole-canvas reconcile deliberately: a proposal
 * reaches whatever it names, so there is no single target to write.
 */
function planDecision(
  reads: PlanReads,
  command: Extract<EditorCommand, { kind: 'decide-proposal' }>,
  prev: SpatialCanvas,
  next: SpatialCanvas,
): Write[] {
  const steps: DocumentWriteArgs[] = []
  if (command.decision === 'adopted') {
    // The OTHER subject a proposal can have: `applyCommand` folds the canvas
    // and cannot reach a body, so a passage adopted only there would close
    // its change against a document that never changed. It runs FIRST because
    // a body past the size limit refuses the whole decision: nothing is
    // written and the change stays open.
    const refused = applyAdoptedPassages(reads.body(), command.changes, (body) =>
      steps.push({ op: 'writeMarkdownBody', body }),
    )
    if (refused !== undefined) return []
    steps.push({ op: 'reconcileSpatialCanvas', prev, next })
  }
  for (const change of command.changes) {
    steps.push({
      op: 'setProposedChangeStatus',
      proposalId: command.proposalId,
      changeId: change.id,
      status: command.decision,
    })
  }
  return [writeOf(reads, 'withDocumentBatch', { steps })]
}

/**
 * The threads plane. Every arm is "handled" and never falls back: the
 * fallback writes the whole SpatialCanvas, and a conversation lives BESIDE it
 * (a markdown document's canvas holds nothing one could ride in on). There is
 * no missing-target case either: replying to, moving or closing a thread this
 * replica does not hold is a documented no-op, because only `create-thread`
 * may open a thread container.
 */
function planConversation(reads: PlanReads, command: EditorCommand): Write[] | undefined {
  switch (command.kind) {
    case 'move-thread': {
      const { x, y, nodeId, edgeId } = command
      const drop = {
        x,
        y,
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(edgeId === undefined ? {} : { edgeId }),
      }
      return [writeOf(reads, 'moveCommentThread', { threadId: command.threadId, drop })]
    }
    case 'reply-to-thread':
    case 'edit-thread-message':
      // `writeThreadMessage` upserts by message id, so an edit is the same
      // write a reply is, aimed at a message the thread already holds.
      return [
        writeOf(reads, 'writeThreadMessage', {
          threadId: command.threadId,
          message: command.message,
        }),
      ]
    case 'set-thread-status':
      return [
        writeOf(reads, 'setCommentThreadStatus', {
          threadId: command.threadId,
          status: command.status,
        }),
      ]
    case 'create-thread': {
      const writes = [writeOf(reads, 'writeCommentThread', { thread: command.thread })]
      const { anchor, id } = command.thread
      // And where the passage IS, so the CRDT carries it from here on. The
      // thread's quote is what survives the document leaving the CRDT; a mark
      // follows an edit, a concurrent one merged from another peer included,
      // which the quote and its offsets can only approximate. Both, because
      // neither replaces the other.
      if (anchor.kind === 'text') {
        const passages = [[id, { start: anchor.start, end: anchor.end }]]
        writes.push(writeOf(reads, 'markThreadPassages', { passages }))
      }
      return writes
    }
    default:
      return undefined
  }
}

/** Targets outside the canvas the fallback rewrites: the body, the core facets, a decision. */
function planDocument(
  reads: PlanReads,
  command: EditorCommand,
  prev: SpatialCanvas,
  next: SpatialCanvas,
): Write[] | undefined {
  switch (command.kind) {
    case 'set-body':
      // Must be "handled": the fallback would leave the body untouched and
      // silently drop the edit.
      return [writeOf(reads, 'writeMarkdownBody', { body: command.text })]
    case 'set-facets': {
      // Same must-handle reasoning (`core` is outside the canvas); a core
      // field this build cannot read survives the reconcile.
      const held: StoredCoreFacets | undefined = reads.coreFacets()
      const args =
        held === undefined ? { next: command.facets } : { prev: held, next: command.facets }
      return [writeOf(reads, 'reconcileCoreFacets', args)]
    }
    case 'decide-proposal':
      return planDecision(reads, command, prev, next)
    default:
      return undefined
  }
}

/**
 * The node or edge the command targets, written into its own map entry (the
 * same field projection the whole-canvas write uses). That preserves the
 * node-level merge granularity a whole-document rewrite would discard: a
 * concurrent peer edit to a different node survives a merge against it.
 */
function planElement(reads: PlanReads, next: SpatialCanvas, command: EditorCommand): Planned {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text':
    case 'create-node': {
      const id = command.kind === 'create-node' ? command.node.id : command.id
      const node = next.nodes.find((n) => n.id === id)
      return node ? [writeOf(reads, 'writeSpatialNode', { node })] : 'target-missing'
    }
    case 'connect-nodes': {
      const edge = next.edges.find((e) => e.id === command.edgeId)
      return edge ? [writeOf(reads, 'writeSpatialEdge', { edge })] : 'target-missing'
    }
    // Always "handled": deleting an absent id is a no-op, so there is no
    // missing-target case to fall back from.
    case 'delete-node':
      return [writeOf(reads, 'deleteSpatialNode', { id: command.id })]
    case 'batch':
      return planBatch(reads, next, command.commands)
    default:
      return 'unmapped'
  }
}

function reconcileWrites(reads: PlanReads, prev: SpatialCanvas, next: SpatialCanvas): Write[] {
  return [writeOf(reads, 'reconcileSpatialCanvas', { prev, next })]
}

/**
 * Primary: a fine-grained write of just the command's target. Fallback: a
 * whole-canvas `reconcileSpatialCanvas(prev, next)`, for a target `next` does
 * not hold or a kind with no fine-grained write. The reconcile deletes only
 * what `prev` held and `next` dropped, so it also recovers from a node/edge
 * removed from `next` without a corresponding command.
 *
 * `prev` is the canvas the editor held when the edit began. It is never
 * re-read from the document: `next` comes from `readSpatialCanvas`, which
 * omits any record this build's schema cannot read, and a write that deleted
 * every stored id absent from `next` would erase a newer client's records as
 * an op that ships to every replica.
 */
function planCommand(
  reads: PlanReads,
  prev: SpatialCanvas,
  next: SpatialCanvas,
  command: EditorCommand,
): CommandPlan {
  const planned =
    planConversation(reads, command) ??
    planDocument(reads, command, prev, next) ??
    planElement(reads, next, command)
  const reconcile = reconcileWrites(reads, prev, next)
  if (typeof planned === 'string') {
    return { writes: reconcile, fallback: undefined, missingTarget: planned === 'target-missing' }
  }
  return { writes: planned, fallback: reconcile, missingTarget: false }
}

/** Applies a plan; a throwing fine-grained write is retried as the whole-canvas reconcile. */
function commitPlan(apply: WriteTarget['apply'], plan: CommandPlan, command: EditorCommand): void {
  if (plan.missingTarget) {
    log.warn('editor command target missing from next canvas; reconciling the whole canvas', {
      command,
    })
  }
  try {
    apply(plan.writes)
    return
  } catch (err) {
    if (plan.fallback === undefined) throw err
    log.warn('fine-grained write failed; reconciling the whole canvas', err)
  }
  apply(plan.fallback)
}

/** Plans one command against `target` and applies it, one commit for the target. */
export function commitToDoc(
  target: WriteTarget,
  prev: SpatialCanvas,
  next: SpatialCanvas,
  command: EditorCommand,
): void {
  let plan: CommandPlan
  try {
    plan = planCommand(target, prev, next, command)
  } catch (err) {
    log.warn('planning a command failed; reconciling the whole canvas', err)
    target.apply(reconcileWrites(target, prev, next))
    return
  }
  commitPlan((writes) => target.apply(writes), plan, command)
}
