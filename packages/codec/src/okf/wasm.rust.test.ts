import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Core, CoreInputRefused, CoreOkfUnwritable } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { beforeAll, describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { Dice, mulberry32 } from '../test-utils/frontmatter-oracle/corpus.js'
import { decode, encode } from '../test-utils/frontmatter-oracle/oracle.js'
import { generatedText, unsafeDocument, validDocument } from '../test-utils/okf-oracle/corpus.js'
import { decodeRecording, textFrom } from '../test-utils/okf-oracle/oracle.js'
import { parseOkf } from './parse.js'
import type { OkfMarkdownDocument } from './schema.js'
import { OkfNotYamlSafeError, serializeOkf } from './serialize.js'

/**
 * The OKF envelope held to its Rust twin through the built wasm artifact
 * (ADR-0054 step 6, QR-21 layer 2): the TypeScript is the oracle, the answer
 * of `Core.parseOkf` and `Core.serializeOkf` must equal it exactly, over the
 * recorded corpus and over generated texts and documents.
 *
 * What is held equal: the document (every value by its 64 bits, every
 * mapping in the order JavaScript enumerates it, the body verbatim), the
 * stage of a refusal and each schema issue's path and code. What differs by
 * decision is message text: the Rust side words a YAML refusal by its class
 * (the `yaml` package's message is not reproduced) and a schema issue by its
 * code; the other three refusals carry the TypeScript's own words.
 *
 * A call the shim declines (`CoreInputRefused`, or `CoreOkfUnwritable` for a
 * value with no YAML spelling) is what a root answers from the TypeScript;
 * each is allowed only where its reason holds, and counted.
 */

// Built, not committed: `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm`.
const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
let core: Core
beforeAll(async () => {
  core = await loadCore(readFileSync(artifact))
})

/**
 * Everything `toStrictEqual` would look at, spelled out: that matcher compares
 * a `constructor` property by identity, so it calls two equal documents
 * different when a facet is named `constructor`.
 */
function shapeOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const proto = Object.getPrototypeOf(value)
  return {
    proto:
      proto === null
        ? 'null'
        : proto === Object.prototype
          ? 'Object'
          : proto === Array.prototype
            ? 'Array'
            : 'other',
    keys: Reflect.ownKeys(value),
    values: Reflect.ownKeys(value).map((key) =>
      shapeOf((value as Record<PropertyKey, unknown>)[key]),
    ),
  }
}

type ParsedOkf = ReturnType<Core['parseOkf']>

const reach = {
  read: 0,
  yaml: 0,
  noFence: 0,
  reserved: 0,
  schema: 0,
  loneSurrogate: 0,
  written: 0,
  unwritable: 0,
  unwritableByRust: 0,
  declined: 0,
}

type Answer<T> = { answered: T } | { refused: string } | { unwritable: string }

function asked<T>(call: () => T): Answer<T> {
  try {
    return { answered: call() }
  } catch (error) {
    if (error instanceof CoreInputRefused) return { refused: error.code }
    if (error instanceof CoreOkfUnwritable) return { unwritable: error.reason }
    throw error
  }
}

const isWellFormed = (text: string): boolean => text.isWellFormed()

const issueKeys = (issues: readonly { path: PropertyKey[]; code: string }[]) =>
  issues.map((issue) => ({ path: issue.path, code: issue.code }))

function expectRefusalsAgree(
  rust: Extract<ParsedOkf, { ok: false }>,
  ts: Extract<ReturnType<typeof parseOkf>, { ok: false }>,
): void {
  expect(rust.error.stage).toBe(ts.error.stage)
  expect(issueKeys(rust.error.issues)).toEqual(issueKeys(ts.error.issues))
  if (ts.error.stage === 'yaml') {
    expect(rust.error.message).toMatch(/^malformed YAML frontmatter: /)
    expect(ts.error.message).toMatch(/^malformed YAML frontmatter: /)
  } else {
    expect(rust.error.message).toBe(ts.error.message)
  }
}

/** The wasm answer for `text` equals the TypeScript's, or is a refusal the text earns. */
function expectReadsAgree(text: string): void {
  const rust = asked(() => core.parseOkf(text))
  if (!isWellFormed(text)) {
    // A lone surrogate would cross as U+FFFD: the shim must not send it.
    expect(rust).toEqual({ refused: 'malformed' })
    reach.loneSurrogate++
    return
  }
  expect(rust, text).toHaveProperty('answered')
  const answer = (rust as { answered: ParsedOkf }).answered
  const ts = parseOkf(text)
  expect(answer.ok, text).toBe(ts.ok)
  if (answer.ok && ts.ok) {
    expect(encode(answer.value.frontmatter), text).toEqual(encode(ts.value.frontmatter))
    expect(answer.value.body).toBe(ts.value.body)
    // The shape the TypeScript gives: prototypes, own keys, and no undefined field.
    expect(shapeOf(answer.value), text).toEqual(shapeOf(ts.value))
    // Assignable to the TypeScript's own document type, which is what lets codec's switch return it.
    const assignable: OkfMarkdownDocument = answer.value
    expect(assignable).toBe(answer.value)
    reach.read++
  } else if (!answer.ok && !ts.ok) {
    expectRefusalsAgree(answer, ts)
    if (ts.error.stage === 'yaml') reach.yaml++
    else if (ts.error.message.startsWith('document does not start')) reach.noFence++
    else if (ts.error.message.startsWith('frontmatter holds')) reach.reserved++
    else reach.schema++
  }
}

const ORDER = [
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'view',
  'generated',
  'verified',
  'facets',
  'facetsRaw',
]
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isIndexKey = (key: string): boolean => /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === 'string')

function isEvent(v: unknown): boolean {
  if (!isRecord(v)) return false
  const named = Object.keys(v).filter((key) => !isIndexKey(key))
  return (
    named[0] === 'by' && named[1] === 'at' && typeof v.by === 'string' && typeof v.at === 'string'
  )
}

/** Whether the wire carries a frontmatter: the schema's keys in the schema's order, each of its kind. */
function carried(frontmatter: Record<string, unknown>): boolean {
  const keys = Object.keys(frontmatter)
  const places = keys.map((key) => ORDER.indexOf(key))
  if (places.includes(-1) || places.some((at, i) => i > 0 && at <= (places[i - 1] as number))) {
    return false
  }
  const kind: Record<string, (v: unknown) => boolean> = {
    type: (v) => typeof v === 'string',
    title: (v) => typeof v === 'string',
    description: (v) => typeof v === 'string',
    resource: (v) => typeof v === 'string',
    view: (v) => typeof v === 'string',
    tags: isStrings,
    generated: isEvent,
    verified: (v) => Array.isArray(v) && v.every(isEvent),
    facets: isRecord,
    facetsRaw: isRecord,
  }
  return keys[0] === 'type' && keys.every((key) => kind[key]?.(frontmatter[key]))
}

function expectWritesAgree(doc: OkfMarkdownDocument): void {
  let ts: string | 'unsafe'
  try {
    ts = serializeOkf(doc)
  } catch (error) {
    if (!(error instanceof OkfNotYamlSafeError)) throw error
    ts = 'unsafe'
  }
  const rust = asked(() => core.serializeOkf(doc))
  if (ts === 'unsafe') {
    // The value has no YAML spelling: the artifact says so, or the wire never carried it.
    expect('answered' in rust, 'a document the TypeScript refuses was written').toBe(false)
    reach.unwritable++
    if ('unwritable' in rust) reach.unwritableByRust++
  } else if ('refused' in rust) {
    // Declined only for a frontmatter the wire does not carry.
    expect(rust).toEqual({ refused: 'malformed' })
    expect(
      carried(doc.frontmatter as Record<string, unknown>),
      'declined a document it carries',
    ).toBe(false)
    reach.declined++
  } else {
    expect(rust).toEqual({ answered: ts })
    reach.written++
  }
}

describe('the recorded corpus through the wasm', () => {
  const recorded = decodeRecording(
    readFileSync(new URL('./oracle/okf.jsonl', import.meta.url), 'utf8'),
  )

  it('reads every recorded text as the TypeScript does', () => {
    const texts = recorded.flatMap((c) => (c.k === 'r' ? [textFrom(c)] : []))
    expect(texts.length).toBeGreaterThan(1100)
    for (const text of texts) expectReadsAgree(text)
  })

  it('writes every recorded document as the TypeScript does', () => {
    const docs = recorded.flatMap((c) => (c.k === 'w' ? [decode(c.d) as OkfMarkdownDocument] : []))
    expect(docs.length).toBeGreaterThan(450)
    for (const doc of docs) expectWritesAgree(doc)
  })
})

describe('the shim declines what the artifact cannot be sent', () => {
  it('declines a text past the cap whether its units or its bytes pass it', () => {
    const head = '---\ntype: x\n---\n'
    // 3 bytes a unit: under the cap in units, over it in bytes.
    expect(asked(() => core.parseOkf(head + '€'.repeat(100_000)))).toEqual({
      refused: 'input-too-large',
    })
    expect(asked(() => core.parseOkf(head + 'a'.repeat(262_144)))).toEqual({
      refused: 'input-too-large',
    })
    expect(asked(() => core.parseOkf(head + 'a'.repeat(262_144 - head.length)))).toHaveProperty(
      'answered',
    )
  })

  it('answers a body holding a lone surrogate from the TypeScript, which keeps it', () => {
    expect(asked(() => core.parseOkf('---\ntype: x\n---\n\ud800'))).toEqual({
      refused: 'malformed',
    })
    expect(parseOkf('---\ntype: x\n---\n\ud800')).toMatchObject({ ok: true })
  })

  it('keeps a body verbatim whatever it holds, because it never crosses', () => {
    const body = '\ud800 \u0000 \r\n  --- ﻿'
    const doc = { frontmatter: { type: 'x' }, body } as OkfMarkdownDocument
    expect(core.serializeOkf(doc)).toBe(`---\ntype: x\n---\n${body}`)
    expect(core.serializeOkf(doc)).toBe(serializeOkf(doc))
  })
})

const seeds = fc.integer({ min: 0, max: 2 ** 32 - 1 })

describe('generated texts and documents through the wasm', () => {
  fcTest.prop([seeds], withDefaults({ numRuns: 1500 }))(
    'a generated text is read as the TypeScript reads it',
    (seed) => {
      expectReadsAgree(generatedText(new Dice(mulberry32(seed)), []))
    },
  )

  fcTest.prop([seeds], withDefaults({ numRuns: 1500 }))(
    'a generated document is written as the TypeScript writes it',
    (seed) => {
      const d = new Dice(mulberry32(seed))
      expectWritesAgree(d.chance(0.3) ? unsafeDocument(d) : validDocument(d))
    },
  )

  fcTest.prop([seeds], withDefaults({ numRuns: 600 }))(
    'a document in any key order is written as the TypeScript writes it, or declined',
    (seed) => {
      const d = new Dice(mulberry32(seed))
      const { frontmatter, body } = validDocument(d)
      const entries: [string, unknown][] = Object.entries(frontmatter)
      for (let i = entries.length - 1; i > 0; i--) {
        const j = d.int(i + 1)
        ;[entries[i], entries[j]] = [
          entries[j] as [string, unknown],
          entries[i] as [string, unknown],
        ]
      }
      expectWritesAgree({ frontmatter: Object.fromEntries(entries), body } as OkfMarkdownDocument)
    },
  )

  it('reached every outcome the properties and the corpus are meant to compare', () => {
    // A comparison over one outcome passes for any subject, so say what was reached.
    expect(reach.read).toBeGreaterThan(600)
    expect(reach.yaml).toBeGreaterThan(300)
    expect(reach.noFence).toBeGreaterThan(200)
    expect(reach.reserved).toBeGreaterThan(50)
    expect(reach.schema).toBeGreaterThan(700)
    expect(reach.loneSurrogate).toBeGreaterThan(80)
    expect(reach.written).toBeGreaterThan(1200)
    expect(reach.unwritable).toBeGreaterThan(350)
    expect(reach.unwritableByRust).toBeGreaterThan(150)
    expect(reach.declined).toBeGreaterThan(350)
  })
})
