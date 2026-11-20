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
 * no rollback, so the document is rebuilt from the engine's own record of it —
 * a snapshot and the updates applied since — and the undo history of the handle
 * starts over. Rebuilding from history (`forkAt`) replays every operation,
 * which costs seconds for a document holding one long insert; loading a
 * snapshot does not.
 */
import { base64ToBytes, bytesToBase64, documentEngine as wire } from '@kamiazya/whiteboard-model'
import {
  decodeFrontiers,
  decodeImportBlobMeta,
  encodeFrontiers,
  LoroDoc,
  UndoManager,
  VersionVector,
} from 'loro-crdt'
import {
  importWithinTextLimits,
  type SyncTextBreach,
  syncTextLimitJudge,
} from '../sync-text-limits.js'
import { documentsTouchedSince } from '../touched-documents.js'
import { judgeWorkspaceSyncImport, type WorkspaceSyncBreach } from '../workspace-sync-limits.js'
import {
  exportWorkspaceSubtree,
  importWorkspaceSubtree,
  projectWorkspaceDocument,
  WORKSPACE_TREE_KEY,
} from '../workspace-tree.js'
import { frontierPairs, versionOfPairs, versionPairs } from './answers.js'
import { readQuery, readQueryNow } from './readers.js'
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

/**
 * Updates kept since the snapshot a refusal restores from. Once they outweigh
 * the snapshot (or this floor, for a small one) they are folded into a new
 * snapshot, so the cost of keeping them is amortised over the writes.
 */
const MIN_LOG_BYTES = 64 * 1024

interface Held {
  doc: LoroDoc
  readonly peer: bigint
  readonly mergeInterval: number
  undo: UndoManager
  judge: ReturnType<typeof syncTextLimitJudge> | null
  /** A view at a frontier: it can be read and nothing else. */
  readonly view: boolean
  /** A copy at the version before the write in flight, which judges that write's update. */
  shadow: LoroDoc | null
  /** What the document was made from; absent when it began empty. */
  base: Uint8Array | null
  /** Updates applied together after `base` when the document was opened: a restore re-applies them and the log never held them. */
  baseUpdates: Uint8Array[]
  /** Every update applied after `base`, in order. */
  log: Uint8Array[]
  logBytes: number
  /**
   * Imported updates that built on operations the document lacked, so the
   * document holds them parked. A snapshot leaves a parked update out, so
   * compaction keeps the ones still parked in `log` rather than lose them.
   */
  parked: Uint8Array[]
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

/**
 * The judge's own object rides as `detail`, made JSON as the wire carries it
 * (a field a judge leaves undefined is not there), so a keeper rebuilds its
 * refusal from an engine's answer exactly as from the judge.
 */
function breachOf(breach: SyncTextBreach | WorkspaceSyncBreach): wire.Breach {
  const detail: unknown = JSON.parse(JSON.stringify(breach))
  return 'container' in breach
    ? { shape: breach.shape, container: breach.container, detail }
    : { shape: breach.shape, detail }
}

/** The workspace documents the operations after `before` wrote to; none for a document that is its own root. */
function touchedSince(doc: LoroDoc, before: VersionVector): string[] {
  return WORKSPACE_TREE_KEY in doc.getShallowValue()
    ? documentsTouchedSince(doc, before).map(({ documentId }) => documentId)
    : []
}

/**
 * The document and its undo history hold wasm memory the garbage collector does
 * not see, so each copy the engine lets go of is freed. The undo manager reads
 * the document, so it goes first.
 */
function release(...held: Array<{ free(): void } | null>) {
  for (const resource of held) resource?.free()
}

/** Rebuilds `entry` from what it was made from and the updates applied since; its undo history starts over. */
function restore(entry: Held) {
  const doc = new LoroDoc()
  doc.setPeerId(entry.peer)
  const opened = [...(entry.base === null ? [] : [entry.base]), ...entry.baseUpdates]
  if (opened.length > 0) doc.importBatch(opened)
  for (const update of entry.log) doc.import(update)
  release(entry.undo, entry.doc)
  entry.doc = doc
  entry.undo = new UndoManager(doc, { mergeInterval: entry.mergeInterval })
  entry.judge = null
}

/** The shadow is single-use once a judgement leaves operations in it, and freed when it is let go. */
function dropShadow(entry: Held) {
  release(entry.shadow)
  entry.shadow = null
}

/** Keeps `update`, which `entry.doc` now holds, so a later refusal can rebuild the document. */
function keep(entry: Held, update: Uint8Array) {
  entry.log.push(update)
  entry.logBytes += update.byteLength
  // Parked updates stay in the log whatever happens, so they do not count toward
  // the compaction threshold: a large parked update would otherwise compact on every write.
  const parkedBytes = entry.parked.reduce((total, held) => total + held.byteLength, 0)
  if (entry.logBytes - parkedBytes <= Math.max(entry.base?.byteLength ?? 0, MIN_LOG_BYTES)) return
  compact(entry)
}

/** Folds the log into a new snapshot of the document, keeping the updates it still lacks. */
function compact(entry: Held) {
  entry.base = entry.doc.export({ mode: 'snapshot' })
  entry.baseUpdates = []
  entry.parked = stillParkedAfter(entry.base, entry.parked)
  entry.log = [...entry.parked]
  entry.logBytes = entry.parked.reduce((total, update) => total + update.byteLength, 0)
}

/** The parked updates `base` does not hold: each is checked alone, since a parked update never applies. */
function stillParkedAfter(base: Uint8Array, parked: readonly Uint8Array[]): Uint8Array[] {
  if (parked.length === 0) return []
  const probe = new LoroDoc()
  probe.import(base)
  return parked.filter((update) => (probe.import(update).pending?.size ?? 0) > 0)
}

function editable(entry: Held): void {
  if (entry.view) throw new RangeError('this handle is a view at a version and takes no edit')
}

/** The copy the update of a write is judged on, at the version the document holds now. */
function shadowAtHead(entry: Held): LoroDoc {
  const { doc } = entry
  if (entry.shadow === null) {
    entry.shadow = doc.fork()
  } else if (entry.shadow.oplogVersion().compare(doc.oplogVersion()) !== 0) {
    entry.shadow.import(doc.export({ mode: 'update', from: entry.shadow.oplogVersion() }))
  }
  return entry.shadow
}

/**
 * One commit: `apply`, then the update it produced judged as a peer would judge
 * it. With `judge: 'none'` the update is not judged and no copy is kept for it:
 * the host's keeper judges what it is pushed, so a second copy of the document
 * would be cost for nothing.
 */
function mutate(
  entry: Held,
  apply: (doc: LoroDoc) => void,
  judge: wire.WriteJudge = 'text',
): wire.MutationResult {
  editable(entry)
  const { doc } = entry
  const before = doc.oplogVersion()
  const shadow = judge === 'text' ? shadowAtHead(entry) : null
  try {
    apply(doc)
    doc.commit()
  } catch (error) {
    restore(entry)
    throw error
  }
  if (doc.oplogVersion().compare(before) === 0) return { outcome: 'applied', changed: [] }
  const update = doc.export({ mode: 'update', from: before })
  // ponytail: the judgement imports the update into a copy kept at the version
  // before the write, so a write costs the update and not the document. The
  // copy is single-use on a refusal (the judge leaves operations in it), and
  // the next write forks a new one; a second copy kept clean is the upgrade if
  // refusals are measured to matter.
  let breach: SyncTextBreach | null = null
  try {
    if (shadow !== null) breach = importWithinTextLimits(shadow, update).breach
  } catch (error) {
    dropShadow(entry)
    restore(entry)
    throw error
  }
  if (breach !== null) {
    dropShadow(entry)
    restore(entry)
    return { outcome: 'refused', breach: breachOf(breach) }
  }
  keep(entry, update)
  return {
    outcome: 'applied',
    changed: touchedSince(doc, before),
    localUpdate: bytesToBase64(update),
  }
}

/**
 * What a workspace sync would refuse of `update`, judged on the copy kept at
 * the document's version. The judge leaves the update in the copy it
 * judges, and the copy is no longer one of the document's versions once it
 * refuses, so it is dropped then.
 */
function judgeOnShadow(
  entry: Held,
  update: Uint8Array,
): SyncTextBreach | WorkspaceSyncBreach | null {
  const shadow = shadowAtHead(entry)
  try {
    const breach = judgeWorkspaceSyncImport(shadow, update)
    if (breach !== null) dropShadow(entry)
    return breach
  } catch (error) {
    dropShadow(entry)
    throw error
  }
}

/**
 * What a judged import answers for when operations are parked: the update and
 * everything it activates. The judges read the operations an import adds to
 * the oplog, and parked ones are not in it until an update supplies what they
 * build on, so the judged copy is given the parked updates first and the import
 * that completes them adds them to what is read. Neither judge's shortcut for a
 * short update applies, since a short update may be what completes a long one.
 */
function judgeActivation(
  entry: Held,
  incoming: Uint8Array,
  judge: 'text' | 'workspace-sync',
): SyncTextBreach | WorkspaceSyncBreach | null {
  const copy = entry.doc.fork()
  try {
    for (const update of entry.parked) copy.import(update)
    return judge === 'text'
      ? importWithinTextLimits(copy, incoming).breach
      : judgeWorkspaceSyncImport(copy, incoming)
  } finally {
    release(copy)
  }
}

/** Whether `doc` holds every operation `update` carries. */
function holds(doc: LoroDoc, update: Uint8Array): boolean {
  const held = doc.oplogVersion()
  const { partialEndVersionVector: end } = decodeImportBlobMeta(update, false)
  return [...end.toJSON()].every(([peer, counter]) => (held.get(peer) ?? 0) >= counter)
}

function importInto(entry: Held, request: wire.ImportRequest): wire.MutationResult {
  editable(entry)
  const incoming = decoded(request.bytes)
  const judge = request.judge ?? 'text'
  if (judge !== 'none' && entry.parked.length > 0) {
    const breach = judgeActivation(entry, incoming, judge)
    if (breach !== null) return { outcome: 'refused', breach: breachOf(breach) }
  } else if (judge === 'text') {
    entry.judge ??= syncTextLimitJudge(entry.doc)
    const breach = entry.judge(incoming)
    if (breach !== null) return { outcome: 'refused', breach: breachOf(breach) }
  } else if (judge === 'workspace-sync') {
    const breach = judgeOnShadow(entry, incoming)
    if (breach !== null) return { outcome: 'refused', breach: breachOf(breach) }
  }
  const before = entry.doc.oplogVersion()
  const status = entry.doc.import(incoming)
  const pending = (status.pending?.size ?? 0) > 0
  // What this update completed is applied now, so it is no longer parked.
  entry.parked = entry.parked.filter((update) => !holds(entry.doc, update))
  if (pending) entry.parked.push(incoming)
  keep(entry, incoming)
  return { outcome: 'applied', changed: touchedSince(entry.doc, before), pending }
}

function exportFrom(doc: LoroDoc, request: wire.ExportRequest): wire.ExportResponse {
  if (request.mode === 'subtree') {
    const bytes = exportWorkspaceSubtree(doc, request.path)
    return bytes === null ? {} : { bytes: bytesToBase64(bytes) }
  }
  if (request.mode === 'projection') {
    const projected = projectWorkspaceDocument(doc, request.documentId)
    return projected === null
      ? {}
      : { bytes: bytesToBase64(projected.export({ mode: 'snapshot' })) }
  }
  if (request.mode === 'snapshot') return { bytes: bytesToBase64(doc.export({ mode: 'snapshot' })) }
  if (request.mode === 'update') {
    const since =
      request.from === undefined
        ? undefined
        : versionOfPairs(request.from.map(({ peer, counter }) => [peer, counter]))
    return { bytes: bytesToBase64(doc.export({ mode: 'update', from: since })) }
  }
  const cut =
    request.mode === 'shallow-snapshot-at-version'
      ? doc.vvToFrontiers(
          versionOfPairs(request.version.map(({ peer, counter }) => [peer, counter])),
        )
      : frontiersAt(request.frontiers)
  return { bytes: bytesToBase64(doc.export({ mode: 'shallow-snapshot', frontiers: cut })) }
}

function applyBatch(doc: LoroDoc, batch: wire.WriteRequest['batch']) {
  for (const { op, args } of batch) applyWriter(doc, op, args)
}

/**
 * A document holding `opened` and whether any of it stays parked.
 *
 * Applied one at a time, which Loro does in about a third of the time it takes
 * the same snapshot and tens of small updates as one batch. A parked update is
 * only known at the end of a batch (a later update can unpark an earlier one),
 * so a log that parks anything is applied again as a batch for that answer.
 */
function documentOf(
  peer: bigint,
  opened: readonly Uint8Array[],
): { doc: LoroDoc; pending: boolean } {
  const doc = new LoroDoc()
  doc.setPeerId(peer)
  let pending = false
  for (const bytes of opened) pending ||= (doc.import(bytes).pending?.size ?? 0) > 0
  if (!pending) return { doc, pending }
  release(doc)
  const batched = new LoroDoc()
  batched.setPeerId(peer)
  const status = batched.importBatch([...opened])
  return { doc: batched, pending: (status.pending?.size ?? 0) > 0 }
}

function openDocument(request: wire.OpenRequest, defaultMergeInterval: number): Held {
  const { peer, bytes, updates, undoMergeIntervalMs } = wire.openRequestSchema.parse(request)
  const id = peerOf(peer)
  const mergeInterval = undoMergeIntervalMs ?? defaultMergeInterval
  const base = bytes === undefined ? null : decoded(bytes)
  const baseUpdates = (updates ?? []).map(decoded)
  const opened = [...(base === null ? [] : [base]), ...baseUpdates]
  const { doc, pending } = documentOf(id, opened)
  // The updates a snapshot cannot hold stay parked, as an import's would.
  const parked = pending ? [...baseUpdates] : []
  const undo = new UndoManager(doc, { mergeInterval })
  return {
    doc,
    peer: id,
    mergeInterval,
    undo,
    judge: null,
    view: false,
    shadow: null,
    base,
    baseUpdates,
    log: [],
    logBytes: parked.reduce((total, update) => total + update.byteLength, 0),
    parked,
  }
}

function frontiersAt(at: wire.VersionEntry[]) {
  return at.map(({ peer, counter }) => ({ peer: peer as `${number}`, counter }))
}

/** Moves a view to `at`: a view is detached, so a checkout re-reads its state and never forks it. */
function moveView(entry: Held, at: wire.VersionEntry[]): void {
  if (!entry.view) throw new TypeError('only a view made by a fork at frontiers can be moved')
  entry.doc.checkout(frontiersAt(at))
}

/** A copy of `source` under `peer`: its head, or a read-only view at `at`. */
function forkOf(source: Held, request: wire.ForkRequest): Held {
  const { peer, at } = request
  const id = peerOf(peer)
  const base = source.doc.export({ mode: 'snapshot' })
  // A snapshot leaves the source's parked updates out, so they are carried
  // across: the fork then completes them when their dependency arrives, as the
  // source does, and its own rebuild after a refusal keeps them.
  const parked = stillParkedAfter(base, source.parked)
  const doc = new LoroDoc()
  doc.import(base)
  for (const update of parked) doc.import(update)
  doc.setPeerId(id)
  if (at !== undefined) {
    doc.checkout(frontiersAt(at))
  }
  return {
    doc,
    peer: id,
    mergeInterval: source.mergeInterval,
    undo: new UndoManager(doc, { mergeInterval: source.mergeInterval }),
    judge: null,
    view: at !== undefined,
    shadow: null,
    base,
    baseUpdates: [],
    log: [...parked],
    logBytes: parked.reduce((total, update) => total + update.byteLength, 0),
    parked,
  }
}

/**
 * What `doc` holds, or held at `at`: the operations that point had seen, with
 * the frontiers they reach. A point the document does not hold is refused,
 * since no operations can be named for it.
 */
function versionOf(doc: LoroDoc, at?: wire.VersionEntry[]): wire.VersionResponse {
  const entries = (pairs: Array<[string, number]>) =>
    pairs.map(([peer, counter]) => ({ peer, counter }))
  const shallowRoot = entries(frontierPairs(doc.shallowSinceFrontiers()))
  if (at === undefined) {
    return {
      version: entries(versionPairs(doc.oplogVersion())),
      frontiers: entries(frontierPairs(doc.oplogFrontiers())),
      encodedVersion: bytesToBase64(doc.oplogVersion().encode()),
      encodedFrontiers: bytesToBase64(encodeFrontiers(doc.oplogFrontiers())),
      shallowRoot,
    }
  }
  const seen = doc.frontiersToVV(frontiersAt(at))
  const reached = doc.vvToFrontiers(seen)
  return {
    version: entries(versionPairs(seen)),
    frontiers: entries(frontierPairs(reached)),
    encodedVersion: bytesToBase64(seen.encode()),
    encodedFrontiers: bytesToBase64(encodeFrontiers(reached)),
    shallowRoot,
  }
}

function decodeBytes(request: wire.DecodeRequest): wire.DecodeResponse {
  const bytes = decoded(request.bytes)
  const pairs =
    request.kind === 'version'
      ? versionPairs(VersionVector.decode(bytes))
      : frontierPairs(decodeFrontiers(bytes))
  return { entries: pairs.map(([peer, counter]) => ({ peer, counter })) }
}

function heldIn(handles: Map<number, Held>, handle: number): Held {
  const found = handles.get(handle)
  if (found === undefined)
    throw new RangeError(`handle ${handle} is not open: it was never opened or has been closed`)
  return found
}

/** The calls that read a document, or its undo history, and change no content. */
function inspections(heldBy: (handle: number) => Held) {
  return {
    export(request: wire.ExportRequest) {
      const parsed = wire.exportRequestSchema.parse(request)
      return exportFrom(heldBy(parsed.handle).doc, parsed)
    },
    async read(request: wire.ReadRequest) {
      const { handle, query } = wire.readRequestSchema.parse(request)
      return { value: await readQuery(heldBy(handle).doc, query) }
    },
    readNow(request: wire.ReadRequest) {
      const { handle, query } = wire.readRequestSchema.parse(request)
      return { value: readQueryNow(heldBy(handle).doc, query) }
    },
    version(request: wire.VersionRequest) {
      const { handle, at } = wire.versionRequestSchema.parse(request)
      return versionOf(heldBy(handle).doc, at)
    },
    decode: (request: wire.DecodeRequest) => decodeBytes(wire.decodeRequestSchema.parse(request)),
    undoState(request: wire.UndoStateRequest) {
      const { undo } = heldBy(wire.undoStateRequestSchema.parse(request).handle)
      return { canUndo: undo.canUndo(), canRedo: undo.canRedo() }
    },
    undoClear(request: wire.UndoClearRequest) {
      heldBy(wire.undoClearRequestSchema.parse(request).handle).undo.clear()
    },
  }
}

/** Places the subtree and names the root it placed, when the bytes held a document. */
function placeSubtree(
  heldBy: (handle: number) => Held,
  { handle, bytes, parentPath, judge }: wire.ImportSubtreeRequest,
): wire.MutationResult {
  let placed: ReturnType<typeof importWorkspaceSubtree> = null
  const result = mutate(
    heldBy(handle),
    (doc) => {
      placed = importWorkspaceSubtree(doc, decoded(bytes), parentPath)
    },
    judge,
  )
  // `placed` is the closure's own record of the root, so TypeScript narrows it to null.
  const root = placed as ReturnType<typeof importWorkspaceSubtree>
  return result.outcome === 'applied' && root !== null
    ? { ...result, root: { documentId: root.documentId, path: root.path } }
    : result
}

/** The calls that change a document: each is one commit, judged and restored on refusal. */
function mutations(heldBy: (handle: number) => Held) {
  return {
    import(request: wire.ImportRequest) {
      const parsed = wire.importRequestSchema.parse(request)
      return importInto(heldBy(parsed.handle), parsed)
    },
    write(request: wire.WriteRequest) {
      const { handle, batch, judge } = wire.writeRequestSchema.parse(request)
      return mutate(heldBy(handle), (doc) => applyBatch(doc, batch), judge)
    },
    undo(request: wire.UndoRequest) {
      const { handle, judge } = wire.undoRequestSchema.parse(request)
      const entry = heldBy(handle)
      return mutate(
        entry,
        () => {
          entry.undo.undo()
        },
        judge,
      )
    },
    redo(request: wire.RedoRequest) {
      const { handle, judge } = wire.redoRequestSchema.parse(request)
      const entry = heldBy(handle)
      return mutate(
        entry,
        () => {
          entry.undo.redo()
        },
        judge,
      )
    },
    textSplice(request: wire.TextSpliceRequest) {
      const { handle, documentId, text, runs, judge } = wire.textSpliceRequestSchema.parse(request)
      const args = { ...(documentId === undefined ? {} : { documentId }), text, runs }
      return mutate(heldBy(handle), (doc) => applyWriter(doc, 'spliceText', args), judge)
    },
    importSubtree: (request: wire.ImportSubtreeRequest) =>
      placeSubtree(heldBy, wire.importSubtreeRequestSchema.parse(request)),
  }
}

export function createCrdtEngine(options: CrdtEngineOptions = {}): CrdtEngine {
  const mergeInterval = options.undoMergeIntervalMs ?? DEFAULT_UNDO_MERGE_MS
  const handles = new Map<number, Held>()
  let opened = 0
  const heldBy = (handle: number) => heldIn(handles, handle)
  const admit = (entry: Held): wire.OpenResponse => {
    handles.set(opened, entry)
    opened += 1
    return { handle: opened - 1 }
  }

  return {
    ...inspections(heldBy),
    ...mutations(heldBy),
    open: (request) => admit(openDocument(request, mergeInterval)),
    fork(request) {
      const parsed = wire.forkRequestSchema.parse(request)
      return admit(forkOf(heldBy(parsed.handle), parsed))
    },
    checkout(request) {
      const { handle, at } = wire.checkoutRequestSchema.parse(request)
      moveView(heldBy(handle), at)
    },
    close(request) {
      const { handle } = wire.closeRequestSchema.parse(request)
      const entry = heldBy(handle)
      handles.delete(handle)
      dropShadow(entry)
      release(entry.undo, entry.doc)
    },
    trim(request) {
      const entry = heldBy(wire.trimRequestSchema.parse(request).handle)
      // A view is checked out at a version and has no log to fold.
      if (entry.view) return
      dropShadow(entry)
      if (entry.log.length > 0 || entry.baseUpdates.length > 0) compact(entry)
    },
  }
}
