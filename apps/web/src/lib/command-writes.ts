// How one editor command reaches the Loro document: the fine-grained write
// for the target it names, the whole-canvas reconcile it falls back to, and the
// key a debounce window dedupes repeat edits to one target under. Pure over
// the containers it is handed; the session owns the debounce, the undo
// manager and everything that outlives one write.
import {
  type DocumentContainers,
  deleteSpatialNode,
  markThreadPassages,
  readCoreFacets,
  reconcileCoreFacets,
  reconcileSpatialCanvas,
  type SpatialBatchWriter,
  setCommentThreadStatus,
  withDocumentBatch,
  withSpatialBatch,
  writeCanvasComment,
  writeCommentThread,
  writeMarkdownBody,
  writeSpatialEdge,
  writeSpatialNode,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { applyAdoptedPassages } from './apply-adopted-passages.js'
import type { EditorCommand, EditorLeafCommand } from './spatial/commands.js'

const log = getAppLogger('document-sync')

/**
 * Stable key identifying the single node/edge a command targets, so a
 * debounce window can dedupe repeat edits to the SAME target down to one
 * write while still keeping edits to DIFFERENT targets separate. Commands
 * with no mapped target (see `writeCommandTarget`'s `default` case) get a
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
    case 'create-comment':
      return `comment:${command.comment.id}`
    case 'set-comment-resolved':
    case 'move-comment':
      return `comment:${command.id}`
    case 'reply-to-thread':
      // Keyed by MESSAGE, not by thread. Every other key here dedupes to the
      // last value for one target, which is right when the target holds one
      // value — a node's position, a comment's text. A reply APPENDS: two
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
 * Writes exactly the node/edge the command targets into its own LoroMap
 * entry (via crdt's `writeSpatialNode`/`writeSpatialEdge`, the
 * same field projection the whole-canvas write uses), and returns whether it
 * could — false when the command's target id is missing from `next` (see
 * commitToDoc's fallback rule). This is what preserves the node-level CRDT
 * merge granularity a whole-document rewrite would discard: a concurrent
 * peer edit to a different node survives a merge against this write.
 */
function writeCommandTarget(
  host: LoroDoc,
  doc: DocumentContainers,
  prev: SpatialCanvas,
  next: SpatialCanvas,
  command: EditorCommand,
): boolean {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text': {
      const node = next.nodes.find((n) => n.id === command.id)
      if (!node) return false
      writeSpatialNode(doc, node)
      return true
    }
    case 'connect-nodes': {
      const edge = next.edges.find((e) => e.id === command.edgeId)
      if (!edge) return false
      writeSpatialEdge(doc, edge)
      return true
    }
    case 'create-node': {
      const node = next.nodes.find((n) => n.id === command.node.id)
      if (!node) return false
      writeSpatialNode(doc, node)
      return true
    }
    case 'create-comment':
    case 'set-comment-resolved':
    case 'move-comment': {
      const id = command.kind === 'create-comment' ? command.comment.id : command.id
      const comment = next.comments?.find((c) => c.id === id)
      if (!comment) return false
      writeCanvasComment(doc, comment)
      return true
    }
    case 'reply-to-thread':
      // Always "handled", like set-body below and for the same reason: the
      // fallback writes the whole SpatialCanvas, and a conversation lives in
      // the threads plane BESIDE it — a whole-canvas reconcile would rewrite the canvas
      // and never touch the message. There is no missing-target case to fall
      // back from either: writeThreadMessage is a documented no-op for a
      // thread this replica does not hold, which is deliberate (replying must
      // never be the write that opens a container).
      writeThreadMessage(doc, command.threadId, command.message)
      return true
    case 'set-thread-status':
      // Same plane, same reason: a status lives on the thread, and the
      // fallback's whole-canvas write would never reach a note's thread.
      setCommentThreadStatus(doc, command.threadId, command.status)
      return true
    case 'edit-thread-message':
      // `writeThreadMessage` upserts by message id, so an edit is the same
      // write a reply is, aimed at a message the thread already holds.
      writeThreadMessage(doc, command.threadId, command.message)
      return true
    case 'decide-proposal': {
      // Every plane in ONE commit, because a decision is one act: the
      // changes are stamped where the proposal lives, and an ADOPTED one
      // also rewrites the board and the body. A commit each would be four
      // independent deltas for one press — see `withDocumentBatch` for the
      // measurement and for what a transport dying between them left behind.
      // The canvas write is a whole-canvas reconcile deliberately: a proposal
      // reaches whatever it names, so there is no single target to write.
      withDocumentBatch(doc, (writer) => {
        for (const change of command.changes) {
          writer.setProposedChangeStatus(command.proposalId, change.id, command.decision)
        }
        if (command.decision !== 'adopted') return
        writer.reconcileSpatialCanvas(prev, next)
        // And the OTHER subject a proposal can have (ADR-0029 decision 6).
        // `applyCommand` folds the canvas and cannot reach a body, so a
        // passage adopted here would otherwise close its change against a
        // document that never changed — the worst of the three states,
        // since the person is looking at an "adopted" verdict and their own
        // words still on the page.
        applyAdoptedPassages(doc, command.changes, (body) => writer.writeMarkdownBody(body))
      })
      return true
    }
    case 'create-thread':
      // Always "handled", for `reply-to-thread`'s reason: the fallback writes
      // the whole SpatialCanvas, and a markdown document's canvas holds
      // nothing a new conversation could ride in on. This is the one write
      // allowed to OPEN a thread container (see `writeCommentThread`), which
      // is exactly why replying is not.
      writeCommentThread(doc, command.thread)
      // And where the passage IS, so the CRDT carries it from here on. The
      // thread's quote is what survives the document leaving the CRDT; a
      // mark is what follows an edit — including a concurrent one merged
      // from another peer, which the quote and its offsets can only
      // approximate. Both, because neither replaces the other.
      if (command.thread.anchor.kind === 'text') {
        markThreadPassages(
          host,
          doc,
          new Map([
            [
              command.thread.id,
              { start: command.thread.anchor.start, end: command.thread.anchor.end },
            ],
          ]),
        )
      }
      return true
    case 'set-body':
      // Always "handled", and it MUST be: the fallback below writes the
      // whole SpatialCanvas, which would leave the body container untouched
      // and silently drop the edit.
      writeMarkdownBody(doc, command.text)
      return true
    case 'set-facets':
      // Same must-handle reasoning as set-body (`core` is outside the canvas
      // the fallback rewrites); a core field this build cannot read survives.
      reconcileCoreFacets(doc, readCoreFacets(doc), command.facets)
      return true
    case 'delete-node':
      // Always "handled": deleteSpatialNode is a documented no-op for an
      // already-absent id, so there is no missing-target case to fall back
      // from here (unlike the other kinds, which need the target to still
      // exist in `next` to know what to write).
      deleteSpatialNode(doc, command.id)
      return true
    case 'batch': {
      // Pre-validate BEFORE any write: a batch is all-or-nothing at this
      // layer. One unsupported member (or a missing target) sends the WHOLE
      // batch down the whole-canvas fallback — still exactly one commit and
      // one undo step, just with whole-canvas granularity.
      if (!command.commands.every((sub) => isBatchWritable(sub, next))) return false
      withSpatialBatch(doc, (writer) => {
        for (const sub of command.commands) writeSubCommand(writer, next, sub)
      })
      return true
    }
    default:
      return false
  }
}

/**
 * The leaf kinds a batch can write fine-grained: exactly the operations
 * `SpatialBatchWriter` exposes. `delete-edge` is deliberately included here
 * even though the non-batch path has no case for it (multi-delete needs
 * it); the other kinds fall back to the whole-canvas reconcile as a whole batch.
 */
function isBatchWritable(command: EditorLeafCommand, next: SpatialCanvas): boolean {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text':
      return next.nodes.some((n) => n.id === command.id)
    case 'create-node':
      return next.nodes.some((n) => n.id === command.node.id)
    case 'connect-nodes':
      return next.edges.some((e) => e.id === command.edgeId)
    case 'create-edge':
      return next.edges.some((e) => e.id === command.edge.id)
    case 'create-comment':
      return next.comments?.some((c) => c.id === command.comment.id) ?? false
    case 'set-comment-resolved':
    case 'move-comment':
      return next.comments?.some((c) => c.id === command.id) ?? false
    case 'delete-node':
    case 'delete-edge':
      // Deletes are no-ops for absent ids — always writable.
      return true
    default:
      return false
  }
}

function writeSubCommand(
  writer: SpatialBatchWriter,
  next: SpatialCanvas,
  command: EditorLeafCommand,
): void {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text': {
      const node = next.nodes.find((n) => n.id === command.id)
      if (node) writer.writeNode(node)
      return
    }
    case 'create-node': {
      const node = next.nodes.find((n) => n.id === command.node.id)
      if (node) writer.writeNode(node)
      return
    }
    case 'connect-nodes': {
      const edge = next.edges.find((e) => e.id === command.edgeId)
      if (edge) writer.writeEdge(edge)
      return
    }
    case 'create-edge': {
      const edge = next.edges.find((e) => e.id === command.edge.id)
      if (edge) writer.writeEdge(edge)
      return
    }
    case 'create-comment':
    case 'set-comment-resolved':
    case 'move-comment': {
      const id = command.kind === 'create-comment' ? command.comment.id : command.id
      const comment = next.comments?.find((c) => c.id === id)
      if (comment) writer.writeComment(comment)
      return
    }
    case 'delete-node':
      writer.deleteNode(command.id)
      return
    case 'delete-edge':
      writer.deleteEdge(command.id)
      return
    default:
      // Unreachable behind isBatchWritable; a miss here writes nothing and
      // the batch still commits what the other members wrote.
      return
  }
}

/**
 * Primary path: a fine-grained write of just the command's target node/edge.
 * Fallback: a whole-canvas `reconcileSpatialCanvas(doc, prev, next)`, used
 * when the command's target id is not present in `next` (an unmapped/unknown
 * command kind, or a target the command set has no delete for), or when the
 * fine-grained write itself throws. The reconcile deletes only what `prev`
 * held and `next` dropped, so it also recovers from a node/edge removed from
 * `next` without a corresponding command.
 *
 * `prev` is the canvas the editor held when the edit began. It is never
 * re-read from `doc`: `next` comes from `readSpatialCanvas`, which omits any
 * record this build's schema cannot read, and a write that deleted every
 * stored id absent from `next` would erase a newer client's records as an op
 * that ships to every replica.
 */
export function commitToDoc(
  host: LoroDoc,
  doc: DocumentContainers,
  prev: SpatialCanvas,
  next: SpatialCanvas,
  command: EditorCommand,
): void {
  try {
    if (writeCommandTarget(host, doc, prev, next, command)) return
    log.warn('editor command target missing from next canvas; reconciling the whole canvas', {
      command,
    })
  } catch (err) {
    log.warn('fine-grained Loro write failed; reconciling the whole canvas', err)
  }
  reconcileSpatialCanvas(doc, prev, next)
}
