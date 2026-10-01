import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { frontiersFromBase64, frontiersToBase64 } from './frontiers-base64.js'

describe('frontiers as base64', () => {
  it('a real frontier round-trips and checks out to the same state', () => {
    const doc = new LoroDoc()
    doc.getMap('nodes').set('a', 1)
    doc.commit()
    const mark = doc.oplogFrontiers()
    doc.getMap('nodes').set('b', 2)
    doc.commit()

    const back = frontiersFromBase64(frontiersToBase64(mark))
    const clone = LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' }))
    clone.checkout(back)
    expect(clone.getMap('nodes').toJSON()).toEqual({ a: 1 })
  })

  it('reads the text a Buffer-writing keeper stored', () => {
    // The daemon's rows were written with Buffer; the codec must read them.
    const doc = new LoroDoc()
    doc.getMap('nodes').set('a', 1)
    doc.commit()
    const frontiers = doc.oplogFrontiers()
    const stored = frontiersToBase64(frontiers)
    expect(frontiersFromBase64(stored)).toEqual(frontiers)
    expect(Buffer.from(stored, 'base64').toString('base64')).toBe(stored)
  })

  it('throws on text that is not base64, naming what it was reading', () => {
    expect(() => frontiersFromBase64('not base64!')).toThrow('frontiers are not base64')
  })
})
