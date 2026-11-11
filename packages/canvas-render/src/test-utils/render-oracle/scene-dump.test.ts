import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { buildEveryKindScene } from './every-kind-scene.js'
import { dumpScene, f64Hex } from './scene-dump.js'

const shapeAt = (x: number): Scene => ({
  nodes: [{ kind: 'shape', bbox: { x, y: 0, w: 1, h: 1 } }],
})

describe('the canonical scene dump', () => {
  it('writes a number as the hex of its 64 IEEE bits', () => {
    expect(f64Hex(1)).toBe('3ff0000000000000')
    expect(f64Hex(0)).toBe('0000000000000000')
    expect(f64Hex(-0)).toBe('8000000000000000')
    expect(f64Hex(0.1)).toBe('3fb999999999999a')
  })

  it('tells -0 from 0 and a value from its neighbour one ulp away', () => {
    expect(dumpScene(shapeAt(-0))).not.toBe(dumpScene(shapeAt(0)))
    expect(dumpScene(shapeAt(0.1))).not.toBe(dumpScene(shapeAt(0.1 + Number.EPSILON / 8)))
  })

  it('does not depend on the order a producer built an object in, or on an undefined field', () => {
    const a: Scene = { nodes: [{ kind: 'shape', bbox: { x: 1, y: 2, w: 3, h: 4 } }] }
    const b: Scene = {
      nodes: [{ bbox: { h: 4, w: 3, y: 2, x: 1 }, kind: 'shape', id: undefined }],
    }
    expect(dumpScene(a)).toBe(dumpScene(b))
  })

  it('dumps every field of every scene kind, nested nodes included', () => {
    const text = dumpScene(buildEveryKindScene())
    for (const needle of ['"embedResolved"', '"tableCell"', '"listItem"', '"glyph"', '"jumps"']) {
      expect(text.includes(needle), needle).toBe(true)
    }
    // No bare decimal number survives: they are all bit patterns.
    expect(text.replace(/"(?:[^"\\]|\\.)*"/g, '')).not.toMatch(/\d\.\d|[:,[]\d/)
  })

  it('refuses a node kind it was not taught', () => {
    const unknown = { nodes: [{ kind: 'sparkle', bbox: { x: 0, y: 0, w: 0, h: 0 } }] }
    expect(() => dumpScene(unknown as unknown as Scene)).toThrow(/unplaced scene node kind/)
  })
})
