import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Core, CoreInputRefused, CoreSpatialInvalid } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { Dice, mulberry32 } from '../test-utils/frontmatter-oracle/corpus.js'
import { generatedText } from '../test-utils/json-canvas-oracle/corpus.js'
import { modelCanvas } from '../test-utils/json-canvas-oracle/model.js'
import {
  canvasOf,
  decodeRecording,
  type ReaderCase,
  type WriterCase,
} from '../test-utils/json-canvas-oracle/oracle.js'
import { shapeOf } from '../test-utils/shape-of.js'
import { readDeclineEarned, writeDeclineEarned } from '../test-utils/spatial-wasm/earned.js'
import { parseSpatial } from './parse.js'
import { serializeSpatial } from './serialize.js'

/**
 * The JSON Canvas codec held to its Rust twin through the built wasm artifact
 * (ADR-0054 step 6, QR-21 layer 2): the TypeScript is the oracle, the answer of
 * `Core.parseSpatial` and `Core.serializeSpatial` must equal it exactly, over
 * the recorded corpus and over generated texts and canvases.
 *
 * What is held equal: the canvas (every number by its 64 bits, every object in
 * the order JavaScript enumerates it), a refusal's stage and its message where
 * the TypeScript's words are reproduced, each schema issue's path and code, and
 * the text a write produces byte for byte. What is not: the words of a Zod
 * issue, which the core names by its code; a refinement the schema states in
 * code carries its text and is held equal.
 *
 * A call the shim declines (`CoreInputRefused`) is what a root answers from the
 * TypeScript; each is allowed only where its class holds for the input, judged
 * without the core (`earned.ts`), and counted.
 */

// Built, not committed: `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm`.
const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
let core: Core
beforeAll(async () => {
  core = await loadCore(readFileSync(artifact))
})

const reach = {
  read: 0,
  syntax: 0,
  conversation: 0,
  schema: 0,
  custom: 0,
  written: 0,
  invalid: 0,
  readDeclined: {} as Record<string, number>,
  writeDeclined: {} as Record<string, number>,
  threw: 0,
}

type Answer<T> =
  | { answered: T }
  | { refused: string; detail: string | undefined }
  | { invalid: { path: PropertyKey[]; code: string; message: string }[] }

function asked<T>(call: () => T): Answer<T> {
  try {
    return { answered: call() }
  } catch (error) {
    if (error instanceof CoreInputRefused) return { refused: error.code, detail: error.detail }
    if (error instanceof CoreSpatialInvalid) return { invalid: [...error.issues] }
    throw error
  }
}

/** A canvas as text, with the keys that hold `undefined` visible. */
const show = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (v === undefined ? '<undefined>' : v)).slice(0, 1500)

const identity = (issues: readonly { path: PropertyKey[]; code: string }[]) =>
  issues.map((issue) => ({ path: issue.path, code: issue.code }))

const tally = (counts: Record<string, number>, key: string | undefined): void => {
  counts[key ?? '?'] = (counts[key ?? '?'] ?? 0) + 1
}

type ParsedTs = ReturnType<typeof parseSpatial>

function expectRefusalsAgree(
  rust: Extract<ReturnType<Core['parseSpatial']>, { ok: false }>,
  ts: Extract<ParsedTs, { ok: false }>,
  text: string,
): void {
  const where = text.slice(0, 2000)
  expect(rust.error.stage, where).toBe(ts.error.stage)
  expect(rust.error.message, where).toBe(ts.error.message)
  expect(identity(rust.error.issues), where).toEqual(identity(ts.error.issues))
  // A refinement the schema states in code carries its text, and is held equal.
  const worded = ts.error.issues.flatMap((issue, at) =>
    issue.code === 'custom' ? [[issue.message, rust.error.issues[at]?.message]] : [],
  )
  for (const [expected, got] of worded) expect(got).toBe(expected)
  reach.custom += worded.length
}

/** The wasm answer for `text` equals the TypeScript's, or is a decline the text earns. */
function expectReadsAgree(text: string): void {
  const rust = asked(() => core.parseSpatial(text))
  if ('refused' in rust) {
    expect(readDeclineEarned(rust.detail ?? '', text), `declined as ${rust.detail}`).toBe(true)
    tally(reach.readDeclined, rust.detail)
    return
  }
  expect(rust, text).toHaveProperty('answered')
  const answer = (rust as { answered: ReturnType<Core['parseSpatial']> }).answered
  const ts = parseSpatial(text)
  expect(answer.ok, text).toBe(ts.ok)
  if (answer.ok && ts.ok) {
    expect(shapeOf(answer.value), text).toEqual(shapeOf(ts.value))
    // Assignable to the TypeScript's own result, which is what lets codec's switch return it.
    const assignable: SpatialCanvas = answer.value
    expect(assignable).toBe(answer.value)
    reach.read++
  } else if (!answer.ok && !ts.ok) {
    expectRefusalsAgree(answer, ts, text)
    if (ts.error.stage === 'json-syntax') reach.syntax++
    else if (ts.error.message.startsWith('this file carries')) reach.conversation++
    else reach.schema++
  }
}

type WrittenTs = { text: string } | { zod: ZodError } | { threw: unknown }

function writtenByTs(canvas: SpatialCanvas, mode: 'strict' | 'extended'): WrittenTs {
  try {
    return { text: serializeSpatial(canvas, mode) }
  } catch (error) {
    return error instanceof ZodError ? { zod: error } : { threw: error }
  }
}

function expectWritesAgree(canvas: SpatialCanvas, mode: 'strict' | 'extended'): void {
  const ts = writtenByTs(canvas, mode)
  const rust = asked(() => core.serializeSpatial(canvas, mode))
  if ('refused' in rust) {
    expect(
      writeDeclineEarned(rust.detail ?? '', canvas),
      `declined as ${rust.detail}: ${show(canvas)}`,
    ).toBe(true)
    tally(reach.writeDeclined, rust.detail)
  } else if ('text' in ts) {
    expect(rust).toEqual({ answered: ts.text })
    reach.written++
  } else if ('zod' in ts) {
    expect(rust, 'a canvas the strict mode refuses').toHaveProperty('invalid')
    const got = (rust as { invalid: { path: PropertyKey[]; code: string; message: string }[] })
      .invalid
    expect(identity(got)).toEqual(identity(ts.zod.issues))
    ts.zod.issues.forEach((issue, at) => {
      if (issue.code === 'custom') expect(got[at]?.message).toBe(issue.message)
    })
    reach.invalid++
  } else {
    // The TypeScript threw something that is no refusal (a bigint it cannot
    // stringify), and the core answered nothing: it declined.
    expect.unreachable(
      `the core answered a canvas the TypeScript could not write: ${String(ts.threw)}`,
    )
  }
}

const hasThrown = (canvas: SpatialCanvas, mode: 'strict' | 'extended'): boolean =>
  'threw' in writtenByTs(canvas, mode)

describe('the recorded corpus through the wasm', () => {
  const recorded = decodeRecording(
    readFileSync(new URL('./oracle/json-canvas.jsonl', import.meta.url), 'utf8'),
  )

  it('reads every recorded text as the TypeScript does', () => {
    const texts = recorded.filter((c): c is ReaderCase => c.k === 'r').map((c) => c.t)
    expect(texts.length).toBeGreaterThan(1300)
    for (const text of texts) expectReadsAgree(text)
  })

  it('writes every recorded canvas as the TypeScript does, in the mode it was recorded in', () => {
    const cases = recorded.filter((c): c is WriterCase => c.k === 'w')
    expect(cases.length).toBeGreaterThan(550)
    for (const c of cases) expectWritesAgree(canvasOf(c.c), c.m)
  })
})

describe('the shim declines what the artifact cannot be sent', () => {
  it('declines a text holding a lone surrogate, raw or escaped, and reads a paired one', () => {
    for (const lone of ['\ud800', '\udc00', 'a\ud800b']) {
      const raw = `{"nodes":[{"id":"a${lone}","type":"group","x":0,"y":0,"width":1,"height":1}]}`
      expect(asked(() => core.parseSpatial(raw))).toEqual({
        refused: 'malformed',
        detail: 'lone-surrogate',
      })
      expect(parseSpatial(raw)).toMatchObject({ ok: true })
    }
    const escaped = '{"nodes":[{"id":"\\ud800","type":"group","x":0,"y":0,"width":1,"height":1}]}'
    expect(asked(() => core.parseSpatial(escaped))).toEqual({
      refused: 'malformed',
      detail: 'lone-surrogate',
    })
    const paired =
      '{"nodes":[{"id":"\\ud83d\\ude00","type":"group","x":0,"y":0,"width":1,"height":1}]}'
    expect(asked(() => core.parseSpatial(paired))).toHaveProperty('answered')
  })

  it('declines a text past the cap whether its units or its bytes pass it, and reads one at it', () => {
    const tail = (n: number) => `{"nodes":[],"x-pad":"${'a'.repeat(n)}"}`
    const pad = 4 * 1024 * 1024 - tail(0).length
    expect(asked(() => core.parseSpatial(tail(pad)))).toHaveProperty('answered')
    for (const text of [tail(pad + 1), `{"nodes":[],"p":"${'€'.repeat(1_400_000)}"}`]) {
      expect(asked(() => core.parseSpatial(text))).toMatchObject({ refused: 'input-too-large' })
    }
  })

  it('declines nesting past the reader, wherever it sits', () => {
    const deep = `{"nodes":[],"x-whiteboard":{"facets":{"a.b/v0":${'['.repeat(80)}${']'.repeat(80)}}}}`
    expect(asked(() => core.parseSpatial(deep))).toEqual({
      refused: 'malformed',
      detail: 'too-deep',
    })
    expect(parseSpatial(deep)).toMatchObject({ ok: true })
  })

  it('declines a canvas the wire does not carry, and one the writer cannot spell', () => {
    class Odd {}
    const holder = (facet: unknown): SpatialCanvas =>
      ({ nodes: [], edges: [], facets: { 'a.b/v0': facet } }) as unknown as SpatialCanvas
    for (const facet of [new Odd(), '\ud800', [undefined], () => 1]) {
      expect(asked(() => core.serializeSpatial(holder(facet), 'extended'))).toEqual({
        refused: 'malformed',
        detail: 'wire',
      })
    }
    expect(asked(() => core.serializeSpatial(holder(2n ** 60n), 'extended'))).toEqual({
      refused: 'malformed',
      detail: 'unwritable',
    })
    expect(hasThrown(holder(2n ** 60n), 'extended')).toBe(true)
  })

  it('writes a canvas with a field set to undefined as the TypeScript does', () => {
    const canvas = {
      nodes: [{ id: 'a', x: 0, y: 0, width: 1, height: 1, label: undefined, color: undefined }],
      edges: [],
      lines: undefined,
    } as unknown as SpatialCanvas
    const before = reach.written
    for (const mode of ['strict', 'extended'] as const) expectWritesAgree(canvas, mode)
    expect(reach.written).toBeGreaterThan(before)
  })
})

const seeds = fc.integer({ min: 0, max: 2 ** 32 - 1 })

/** Optional fields a canvas built elsewhere holds as `undefined`. */
const OPTIONAL = ['color', 'label', 'tags', 'facets', 'embed', 'resource', 'bends', 'side', 'end']

/** `value` with some of its objects holding an optional field as `undefined`. */
function withUndefined(d: Dice, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => withUndefined(d, item))
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value).map(([k, v]) => [k, withUndefined(d, v)] as const)
  const extra = OPTIONAL.filter((k) => !(k in value) && d.chance(0.15)).map((k) => [k, undefined])
  return Object.fromEntries([...entries, ...extra])
}

describe('generated texts and canvases through the wasm', () => {
  fcTest.prop([seeds], withDefaults({ numRuns: 1500 }))(
    'a generated text is read as the TypeScript reads it',
    (seed) => {
      expectReadsAgree(generatedText(new Dice(mulberry32(seed))))
    },
  )

  fcTest.prop([seeds], withDefaults({ numRuns: 1000 }))(
    'a generated canvas is written as the TypeScript writes it, in both modes',
    (seed) => {
      const d = new Dice(mulberry32(seed))
      const canvas = modelCanvas(d)
      const held = (d.chance(0.4) ? withUndefined(d, canvas) : canvas) as SpatialCanvas
      for (const mode of ['strict', 'extended'] as const) expectWritesAgree(held, mode)
    },
  )

  fcTest.prop([spatialCanvasArbitrary], withDefaults({ numRuns: 400 }))(
    'a canvas the model draws is written as the TypeScript writes it, and reads back as itself',
    (canvas) => {
      for (const mode of ['strict', 'extended'] as const) expectWritesAgree(canvas, mode)
      const text = serializeSpatial(canvas, 'extended')
      expectReadsAgree(text)
    },
  )

  it('reached every outcome the properties and the corpus are meant to compare', () => {
    // A comparison over one outcome passes for any subject, so say what was reached.
    // Floors at about half of what four runs reached.
    expect(reach.read).toBeGreaterThan(1000)
    expect(reach.syntax).toBeGreaterThan(120)
    expect(reach.conversation).toBeGreaterThan(3)
    expect(reach.schema).toBeGreaterThan(400)
    expect(reach.custom).toBeGreaterThan(130)
    expect(reach.written).toBeGreaterThan(1200)
    expect(reach.invalid).toBeGreaterThan(270)
    expect(reach.readDeclined['lone-surrogate']).toBeGreaterThan(20)
    expect(reach.readDeclined.url).toBeGreaterThan(30)
    expect(reach.readDeclined['too-deep']).toBeGreaterThan(0)
    expect(reach.writeDeclined.url).toBeGreaterThan(18)
  })
})
