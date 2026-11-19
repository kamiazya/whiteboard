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
import type { CrdtEngine } from './types.js'

export const journalSchema = z
  .object({
    peer: wire.peerIdSchema,
    base: wire.bytesSchema,
    pending: z.array(
      z.object({ seq: z.number().int().positive().optional(), update: wire.bytesSchema }).strict(),
    ),
  })
  .strict()
export type Journal = z.infer<typeof journalSchema>

/** A mutation's answer, and the sequence number its local update was journalled under. */
export type JournaledMutation = wire.MutationResult & { seq?: number }

export interface JournaledEngine {
  open(request: wire.OpenRequest): wire.OpenResponse
  import(request: wire.ImportRequest): wire.MutationResult
  export(request: wire.ExportRequest): wire.ExportResponse
  write(request: wire.WriteRequest): JournaledMutation
  read(request: wire.ReadRequest): Promise<wire.ReadResponse>
  undo(request: wire.UndoRequest): JournaledMutation
  redo(request: wire.RedoRequest): JournaledMutation
  textSplice(request: wire.TextSpliceRequest): JournaledMutation
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

export function journaledEngine(engine: CrdtEngine): JournaledEngine {
  const held = new Map<number, Held>()

  const recordOf = (handle: number): Held => {
    const record = held.get(handle)
    if (record === undefined) throw new RangeError(`no journal for handle ${handle}`)
    return record
  }

  const local = (handle: number, result: wire.MutationResult): JournaledMutation => {
    if (result.localUpdate === undefined) return result
    const record = recordOf(handle)
    const seq = record.nextSeq
    record.nextSeq += 1
    record.pending.push({ seq, update: result.localUpdate })
    return { ...result, seq }
  }

  const begin = (peer: string, base: string, handle: number) => {
    held.set(handle, { peer, base, pending: [], nextSeq: 1 })
  }

  return {
    open(request) {
      const opened = engine.open(request)
      const base = request.bytes ?? engine.export({ handle: opened.handle, mode: 'snapshot' }).bytes
      begin(request.peer, base, opened.handle)
      return opened
    },
    import(request) {
      const result = engine.import(request)
      // A refused import changed nothing, so it is nothing to rebuild.
      if (result.breach === undefined) {
        recordOf(request.handle).pending.push({ update: request.bytes })
      }
      return result
    },
    export: (request) => engine.export(request),
    write: (request) => local(request.handle, engine.write(request)),
    read: (request) => engine.read(request),
    undo: (request) => local(request.handle, engine.undo(request)),
    redo: (request) => local(request.handle, engine.redo(request)),
    textSplice: (request) => local(request.handle, engine.textSplice(request)),
    journal(handle) {
      const record = recordOf(handle)
      return journalSchema.parse({
        peer: record.peer,
        base: record.base,
        pending: record.pending,
      })
    },
    acknowledge(handle, upTo) {
      const record = recordOf(handle)
      const kept = record.pending.filter(({ seq }) => seq !== undefined && seq > upTo)
      if (kept.length === record.pending.length) return
      // The new base is the state NOW, which already holds the local updates
      // still waiting on the keeper; importing one of them again on rebuild is
      // a no-op, and they stay listed so the host knows what to resend.
      record.base = engine.export({ handle, mode: 'snapshot' }).bytes
      record.pending = kept
    },
    rehydrate(journal) {
      const { peer, base, pending } = journalSchema.parse(journal)
      const opened = engine.open({ peer, bytes: base })
      for (const { update } of pending) {
        const result = engine.import({ handle: opened.handle, bytes: update })
        if (result.breach !== undefined) {
          throw new Error(`a journalled update was refused as ${result.breach.shape}`)
        }
      }
      const nextSeq = pending.reduce((next, { seq }) => Math.max(next, (seq ?? 0) + 1), 1)
      held.set(opened.handle, { peer, base, pending: [...pending], nextSeq })
      return opened
    },
  }
}
