import type { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { loroDocKind } from '../legacy-record-kind.js'
import { RecordBytesRejectedError, type RecordKind } from '../record-kind.js'
import { createCrdtEngine } from './engine.js'
import { leaseKind } from './lease-kind.js'
import type { CrdtEngine } from './types.js'

const engine = createCrdtEngine()
const loaded = () => Promise.resolve(engine)

function body(text: string) {
  return [{ op: 'writeMarkdownBody' as const, args: { body: text } }]
}

describe('a lease kind loading bytes', () => {
  it('refuses bytes that are not a document as rejected bytes', async () => {
    const kind = leaseKind(loaded)
    await expect(kind.load(new Uint8Array([1, 2, 3, 4, 5]), [])).rejects.toBeInstanceOf(
      RecordBytesRejectedError,
    )
    const sound = await kind.empty()
    kind.release(sound)
  })

  it('refuses an update that is not importable even when the snapshot is sound', async () => {
    const kind = leaseKind(loaded)
    const sound = await kind.empty()
    const snapshot = kind.exportSnapshot(sound)
    await expect(kind.load(snapshot, [new Uint8Array([9, 9, 9])])).rejects.toBeInstanceOf(
      RecordBytesRejectedError,
    )
  })

  it('lets a failure of the engine itself through as what it was', async () => {
    const unavailable = new Error('wasm did not load')
    await expect(
      leaseKind(() => Promise.reject(unavailable)).load(new Uint8Array(), []),
    ).rejects.toBe(unavailable)

    const trap = Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
    const trapping = {
      ...engine,
      open() {
        throw trap
      },
    } as unknown as CrdtEngine
    await expect(
      leaseKind(() => Promise.resolve(trapping)).load(new Uint8Array(), []),
    ).rejects.toBe(trap)
  })
})

describe('comparing a record to a stored version vector', () => {
  /** A record on each kind, both written by the same peers in the same order. */
  async function pair(peers: readonly string[]) {
    const viaLease = leaseKind(loaded, { peer: () => peers[0] ?? '1' })
    const lease = await viaLease.empty()
    const doc = (await loroDocKind.empty()) as LoroDoc
    doc.setPeerId(BigInt(peers[0] ?? '1'))
    return { viaLease, lease, doc }
  }

  it('answers as a LoroDoc does: equal, behind, ahead, and a different peer', async () => {
    const { viaLease, lease, doc } = await pair(['7'])
    const write = (text: string) => {
      engine.write({ handle: lease.handle, batch: body(text) })
      doc.getText('body').update(text)
      doc.commit()
    }
    const same = (stored: Uint8Array) => [
      viaLease.atVersion(lease, stored),
      loroDocKind.atVersion(doc, stored),
    ]
    write('one')
    const first = viaLease.encodedVersion(lease)
    expect(same(first)).toEqual([true, true])
    write('one two')
    // The stored vector is behind the record, which is not the same version.
    expect(same(first)).toEqual([false, false])
    const second = viaLease.encodedVersion(lease)
    expect(same(second)).toEqual([true, true])

    const other = await leaseKind(loaded, { peer: () => '8' }).empty()
    engine.write({ handle: other.handle, batch: body('x') })
    const elsewhere = viaLease.encodedVersion(other)
    expect(viaLease.atVersion(lease, elsewhere)).toBe(false)
    // A stored vector from another peer that the record also holds extra to.
    engine.import({
      handle: lease.handle,
      bytes: Buffer.from(viaLease.exportUpdateSince(other, null)).toString('base64'),
      judge: 'none',
    })
    expect(viaLease.atVersion(lease, elsewhere)).toBe(false)
    expect(viaLease.atVersion(other, second)).toBe(false)
  })

  it('exports the same update bytes as a LoroDoc since a stored version', async () => {
    const { viaLease, lease, doc } = await pair(['7'])
    const kinds: readonly [RecordKind<unknown>, unknown][] = [
      [viaLease as RecordKind<unknown>, lease],
      [loroDocKind as RecordKind<unknown>, doc],
    ]
    engine.write({ handle: lease.handle, batch: body('one') })
    doc.getText('body').update('one')
    doc.commit()
    const [leaseVersion, docVersion] = kinds.map(([kind, record]) => kind.encodedVersion(record))
    expect(leaseVersion).toEqual(docVersion)
    expect(viaLease.exportUpdateSince(lease, null)).toEqual(
      loroDocKind.exportUpdateSince(doc, null),
    )
  })
})
