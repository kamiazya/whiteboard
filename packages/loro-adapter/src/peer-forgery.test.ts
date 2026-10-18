import { decodeImportBlobMeta, LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'

/**
 * Loro names every change by (peer, counter) and treats an id it already holds
 * as already applied. Nothing in the update says WHO wrote it, so a writer that
 * sets another writer's peer id can occupy that writer's next counters first.
 * These pins record what the engine does with that, so a keeper that relays
 * updates from more than one person knows what it has to bind itself.
 */
describe('a change forged under another peer id', () => {
  const VICTIM = 1n
  const FORGER = 2n

  function seeded(): { keeper: LoroDoc; victim: LoroDoc; forger: LoroDoc } {
    const keeper = new LoroDoc()
    keeper.setPeerId(99n)
    keeper.getMap('root').set('base', 'v0')
    keeper.commit()
    const base = keeper.export({ mode: 'snapshot' })
    const victim = LoroDoc.fromSnapshot(base)
    victim.setPeerId(VICTIM)
    const forger = LoroDoc.fromSnapshot(base)
    forger.setPeerId(FORGER)
    return { keeper, victim, forger }
  }

  it("occupies the victim's next counters, so the real edit imports as already known", () => {
    const { keeper, victim, forger } = seeded()

    forger.setPeerId(VICTIM)
    forger.getMap('root').set('forged', 'by-forger')
    forger.commit()
    keeper.import(forger.export({ mode: 'update', from: keeper.oplogVersion() }))

    const before = keeper.oplogVersion()
    victim.getMap('root').set('real', 'by-victim')
    victim.commit()
    keeper.import(victim.export({ mode: 'update', from: before }))

    const root = keeper.getMap('root').toJSON() as Record<string, unknown>
    expect(root.forged).toBe('by-forger')
    expect(root.real).toBeUndefined()
  })

  it('names the forged peer in the update, readable before import', () => {
    const { keeper, forger } = seeded()
    forger.setPeerId(VICTIM)
    forger.getMap('root').set('forged', 'by-forger')
    forger.commit()
    const update = forger.export({ mode: 'update', from: keeper.oplogVersion() })
    const meta = decodeImportBlobMeta(update, false)
    expect([...meta.partialEndVersionVector.toJSON().keys()]).toContain(String(VICTIM))
  })
})
