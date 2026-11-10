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
import { shapeOf } from '../test-utils/shape-of.js'
import { messageTolerated, OKF_TOLERATED_DIFFERENCES } from './okf-core.js'
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
 * A call the shim declines (`CoreInputRefused`) is what a root answers from
 * the TypeScript; each is allowed only where its reason holds, and counted. A
 * value with no YAML spelling is no decline: `CoreOkfUnwritable` names the
 * places, and they must be the TypeScript's, in its order and words.
 */

// Built, not committed: `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm`.
const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
let core: Core
beforeAll(async () => {
  core = await loadCore(readFileSync(artifact))
})

type ParsedOkf = ReturnType<Core['parseOkf']>

const reach = {
  read: 0,
  yaml: 0,
  messageDiffered: 0,
  noFence: 0,
  reserved: 0,
  schema: 0,
  loneSurrogate: 0,
  written: 0,
  unwritable: 0,
  declined: 0,
}

type Answer<T> =
  | { answered: T }
  | { refused: string }
  | { unwritable: { path: PropertyKey[]; message: string }[] }

const placeOf = ({ path, message }: { path: PropertyKey[]; message: string }) => ({ path, message })

function asked<T>(call: () => T): Answer<T> {
  try {
    return { answered: call() }
  } catch (error) {
    if (error instanceof CoreInputRefused) return { refused: error.code }
    if (error instanceof CoreOkfUnwritable) return { unwritable: [...error.issues].map(placeOf) }
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
  if (messageTolerated(ts.error.stage)) {
    expect(rust.error.message).toMatch(/^malformed YAML frontmatter: /)
    expect(ts.error.message).toMatch(/^malformed YAML frontmatter: /)
    if (rust.error.message !== ts.error.message) reach.messageDiffered++
  } else {
    expect(rust.error.message).toBe(ts.error.message)
  }
}

/** The wasm answer for `text` equals the TypeScript's, or is a refusal the text earns. */
function expectReadsAgree(text: string): void {
  const rust = asked(() => core.parseOkf(text))
  // A lone surrogate in the head is judged as the TypeScript judges it; in the
  // body it is kept.
  if (!isWellFormed(text)) reach.loneSurrogate++
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
  let ts: string | OkfNotYamlSafeError
  try {
    ts = serializeOkf(doc)
  } catch (error) {
    if (!(error instanceof OkfNotYamlSafeError)) throw error
    ts = error
  }
  const rust = asked(() => core.serializeOkf(doc))
  if (typeof ts !== 'string') {
    // The value has no YAML spelling, and the core names each place the TypeScript does.
    expect(rust, 'a document the TypeScript refuses').toEqual({
      unwritable: ts.issues.map(placeOf),
    })
    reach.unwritable++
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
  const fence = '---\n'
  const framed = (frontmatter: string) => `${fence}type: x\n${frontmatter}\n---\n`

  it('declines a head past the cap whether its units or its bytes pass it', () => {
    // 3 bytes a unit: under the cap in units, over it in bytes.
    const euros = framed(`description: ${'€'.repeat(100_000)}`)
    expect(euros.length).toBeLessThan(262_144)
    expect(asked(() => core.parseOkf(euros))).toEqual({ refused: 'input-too-large' })
    const plain = framed(`description: ${'a'.repeat(262_144)}`)
    expect(asked(() => core.parseOkf(plain))).toEqual({ refused: 'input-too-large' })
    const fits = framed(`description: ${'a'.repeat(262_144 - framed('description: ').length)}`)
    expect(asked(() => core.parseOkf(fits))).toHaveProperty('answered')
  })

  it('reads a body of any size, because the body never crosses', () => {
    const head = framed('')
    for (const body of ['a'.repeat(262_144), '€'.repeat(100_000), 'a'.repeat(5_000_000)]) {
      const answer = asked(() => core.parseOkf(head + body))
      expect(answer).toMatchObject({ answered: { ok: true, value: { body } } })
    }
  })

  it('reads a body holding a lone surrogate as the TypeScript does, which keeps it', () => {
    const text = '---\ntype: x\n---\n\ud800'
    expect(asked(() => core.parseOkf(text))).toMatchObject({
      answered: { ok: true, value: { body: '\ud800' } },
    })
    expect(parseOkf(text)).toMatchObject({ ok: true })
  })

  it('refuses a lone surrogate in the frontmatter at stage yaml, and ignores one in a comment', () => {
    for (const lone of ['\ud800', '\udc00', 'a\ud800b']) {
      const inValue = `${fence}type: x\nk: ${lone}\n---\n`
      const inKey = `${fence}type: x\n${lone}: 1\n---\n`
      const inQuotes = `${fence}type: x\nk: "${lone}"\n---\n`
      const inBlock = `${fence}type: x\nk: |\n  ${lone}\n---\n`
      for (const text of [inValue, inKey, inQuotes, inBlock]) {
        const rust = asked(() => core.parseOkf(text))
        expect(rust, JSON.stringify(text)).toMatchObject({
          answered: { ok: false, error: { stage: 'yaml' } },
        })
        expect(parseOkf(text)).toMatchObject({ ok: false, error: { stage: 'yaml' } })
      }
      const inComment = `${fence}type: x # ${lone}\n---\nbody`
      expect(asked(() => core.parseOkf(inComment))).toMatchObject({ answered: { ok: true } })
      expect(parseOkf(inComment)).toMatchObject({ ok: true })
    }
  })

  it('reads a frontmatter that holds the character it marks a lone surrogate with', () => {
    const text = '---\ntype: "\\uE000 \ue000 \ud800"\n---\n'
    expect(asked(() => core.parseOkf(text))).toMatchObject({
      answered: { ok: false, error: { stage: 'yaml' } },
    })
    const kept = '---\ntype: "\\uE000 \ue000 \ue001"\nk: # \ud800\n---\n'
    expect(asked(() => core.parseOkf(kept))).toMatchObject({ answered: { ok: true } })
    expect(parseOkf(kept)).toMatchObject({ ok: true })
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
    // The other side of OKF_TOLERATED_DIFFERENCES' one entry: the case it
    // tolerates still differs, so the entry is still needed.
    expect(Object.keys(OKF_TOLERATED_DIFFERENCES)).toEqual(['yaml-refusal-message'])
    expect(reach.messageDiffered).toBeGreaterThan(300)
    expect(reach.noFence).toBeGreaterThan(200)
    expect(reach.reserved).toBeGreaterThan(50)
    expect(reach.schema).toBeGreaterThan(700)
    expect(reach.loneSurrogate).toBeGreaterThan(80)
    expect(reach.written).toBeGreaterThan(1200)
    expect(reach.unwritable).toBeGreaterThan(350)
    expect(reach.declined).toBeGreaterThan(350)
  })
})
