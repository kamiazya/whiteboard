import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  frontiersFromBase64,
  frontiersToBase64,
} from './frontiers-base64.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

describe('frontiers as base64', () => {
  fcTest.prop([fc.uint8Array({ maxLength: 70_000 })], withDefaults())(
    'bytes round-trip, including past the argument-list chunk boundary',
    (bytes) => {
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    },
  )

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

  it('answers the same text Node would for the same bytes', () => {
    // The daemon's rows were written with Buffer; the codec must read them.
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})
