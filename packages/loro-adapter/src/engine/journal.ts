/**
 * A record, kept by the host of an engine, of what a handle holds: the bytes
 * it was built from and every update applied since. When the engine is lost —
 * the wasm core trapped and was re-instantiated, so a handle names nothing —
 * the host rebuilds the document from the journal alone.
 *
 * It lives in front of the port, over the contract's bytes only, so it works
 * the same over the TypeScript engine and the Rust one and holds nothing that
 * dies with either.
 *
 * What it keeps: `base`, a document an engine exported, and `pending`, each
 * update applied after it in order — a local update carries the `seq` the
 * mutating call answered with, one a peer sent does not. `acknowledge` is the
 * host saying the keeper durably holds every local update up to a `seq`; it
 * folds everything applied so far into a new `base`, so `pending` shrinks to
 * what the keeper still lacks. A host that never acknowledges keeps every
 * update in memory.
 *
 * ponytail: an acknowledgement costs one snapshot export, so a host
 * acknowledges per round trip to its keeper, not per keystroke.
 */
import { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { exportedBytes } from './answers.js'
import type { CrdtEngine } from './types.js'

const journalSchema = z
  .object({
    peer: wire.peerIdSchema,
    base: wire.bytesSchema,
    pending: z.array(
      z.object({ seq: z.number().int().positive().optional(), update: wire.bytesSchema }).strict(),
    ),
  })
  .strict()
type Journal = z.infer<typeof journalSchema>

/** A mutation's answer, and the sequence number its local update was journalled under. */
type JournaledMutation = wire.MutationResult & { seq?: number }

export interface JournaledEngine {
  open(request: wire.OpenRequest): wire.OpenResponse
  close(request: wire.CloseRequest): void
  import(request: wire.ImportRequest): wire.MutationResult
  export(request: wire.ExportRequest): wire.ExportResponse
  write(request: wire.WriteRequest): JournaledMutation
  read(request: wire.ReadRequest): Promise<wire.ReadResponse>
  readNow(request: wire.ReadRequest): wire.ReadResponse
  undo(request: wire.UndoRequest): JournaledMutation
  redo(request: wire.RedoRequest): JournaledMutation
  textSplice(request: wire.TextSpliceRequest): JournaledMutation
  importSubtree(request: wire.ImportSubtreeRequest): JournaledMutation
  fork(request: wire.ForkRequest): wire.OpenResponse
  version(request: wire.VersionRequest): wire.VersionResponse
  decode(request: wire.DecodeRequest): wire.DecodeResponse
  undoState(request: wire.UndoStateRequest): wire.UndoStateResponse
  undoClear(request: wire.UndoClearRequest): void
  trim(request: wire.TrimRequest): void
  journal(handle: wire.Handle): Journal
  /** The keeper holds every local update up to and including `upTo`. */
  acknowledge(handle: wire.Handle, upTo: number): void
  /** A handle on `engine` holding what the journal's document held. */
  rehydrate(journal: Journal): wire.OpenResponse
}

interface Held {
  peer: string
  base: string
  pending: Array<{ seq?: number; update: string }>
  nextSeq: number
}

type Records = Map<number, Held>

function recordOf(held: Records, handle: number): Held {
  const record = held.get(handle)
  if (record === undefined) throw new RangeError(`no journal for handle ${handle}`)
  return record
}

function journalLocal(
  held: Records,
  handle: number,
  result: wire.MutationResult,
): JournaledMutation {
  if (result.outcome === 'refused' || result.localUpdate === undefined) return result
  const record = recordOf(held, handle)
  const seq = record.nextSeq
  record.nextSeq += 1
  record.pending.push({ seq, update: result.localUpdate })
  return { ...result, seq }
}

function acknowledgeUpTo(held: Records, engine: CrdtEngine, handle: number, upTo: number) {
  const record = recordOf(held, handle)
  const waiting = record.pending.filter(({ seq }) => seq !== undefined && seq > upTo)
  const acknowledged = record.pending.filter(({ seq }) => seq !== undefined && seq <= upTo)
  if (acknowledged.length === 0) return
  // The new base is the state NOW, which already holds the local updates still
  // waiting on the keeper; importing one of them again on rebuild is a no-op,
  // and they stay listed so the host knows what to resend.
  const base = exportedBytes(engine.export({ handle, mode: 'snapshot' }))
  // A snapshot leaves a parked update out, so one the base lacks stays listed
  // and rebuild re-parks it where the update it builds on can still arrive.
  const parked = stillParked(engine, record.peer, base, record.pending)
  record.base = base
  record.pending = record.pending.filter((entry) => waiting.includes(entry) || parked.has(entry))
}

/** The peer-sent entries `base` does not hold: each is imported into a copy, and a parked one never applies. */
function stillParked(
  engine: CrdtEngine,
  peer: string,
  base: string,
  pending: Held['pending'],
): Set<Held['pending'][number]> {
  const lacking = new Set<Held['pending'][number]>()
  const probe = engine.open({ peer, bytes: base })
  try {
    for (const entry of pending) {
      if (entry.seq !== undefined) continue
      const result = engine.import({ handle: probe.handle, bytes: entry.update, judge: 'none' })
      if (result.outcome === 'applied' && result.pending === true) lacking.add(entry)
    }
  } finally {
    engine.close({ handle: probe.handle })
  }
  return lacking
}

function rebuild(held: Records, engine: CrdtEngine, journal: Journal): wire.OpenResponse {
  const { peer, base, pending } = journalSchema.parse(journal)
  const opened = engine.open({ peer, bytes: base })
  for (const { update } of pending) {
    const result = engine.import({ handle: opened.handle, bytes: update, judge: 'none' })
    if (result.outcome === 'refused') {
      throw new Error(`a journalled update was refused as ${result.breach.shape}`)
    }
  }
  const nextSeq = pending.reduce((next, { seq }) => Math.max(next, (seq ?? 0) + 1), 1)
  held.set(opened.handle, { peer, base, pending: [...pending], nextSeq })
  return opened
}

function emptyBase(engine: CrdtEngine, peer: string): string {
  const { handle } = engine.open({ peer })
  try {
    return exportedBytes(engine.export({ handle, mode: 'snapshot' }))
  } finally {
    engine.close({ handle })
  }
}

function openJournaled(held: Records, engine: CrdtEngine, request: wire.OpenRequest) {
  const opened = engine.open(request)
  // The base is what the document was opened from and the updates opened after
  // it stay pending: a snapshot of the opened document would leave out one that
  // arrived before the update it builds on.
  const base = request.bytes ?? emptyBase(engine, request.peer)
  const pending = (request.updates ?? []).map((update) => ({ update }))
  held.set(opened.handle, { peer: request.peer, base, pending, nextSeq: 1 })
  return opened
}

/**
 * A view at a version has nothing to rebuild from, so only a copy of the head
 * is journalled.
 *
 * The copy takes its source's own record, not a snapshot of itself: a snapshot
 * leaves out an update still parked, which the copy carries. To the copy every
 * update is one somebody else made, so none keeps a seq. A view has no record
 * and parks nothing, so a copy of one starts from a snapshot.
 */
function forkJournaled(held: Records, engine: CrdtEngine, request: wire.ForkRequest) {
  const opened = engine.fork(request)
  if (request.at !== undefined) return opened
  const source = held.get(request.handle)
  const base = source?.base ?? exportedBytes(engine.export({ handle: opened.handle, mode: 'snapshot' }))
  const pending = (source?.pending ?? []).map(({ update }) => ({ update }))
  held.set(opened.handle, { peer: request.peer, base, pending, nextSeq: 1 })
  return opened
}

export function journaledEngine(engine: CrdtEngine): JournaledEngine {
  const held: Records = new Map()
  return {
    open: (request) => openJournaled(held, engine, request),
    close(request) {
      engine.close(request)
      held.delete(request.handle)
    },
    import(request) {
      const result = engine.import(request)
      // A refused import changed nothing, so it is nothing to rebuild.
      if (result.outcome === 'applied') {
        recordOf(held, request.handle).pending.push({ update: request.bytes })
      }
      return result
    },
    export: (request) => engine.export(request),
    write: (request) => journalLocal(held, request.handle, engine.write(request)),
    read: (request) => engine.read(request),
    readNow: (request) => engine.readNow(request),
    undo: (request) => journalLocal(held, request.handle, engine.undo(request)),
    redo: (request) => journalLocal(held, request.handle, engine.redo(request)),
    textSplice: (request) => journalLocal(held, request.handle, engine.textSplice(request)),
    importSubtree: (request) => journalLocal(held, request.handle, engine.importSubtree(request)),
    fork: (request) => forkJournaled(held, engine, request),
    version: (request) => engine.version(request),
    decode: (request) => engine.decode(request),
    undoState: (request) => engine.undoState(request),
    undoClear: (request) => engine.undoClear(request),
    trim: (request) => engine.trim(request),
    journal(handle) {
      const { peer, base, pending } = recordOf(held, handle)
      return journalSchema.parse({ peer, base, pending })
    },
    acknowledge: (handle, upTo) => acknowledgeUpTo(held, engine, handle, upTo),
    rehydrate: (journal) => rebuild(held, engine, journal),
  }
}
