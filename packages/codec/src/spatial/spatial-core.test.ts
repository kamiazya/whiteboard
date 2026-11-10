import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { installCoreForTests } from '../test-utils/core-setup/install.js'
import {
  installSpatialCore,
  parseSpatial,
  serializeSpatial,
  spatialCoreInstalled,
} from './spatial-core.js'

const CANVAS: SpatialCanvas = {
  nodes: [
    {
      id: 'a',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      resource: { mimeType: 'text/markdown', content: 'hi' },
    },
  ],
  edges: [],
} as unknown as SpatialCanvas
const TEXT =
  '{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":10,"height":10,"text":"hi"}],"edges":[]}'

const named = (name: string, extra: object = {}): Error =>
  Object.assign(new Error(`${name} thrown by the core`), { name }, extra)

/** A core whose every call throws `err`, standing for what the shim throws. */
const throwing = (err: Error) => ({
  parseSpatial: () => {
    throw err
  },
  serializeSpatial: () => {
    throw err
  },
})

const thrownBy = (call: () => unknown): unknown => {
  try {
    call()
  } catch (err) {
    return err
  }
  return undefined
}

describe('a realm with no core installed', () => {
  // The installation is process-global; the setup file's core is back for the next test.
  afterEach(() => installCoreForTests())

  it('refuses to read, and says what to do, rather than answering', () => {
    installSpatialCore(undefined)
    expect(spatialCoreInstalled()).toBe(false)
    expect(() => parseSpatial(TEXT)).toThrow(/before this realm installed the Rust core/)
    expect(() => parseSpatial(TEXT)).toThrow(/installSpatialCore/)
  })

  it('refuses to write', () => {
    installSpatialCore(undefined)
    expect(() => serializeSpatial(CANVAS, 'extended')).toThrow(
      /before this realm installed the Rust core/,
    )
  })
})

describe('the realm core', () => {
  beforeAll(() => installCoreForTests())
  afterEach(() => installCoreForTests())

  it('answers the plain exports through the installed core', () => {
    const answer = { ok: true as const, value: { nodes: [], edges: [] } }
    installSpatialCore({ parseSpatial: () => answer, serializeSpatial: () => 'from core' })
    expect(parseSpatial('anything')).toBe(answer)
    expect(serializeSpatial(CANVAS, 'strict')).toBe('from core')
  })

  it('reads and writes through the staged Rust core', () => {
    expect(spatialCoreInstalled()).toBe(true)
    const read = parseSpatial(TEXT)
    expect(read.ok && read.value).toMatchObject({
      nodes: [{ id: 'a', resource: { mimeType: 'text/markdown', content: 'hi' } }],
    })
    expect(JSON.parse(serializeSpatial(CANVAS, 'extended'))).toEqual(JSON.parse(TEXT))
  })

  it('reports a text the core declines as a refusal at the schema stage, with the core reason', () => {
    installSpatialCore(throwing(named('CoreInputRefused')))
    const read = parseSpatial(TEXT)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.stage).toBe('json-canvas-schema')
    expect(read.error.message).toMatch(/refused this document: CoreInputRefused thrown by the core/)
  })

  it('throws a ZodError at the root for a canvas the core declines to write', () => {
    installSpatialCore(throwing(named('CoreInputRefused')))
    const thrown = thrownBy(() => serializeSpatial(CANVAS, 'extended'))
    expect(thrown).toBeInstanceOf(ZodError)
    expect((thrown as ZodError).issues).toEqual([
      {
        code: 'custom',
        path: [],
        message: expect.stringContaining(
          'refused this canvas: CoreInputRefused thrown by the core',
        ),
      },
    ])
  })

  it("throws the core's strict-mode places as a ZodError", () => {
    const issues = [{ path: ['edges', 0, 'toNode'], code: 'custom', message: 'no such node' }]
    installSpatialCore(throwing(named('CoreSpatialInvalid', { issues })))
    const thrown = thrownBy(() => serializeSpatial(CANVAS, 'strict'))
    expect(thrown).toBeInstanceOf(ZodError)
    expect((thrown as ZodError).issues).toEqual(issues)
  })

  it('keeps an unrecognised throw loud, for a read and a write', () => {
    installSpatialCore(throwing(new RangeError('a defect')))
    expect(() => parseSpatial(TEXT)).toThrow(RangeError)
    expect(() => serializeSpatial(CANVAS, 'extended')).toThrow(RangeError)
  })

  it('does not take a strict-mode answer with malformed places for the Zod refusal', () => {
    installSpatialCore(throwing(named('CoreSpatialInvalid', { issues: [{ path: 'edges' }] })))
    expect(() => serializeSpatial(CANVAS, 'strict')).toThrow(/thrown by the core/)
    expect(() => serializeSpatial(CANVAS, 'strict')).not.toThrow(ZodError)
  })
})

describe('what the staged core cannot be sent, as a caller sees it', () => {
  beforeAll(() => installCoreForTests())

  const node = (id: string) =>
    `{"nodes":[{"id":"${id}","type":"group","x":0,"y":0,"width":1,"height":1}]}`

  it('refuses a text holding a lone surrogate, raw or escaped, and reads a paired one', () => {
    for (const lone of ['\ud800', '\udc00', 'a\ud800b']) {
      expect(parseSpatial(node(`a${lone}`))).toMatchObject({
        ok: false,
        error: { stage: 'json-canvas-schema', message: expect.stringContaining('lone-surrogate') },
      })
    }
    expect(parseSpatial(node('\\ud800'))).toMatchObject({ ok: false })
    expect(parseSpatial(node('\\ud83d\\ude00'))).toMatchObject({ ok: true })
  })

  it('refuses a text past 4 MiB whether its units or its bytes pass it, and reads one at it', () => {
    const tail = (n: number) => `{"nodes":[],"x-pad":"${'a'.repeat(n)}"}`
    const pad = 4 * 1024 * 1024 - tail(0).length
    expect(parseSpatial(tail(pad))).toMatchObject({ ok: true })
    for (const text of [tail(pad + 1), `{"nodes":[],"p":"${'€'.repeat(1_400_000)}"}`]) {
      expect(parseSpatial(text)).toMatchObject({
        ok: false,
        error: { stage: 'json-canvas-schema', message: expect.stringContaining('too-large') },
      })
    }
  })

  it('refuses nesting past the reader, wherever it sits', () => {
    const deep = `{"nodes":[],"x-whiteboard":{"facets":{"a.b/v0":${'['.repeat(80)}${']'.repeat(80)}}}}`
    expect(parseSpatial(deep)).toMatchObject({
      ok: false,
      error: { stage: 'json-canvas-schema', message: expect.stringContaining('too-deep') },
    })
  })

  it('reads a link to an IPv6, percent-encoded, international or file host, and refuses a bad one', () => {
    const link = (url: string) =>
      `{"nodes":[{"id":"a","type":"link","x":0,"y":0,"width":1,"height":1,"url":"${url}"}]}`
    for (const url of [
      'https://example.com/',
      'http://[::1]:8080/',
      'http://ex%41mple.com/',
      'https://bücher.example/',
      'https://xn--r8jz45g.jp/',
      'file:///C:/notes.md',
    ]) {
      expect(parseSpatial(link(url)), url).toMatchObject({ ok: true })
    }
    for (const url of ['http://[::1/', 'http://ex%20ample.com/']) {
      expect(parseSpatial(link(url)), url).toMatchObject({
        ok: false,
        error: {
          stage: 'json-canvas-schema',
          issues: [expect.objectContaining({ path: ['nodes', 0, 'url'], code: 'invalid_format' })],
        },
      })
    }
  })

  it('refuses to write a canvas the wire does not carry, and one JSON cannot spell', () => {
    class Odd {}
    const holder = (facet: unknown): SpatialCanvas =>
      ({ nodes: [], edges: [], facets: { 'a.b/v0': facet } }) as unknown as SpatialCanvas
    for (const facet of [new Odd(), '\ud800', [undefined], () => 1, 2n ** 60n]) {
      const thrown = thrownBy(() => serializeSpatial(holder(facet), 'extended'))
      expect(thrown, String(facet)).toBeInstanceOf(ZodError)
      expect((thrown as ZodError).issues[0]?.message).toContain('refused this canvas')
    }
  })

  it('refuses a strict write that is no JSON Canvas 1.0 document, naming the place', () => {
    const dangling = {
      nodes: [],
      edges: [{ id: 'e', from: { node: 'missing' }, to: { node: 'missing' } }],
    } as unknown as SpatialCanvas
    const thrown = thrownBy(() => serializeSpatial(dangling, 'strict'))
    expect(thrown).toBeInstanceOf(ZodError)
    expect((thrown as ZodError).issues.length).toBeGreaterThan(0)
    expect(() => serializeSpatial(dangling, 'extended')).not.toThrow()
  })
})
