import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { frontiersFromBase64, frontiersToBase64 } from './frontiers-base64.js'
import {
  frontiersFromBase64ToFrontiers as fromText,
  frontiersToBase64OfFrontiers as toText,
} from './test-utils/crdt-mechanics-oracle.js'

describe('frontiers as base64', () => {
  it('a real frontier round-trips and checks out to the same state', () => {
    const doc = new LoroDoc()
    doc.getMap('nodes').set('a', 1)
    doc.commit()
    const mark = doc.oplogFrontiers()
    doc.getMap('nodes').set('b', 2)
    doc.commit()

    const back = fromText(toText(mark))
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
    const stored = toText(frontiers)
    expect(fromText(stored)).toEqual(frontiers)
    expect(Buffer.from(stored, 'base64').toString('base64')).toBe(stored)
  })

  it('hands back exactly the bytes it was given, whatever they hold', () => {
    const opaque = new Uint8Array([0, 255, 1, 254, 7])
    expect(frontiersFromBase64(frontiersToBase64(opaque))).toEqual(opaque)
  })

  it('throws on text that is not base64, naming what it was reading', () => {
    expect(() => frontiersFromBase64('not base64!')).toThrow('frontiers are not base64')
  })
})
