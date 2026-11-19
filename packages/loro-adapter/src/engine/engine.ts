/**
 * The CRDT document engine over npm loro-crdt: the TypeScript implementation
 * of `contracts/crdt/document-engine.schema.json`, which the Rust engine
 * implements too. `test-utils/crdt-engine-conformance` is the suite both pass.
 *
 * A handle holds one LoroDoc, the peer it writes as, and the UndoManager over
 * it. A call that changes the document is one commit; its answer carries the
 * update it produced (exported from the version before the call), the
 * documents that update touched, and the sync limit judgement of that update —
 * so a host forwards `localUpdate` to its keeper knowing a peer will take it.
 *
 * Refusal restores the document: a writer that throws, or an update the sync
 * judge refuses, leaves the document at the version before the call. Loro has
 * no rollback, so the document is rebuilt from its own history at that version
 * and the undo history of the handle starts over.
 */
import { base64ToBytes, bytesToBase64, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { type Frontiers, LoroDoc, UndoManager, type VersionVector } from 'loro-crdt'
import {
  importWithinTextLimits,
  type SyncTextBreach,
  syncTextLimitJudge,
} from '../sync-text-limits.js'
import { documentsTouchedSince } from '../touched-documents.js'
import { documentContainers, WORKSPACE_TREE_KEY } from '../workspace-tree.js'
import { versionOfPairs } from './answers.js'
import { readQuery } from './readers.js'
import type { CrdtEngine } from './types.js'
import { applyWriter } from './writers.js'

/**
 * Consecutive local edits within this many milliseconds are one undo step,
 * which is how the editor undoes typing. A host that wants every commit to be a
 * step passes zero.
 */
const DEFAULT_UNDO_MERGE_MS = 500

export interface CrdtEngineOptions {
  readonly undoMergeIntervalMs?: number
}

interface Held {
  doc: LoroDoc
  readonly peer: bigint
  readonly mergeInterval: number
  undo: UndoManager
  judge: ReturnType<typeof syncTextLimitJudge> | null
}

const PEER_ID = /^\d{1,20}$/
const U64_MAX = 2n ** 64n - 1n

function peerOf(text: string): bigint {
  const peer = PEER_ID.test(text) ? BigInt(text) : -1n
  if (peer < 0n || peer > U64_MAX) throw new RangeError(`${text} is not a peer id`)
  return peer
}

function decoded(text: string): Uint8Array {
  const bytes = base64ToBytes(text)
  if (bytes === null) throw new TypeError('bytes are base64')
  return bytes
}

function breachOf(breach: SyncTextBreach): wire.Breach {
  return { shape: breach.shape, container: breach.container }
}

/** The workspace documents the operations after `before` wrote to; none for a document that is its own root. */
function touchedSince(doc: LoroDoc, before: VersionVector): string[] {
  return WORKSPACE_TREE_KEY in doc.getShallowValue()
    ? documentsTouchedSince(doc, before).map(({ documentId }) => documentId)
    : []
}

/** Rebuilds `entry` as it was at `frontiers`; its undo history starts over. */
function restore(entry: Held, frontiers: Frontiers) {
  const doc = entry.doc.forkAt(frontiers)
  doc.setPeerId(entry.peer)
  entry.doc = doc
  entry.undo = new UndoManager(doc, { mergeInterval: entry.mergeInterval })
  entry.judge = null
}

/** One commit: `apply`, then the update it produced judged as a peer would judge it. */
function mutate(entry: Held, apply: (doc: LoroDoc) => void): wire.MutationResult {
  const { doc } = entry
  const before = doc.oplogVersion()
  const frontiers = doc.frontiers()
  const judged = doc.fork()
  try {
    apply(doc)
    doc.commit()
  } catch (error) {
    restore(entry, frontiers)
    throw error
  }
  if (doc.oplogVersion().compare(before) === 0) return { outcome: 'applied', changed: [] }
  const update = doc.export({ mode: 'update', from: before })
  // ponytail: the judgement imports the update into a copy of the document
  // from before the write, so every write costs a fork of it; a long-lived
  // copy brought up by each write, as `syncTextLimitJudge` keeps for
  // imports, is the upgrade if that is measured to matter. A fork is taken
  // up front because rebuilding the version from history (`forkAt`) replays
  // every operation — 2 s for a document holding one 256 Ki insert.
  let breach: SyncTextBreach | null
  try {
    breach = importWithinTextLimits(judged, update).breach
  } catch (error) {
    restore(entry, frontiers)
    throw error
  }
  if (breach !== null) {
    restore(entry, frontiers)
    return { outcome: 'refused', breach: breachOf(breach) }
  }
  return {
    outcome: 'applied',
    changed: touchedSince(doc, before),
    localUpdate: bytesToBase64(update),
  }
}

function importInto(entry: Held, bytes: string): wire.MutationResult {
  entry.judge ??= syncTextLimitJudge(entry.doc)
  const incoming = decoded(bytes)
  const breach = entry.judge(incoming)
  if (breach !== null) return { outcome: 'refused', breach: breachOf(breach) }
  const before = entry.doc.oplogVersion()
  entry.doc.import(incoming)
  return { outcome: 'applied', changed: touchedSince(entry.doc, before) }
}

function exportFrom(doc: LoroDoc, request: wire.ExportRequest): wire.ExportResponse {
  if (request.mode === 'snapshot') return { bytes: bytesToBase64(doc.export({ mode: 'snapshot' })) }
  if (request.mode === 'update') {
    const since =
      request.from === undefined
        ? undefined
        : versionOfPairs(request.from.map(({ peer, counter }) => [peer, counter]))
    return { bytes: bytesToBase64(doc.export({ mode: 'update', from: since })) }
  }
  const kept = request.frontiers.map(({ peer, counter }) => ({
    peer: peer as `${number}`,
    counter,
  }))
  return { bytes: bytesToBase64(doc.export({ mode: 'shallow-snapshot', frontiers: kept })) }
}

function spliceText(doc: LoroDoc, request: wire.TextSpliceRequest) {
  const { documentId, text, index, remove, insert } = request
  const host = documentId === undefined ? doc : documentContainers(doc, documentId)
  // Loro's text takes UTF-16 code unit offsets from JavaScript, which is the
  // unit this contract counts in.
  host.getText(text).splice(index, remove, insert)
}

function applyBatch(doc: LoroDoc, batch: wire.WriteRequest['batch']) {
  for (const { op, args } of batch) applyWriter(doc, op, args)
}

function openDocument(request: wire.OpenRequest, mergeInterval: number): Held {
  const { peer, bytes } = wire.openRequestSchema.parse(request)
  const id = peerOf(peer)
  const doc = new LoroDoc()
  doc.setPeerId(id)
  if (bytes !== undefined) doc.import(decoded(bytes))
  const undo = new UndoManager(doc, { mergeInterval })
  return { doc, peer: id, mergeInterval, undo, judge: null }
}

function heldIn(handles: Map<number, Held>, handle: number): Held {
  const found = handles.get(handle)
  if (found === undefined)
    throw new RangeError(`handle ${handle} is not open: it was never opened or has been closed`)
  return found
}

export function createCrdtEngine(options: CrdtEngineOptions = {}): CrdtEngine {
  const mergeInterval = options.undoMergeIntervalMs ?? DEFAULT_UNDO_MERGE_MS
  const handles = new Map<number, Held>()
  let opened = 0
  const heldBy = (handle: number) => heldIn(handles, handle)

  return {
    open(request) {
      handles.set(opened, openDocument(request, mergeInterval))
      opened += 1
      return { handle: opened - 1 }
    },
    close(request) {
      const { handle } = wire.closeRequestSchema.parse(request)
      if (heldBy(handle) !== undefined) handles.delete(handle)
    },
    import(request) {
      const { handle, bytes } = wire.importRequestSchema.parse(request)
      return importInto(heldBy(handle), bytes)
    },
    export(request) {
      const parsed = wire.exportRequestSchema.parse(request)
      return exportFrom(heldBy(parsed.handle).doc, parsed)
    },
    write(request) {
      const { handle, batch } = wire.writeRequestSchema.parse(request)
      return mutate(heldBy(handle), (doc) => applyBatch(doc, batch))
    },
    async read(request) {
      const { handle, query } = wire.readRequestSchema.parse(request)
      return { value: await readQuery(heldBy(handle).doc, query) }
    },
    undo(request) {
      const entry = heldBy(wire.undoRequestSchema.parse(request).handle)
      return mutate(entry, () => {
        entry.undo.undo()
      })
    },
    redo(request) {
      const entry = heldBy(wire.redoRequestSchema.parse(request).handle)
      return mutate(entry, () => {
        entry.undo.redo()
      })
    },
    textSplice(request) {
      const parsed = wire.textSpliceRequestSchema.parse(request)
      return mutate(heldBy(parsed.handle), (doc) => spliceText(doc, parsed))
    },
  }
}
