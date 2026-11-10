import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import type { CodecParseResult } from '../errors.js'
import { parseSpatial } from './parse.js'
import { serializeSpatial } from './serialize.js'
import {
  type SpatialCore,
  type SpatialImpl,
  type SpatialMismatch,
  spatialCodec,
} from './spatial-core.js'

const CANVAS: SpatialCanvas = {
  nodes: [{ id: 'a', x: 0, y: 0, width: 10, height: 10, resource: { content: 'hi' } }],
  edges: [],
} as unknown as SpatialCanvas
const TEXT = serializeSpatial(CANVAS, 'extended')

/** A core that answers as the TypeScript does, with one call replaced. */
function fakeCore(overrides: Partial<SpatialCore> = {}): SpatialCore & { calls: number } {
  const core = {
    calls: 0,
    parseSpatial(text: string) {
      core.calls++
      return (overrides.parseSpatial ?? parseSpatial)(text)
    },
    serializeSpatial(canvas: SpatialCanvas, mode: 'strict' | 'extended') {
      core.calls++
      return (overrides.serializeSpatial ?? serializeSpatial)(canvas, mode)
    },
  }
  return core
}

function switched(spatial: SpatialCore, impl: SpatialImpl) {
  const reports: SpatialMismatch[] = []
  const codec = spatialCodec({
    spatial,
    impl: { parseSpatial: impl, serializeSpatial: impl },
    onMismatch: (m) => reports.push(m),
  })
  return { codec, reports }
}

const declining = () => {
  throw new Error('declined')
}

/** What `@kamiazya/whiteboard-core-wasm` throws; declared by name and shape, so codec need not import it. */
const invalid =
  (issues: unknown = [{ path: ['edges', 0, 'toNode'], code: 'custom', message: 'no such node' }]) =>
  () => {
    throw Object.assign(new Error('strict refused'), { name: 'CoreSpatialInvalid', issues })
  }

describe('spatialCodec', () => {
  it('answers with the TypeScript when no core is given', () => {
    const codec = spatialCodec(undefined)
    expect(codec.parseSpatial(TEXT)).toEqual(parseSpatial(TEXT))
    expect(codec.serializeSpatial(CANVAS, 'strict')).toBe(serializeSpatial(CANVAS, 'strict'))
  })

  it('never asks the core under ts', () => {
    const core = fakeCore()
    const { codec } = switched(core, 'ts')
    codec.parseSpatial(TEXT)
    codec.serializeSpatial(CANVAS, 'extended')
    expect(core.calls).toBe(0)
  })

  it('answers with the core under rust, and hands it the mode', () => {
    const rustCanvas: CodecParseResult<SpatialCanvas> = {
      ok: true,
      value: { nodes: [], edges: [] } as unknown as SpatialCanvas,
    }
    const modes: string[] = []
    const { codec } = switched(
      fakeCore({
        parseSpatial: () => rustCanvas,
        serializeSpatial: (_, mode) => {
          modes.push(mode)
          return 'written by rust'
        },
      }),
      'rust',
    )
    expect(codec.parseSpatial(TEXT)).toBe(rustCanvas)
    expect(codec.serializeSpatial(CANVAS, 'strict')).toBe('written by rust')
    expect(modes).toEqual(['strict'])
  })

  it.each([
    'rust',
    'differential',
  ] as const)('answers a declined call with the TypeScript under %s, and reports it', (impl) => {
    const { codec, reports } = switched(
      fakeCore({ parseSpatial: declining, serializeSpatial: declining }),
      impl,
    )
    expect(codec.parseSpatial(TEXT)).toEqual(parseSpatial(TEXT))
    expect(codec.serializeSpatial(CANVAS, 'extended')).toBe(serializeSpatial(CANVAS, 'extended'))
    expect(reports.map((r) => [r.fn, r.kind])).toEqual([
      ['parseSpatial', 'declined'],
      ['serializeSpatial', 'declined'],
    ])
  })

  it('reports nothing when the two agree, and answers with the TypeScript', () => {
    const { codec, reports } = switched(fakeCore(), 'differential')
    expect(codec.parseSpatial(TEXT)).toEqual(parseSpatial(TEXT))
    expect(codec.parseSpatial('{')).toEqual(parseSpatial('{'))
    expect(codec.parseSpatial('{"nodes":7}')).toEqual(parseSpatial('{"nodes":7}'))
    expect(codec.serializeSpatial(CANVAS, 'strict')).toBe(serializeSpatial(CANVAS, 'strict'))
    expect(reports).toEqual([])
  })

  it('tells -0 from 0, a key holding undefined from an absent one, and two key orders apart', () => {
    const variants: ((c: SpatialCanvas) => SpatialCanvas)[] = [
      (c) => ({ ...c, nodes: c.nodes.map((n) => ({ ...n, x: -0 })) }),
      (c) => ({ ...c, nodes: c.nodes.map((n) => ({ ...n, label: undefined })) }),
      (c) => ({ edges: c.edges, nodes: c.nodes }) as SpatialCanvas,
    ]
    for (const variant of variants) {
      const { codec, reports } = switched(
        fakeCore({
          parseSpatial: (text) => {
            const r = parseSpatial(text)
            return r.ok ? { ok: true, value: variant(r.value) } : r
          },
        }),
        'differential',
      )
      codec.parseSpatial(TEXT)
      expect(reports.map((r) => r.kind)).toEqual(['differs'])
    }
  })

  it("compares a refusal by stage, message, each issue's path and code, and a refinement's words", () => {
    const schema = '{"nodes":7}'
    const reworded = (words: (code: string) => string) => (text: string) => {
      const r = parseSpatial(text)
      if (r.ok) return r
      const issues = r.error.issues.map((i) => ({ ...i, message: words(i.code) }))
      return { ok: false as const, error: { ...r.error, issues } }
    }
    const agree = switched(fakeCore({ parseSpatial: reworded(() => 'x') }), 'differential')
    agree.codec.parseSpatial(schema)
    expect(agree.reports).toEqual([])

    const moved = switched(
      fakeCore({
        parseSpatial: (text) => {
          const r = parseSpatial(text)
          if (r.ok) return r
          const issues = r.error.issues.map((i) => ({ ...i, path: ['elsewhere'] }))
          return { ok: false, error: { ...r.error, issues } }
        },
      }),
      'differential',
    )
    moved.codec.parseSpatial(schema)
    expect(moved.reports.map((r) => r.kind)).toEqual(['differs'])

    const message = switched(
      fakeCore({
        parseSpatial: (text) => {
          const r = parseSpatial(text)
          return r.ok ? r : { ok: false, error: { ...r.error, message: 'other' } }
        },
      }),
      'differential',
    )
    message.codec.parseSpatial('{')
    expect(message.reports.map((r) => r.kind)).toEqual(['differs'])
  })

  it('reports a different text from the writer, with the canvas and the mode', () => {
    const { codec, reports } = switched(
      fakeCore({ serializeSpatial: (canvas, mode) => `${serializeSpatial(canvas, mode)} ` }),
      'differential',
    )
    expect(codec.serializeSpatial(CANVAS, 'extended')).toBe(serializeSpatial(CANVAS, 'extended'))
    expect(reports).toMatchObject([
      { fn: 'serializeSpatial', kind: 'differs', canvas: CANVAS, mode: 'extended' },
    ])
  })

  describe("a core that refuses a canvas the strict mode's validation refuses", () => {
    it('throws it under rust as the ZodError the TypeScript throws, and reports no decline', () => {
      const { codec, reports } = switched(fakeCore({ serializeSpatial: invalid() }), 'rust')
      let thrown: unknown
      try {
        codec.serializeSpatial(CANVAS, 'strict')
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ZodError)
      expect((thrown as ZodError).issues).toEqual([
        { path: ['edges', 0, 'toNode'], code: 'custom', message: 'no such node' },
      ])
      expect(reports).toEqual([])
    })

    it('reports it under differential when the TypeScript writes the canvas', () => {
      const { codec, reports } = switched(fakeCore({ serializeSpatial: invalid() }), 'differential')
      expect(codec.serializeSpatial(CANVAS, 'strict')).toBe(serializeSpatial(CANVAS, 'strict'))
      expect(reports.map((r) => [r.fn, r.kind])).toEqual([['serializeSpatial', 'differs']])
    })

    it('treats a refusal of any other shape as a decline', () => {
      for (const issues of [null, 'no', [{ path: 'x', code: 'custom', message: 'm' }]]) {
        const { codec, reports } = switched(fakeCore({ serializeSpatial: invalid(issues) }), 'rust')
        expect(codec.serializeSpatial(CANVAS, 'strict')).toBe(serializeSpatial(CANVAS, 'strict'))
        expect(reports.map((r) => r.kind)).toEqual(['declined'])
      }
    })
  })
})
