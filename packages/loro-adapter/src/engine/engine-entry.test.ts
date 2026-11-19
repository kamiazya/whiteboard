import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createCrdtEngine, loadCrdtEngine, randomPeerId, readValue } from '../index.js'
import { writeMarkdownBody } from '../markdown-body.js'
import { unplain } from './answers.js'

function snapshotWithBody(body: string): string {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, body)
  doc.commit()
  return bytesToBase64(doc.export({ mode: 'snapshot' }))
}

describe('the engine entry', () => {
  it('names a peer as a decimal u64 that differs between calls', () => {
    const peers = Array.from({ length: 20 }, randomPeerId)
    for (const peer of peers) {
      expect(peer).toMatch(/^\d{1,20}$/)
      expect(BigInt(peer)).toBeLessThanOrEqual(2n ** 64n - 1n)
    }
    expect(new Set(peers).size).toBe(20)
  })

  it('opens a document under a random peer, so the engine takes the id it makes', () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: randomPeerId() })
    expect(() => engine.close({ handle })).not.toThrow()
  })

  it('loads one engine per realm and answers the same one to every caller', async () => {
    const [first, second] = await Promise.all([loadCrdtEngine(), loadCrdtEngine()])
    expect(first).toBe(second)
    expect(await loadCrdtEngine()).toBe(first)
  })

  it('reads a named query as the value the reader produced', async () => {
    const engine = await loadCrdtEngine()
    const { handle } = engine.open({ peer: randomPeerId(), bytes: snapshotWithBody('hello') })
    try {
      expect(await readValue(engine, handle, { query: 'markdownBody' }, z.string())).toBe('hello')
    } finally {
      engine.close({ handle })
    }
  })

  it('throws a refusal named for the class the reader refused with', async () => {
    const engine = await loadCrdtEngine()
    const { handle } = engine.open({ peer: randomPeerId() })
    try {
      const refused = await readValue(
        engine,
        handle,
        { query: 'workspaceDocumentProjection' },
        z.unknown(),
      ).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(Error)
      expect((refused as Error).name).toBe('TypeError')
    } finally {
      engine.close({ handle })
    }
  })
})

describe('unplain', () => {
  it('gives back what the markers stand for, at any depth', () => {
    const wire = {
      missing: { $undefined: true },
      inf: { $number: 'Infinity' },
      big: { $bigint: '12' },
      set: { $set: [1, { $undefined: true }] },
      map: { $map: [['a', { b: { $undefined: true } }]] },
      list: [1, 'x', null],
    }
    expect(unplain(wire)).toEqual({
      missing: undefined,
      inf: Number.POSITIVE_INFINITY,
      big: 12n,
      set: new Set([1, undefined]),
      map: new Map([['a', { b: undefined }]]),
      list: [1, 'x', null],
    })
  })

  it('refuses a marker that names bytes, which an answer cannot carry back', () => {
    expect(() => unplain({ $loroState: {} })).toThrow(TypeError)
  })
})
