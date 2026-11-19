/**
 * What a record keeper writes to the store does not depend on how the record
 * is held. The same scripted edits, as the same peer, through a `LoroDoc` and
 * through an engine lease leave the same snapshot, deltas and frontier, so a
 * workspace written by one is read back by the other and by every older
 * release.
 */
import {
  leaseKind,
  lease as leases,
  loadCrdtEngine,
  loroDocKind,
  type RecordKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import type { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { RecordStoreWorkspaceDocs } from './document-store-workspace-docs.js'
import { RECORD_SUBJECTS } from './test-utils/record-subjects.js'

const PEER = '4242'
const REF: DocRef = { kind: 'workspace-tree', workspaceId: 'ws-a' }

interface Script {
  readonly name: string
  readonly kind: RecordKind<unknown>
  /** An empty record that writes as `PEER`. */
  fresh(): Promise<unknown>
  /** Replaces the body and commits. */
  body(record: unknown, text: string): void
}

const loroScript: Script = {
  name: 'loroDocKind',
  kind: loroDocKind as RecordKind<unknown>,
  async fresh() {
    const doc = await loroDocKind.empty()
    doc.setPeerId(BigInt(PEER))
    return doc
  },
  body(record, text) {
    const doc = record as LoroDoc
    writeMarkdownBody(doc, text)
    doc.commit()
  },
}

const leaseOfPeer = leaseKind(loadCrdtEngine, { peer: () => PEER }) as RecordKind<unknown>
const leaseScript: Script = {
  name: 'leaseKind',
  kind: leaseOfPeer,
  fresh: () => leaseOfPeer.empty(),
  body(record, text) {
    leases.write(record as Parameters<typeof leases.write>[0], [
      { op: 'writeMarkdownBody', args: { body: text } },
    ])
  },
}

/** Everything a store holds for the record, as bytes. */
async function stored(store: InMemoryDocumentStore) {
  const snapshot = await store.loadSnapshot({ docRef: REF })
  const tail = await store.loadDeltas({ docRef: REF, afterSeq: null })
  return {
    snapshot: snapshot === null ? null : reassembleSnapshot(snapshot.manifest, snapshot.chunks),
    snapshotFrontier: snapshot?.frontier ?? null,
    deltas: tail.updates,
    frontier: (await store.readFrontier({ docRef: REF }))?.frontier ?? null,
  }
}

/** Mint, append twice, fold, append again; answers every save's update and what the store ended holding. */
async function run(script: Script) {
  const store = new InMemoryDocumentStore()
  const docs = new RecordStoreWorkspaceDocs(store, script.kind)
  const record = await script.fresh()
  const updates: (Uint8Array | null)[] = []
  const edit = async (text: string) => {
    script.body(record, text)
    updates.push(await docs.save('ws-a', record))
  }
  await edit('first')
  await edit('first, then more')
  await edit('first, then more and more')
  // Past the fold budget, so the snapshot is rewritten from the merged state.
  await edit(`bulk ${'x'.repeat(80_000)}`)
  await edit('after the fold')
  updates.push(await docs.save('ws-a', record))
  return { updates, held: await stored(store) }
}

describe('the bytes a keeper stores', () => {
  it('are identical whether the record is a LoroDoc or an engine lease', async () => {
    const [viaDoc, viaLease] = [await run(loroScript), await run(leaseScript)]

    expect(viaDoc.held.deltas.length).toBeGreaterThan(0)
    expect(viaDoc.held.snapshot?.byteLength).toBeGreaterThan(0)
    expect(viaLease.held.frontier).toEqual(viaDoc.held.frontier)
    expect(viaLease.held.snapshotFrontier).toEqual(viaDoc.held.snapshotFrontier)
    expect(viaLease.held.snapshot).toEqual(viaDoc.held.snapshot)
    expect(viaLease.held.deltas).toEqual(viaDoc.held.deltas)
    expect(viaLease.updates).toEqual(viaDoc.updates)
    // The idle save at the end answers null on both, so equality is not two empties.
    expect(viaDoc.updates.at(-1)).toBeNull()
    expect(viaDoc.updates.slice(0, -1).every((update) => update !== null)).toBe(true)
  })
})

describe.each(RECORD_SUBJECTS)('storedVersion over a record held as $name', (subject) => {
  it('is null for an absent record and the stored version vector otherwise, from one store read', async () => {
    const store = new InMemoryDocumentStore()
    const docs = new RecordStoreWorkspaceDocs(store, subject.kind)
    expect(await docs.storedVersion('ws-a')).toBeNull()

    const record = await subject.fresh()
    subject.put(record, 'k', 'v')
    await docs.save('ws-a', record)
    subject.put(record, 'k2', 'v2')
    await docs.save('ws-a', record)

    const snapshotRead = vi.spyOn(store, 'loadSnapshot')
    const deltaRead = vi.spyOn(store, 'loadDeltas')
    const frontierRead = vi.spyOn(store, 'readFrontier')
    const version = await docs.storedVersion('ws-a')

    expect(version).toEqual(subject.kind.encodedVersion(record))
    expect(frontierRead).toHaveBeenCalledTimes(1)
    expect(snapshotRead).not.toHaveBeenCalled()
    expect(deltaRead).not.toHaveBeenCalled()
  })
})

describe.each(RECORD_SUBJECTS)('a fold over a record held as $name', (subject) => {
  it('gives its scratch record back, and never the caller’s', async () => {
    const released: unknown[] = []
    const kind: RecordKind<unknown> = {
      ...subject.kind,
      release(record) {
        released.push(record)
        subject.kind.release(record)
      },
    }
    const docs = new RecordStoreWorkspaceDocs(new InMemoryDocumentStore(), kind)
    const record = await subject.fresh()
    subject.put(record, 'seed', '1')
    await docs.save('ws-a', record)
    expect(released).toHaveLength(0)

    subject.put(record, 'bulk', 'x'.repeat(80_000))
    await docs.save('ws-a', record)

    expect(released).toHaveLength(1)
    expect(released).not.toContain(record)
  })
})
