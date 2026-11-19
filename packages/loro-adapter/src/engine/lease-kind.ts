import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import { isEngineTrap } from '../engine-trap.js'
import { RecordBytesRejectedError, type RecordKind } from '../record-kind.js'
import {
  exportSnapshot,
  exportUpdateSince,
  importBytes,
  ownedLease,
  type RecordLease,
  versionOf,
} from './lease.js'
import { randomPeerId } from './peer.js'
import type { CrdtEngine } from './types.js'

export interface LeaseKindOptions {
  /** The peer each record writes as; a fresh random one by default. */
  readonly peer?: () => string
}

/** The same operations as the engine counts them, as peer to counter. */
function counters(entries: readonly { peer: string; counter: number }[]): Map<string, number> {
  return new Map(entries.map(({ peer, counter }) => [peer, counter]))
}

/**
 * Records held as engine leases. Each record owns its handle, so `release`
 * closes it and frees what the engine holds for it.
 */
export function leaseKind(
  loadEngine: () => Promise<CrdtEngine>,
  options: LeaseKindOptions = {},
): RecordKind<RecordLease> {
  const peerOf = options.peer ?? randomPeerId
  return {
    async load(snapshot, updates) {
      const engine = await loadEngine()
      try {
        const { handle } = engine.open({
          peer: peerOf(),
          bytes: bytesToBase64(snapshot),
          updates: updates.map((update) => bytesToBase64(update)),
        })
        return ownedLease(engine, handle)
      } catch (cause) {
        // A trap is the engine failing, not the bytes being refused.
        if (isEngineTrap(cause)) throw cause
        throw new RecordBytesRejectedError(cause)
      }
    },
    async empty() {
      const engine = await loadEngine()
      return ownedLease(engine, engine.open({ peer: peerOf() }).handle)
    },
    importInto(record, bytes) {
      importBytes(record, bytes, 'none')
    },
    encodedVersion: (record) => new Uint8Array(versionOf(record).encoded),
    atVersion(record, stored) {
      const held = counters(versionOf(record).entries)
      const named = counters(
        record.engine.decode({ kind: 'version', bytes: bytesToBase64(stored) }).entries,
      )
      return held.size === named.size && [...named].every(([peer, at]) => held.get(peer) === at)
    },
    exportUpdateSince,
    exportSnapshot,
    release: (record) => record.release(),
  }
}
