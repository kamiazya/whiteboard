import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Core } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { beforeAll, describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { type OkfMismatch, okfCodec } from './okf-core.js'
import type { OkfMarkdownDocument } from './schema.js'
import { OkfNotYamlSafeError, serializeOkf as serializeOkfTs } from './serialize.js'

/**
 * A frontmatter holding several values with no YAML spelling, of every kind a
 * host can hold, in documents of any shape. The core must name each place the
 * TypeScript names, in its order and words, whether the artifact sees the value
 * (a number, a byte-order mark, a reserved key), only the shim does (a lone
 * surrogate, an `undefined`, a function, a class instance, a hole), or the
 * document is not one the wire carries. `differential` holds the two equal,
 * and reports any difference.
 */
const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
let core: Core
beforeAll(async () => {
  core = await loadCore(readFileSync(artifact))
})

const hole = (items: unknown[]): unknown[] => {
  const holey = [...items]
  holey.length += 1
  return holey
}

const leaf = fc.oneof(
  { weight: 5, arbitrary: fc.oneof(fc.string({ maxLength: 4 }), fc.integer(), fc.boolean()) },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: fc.constantFrom(Number.NaN, Infinity, -Infinity, 10n ** 20n) },
  { weight: 3, arbitrary: fc.constantFrom('a﻿b', '\ud800', 'x\udc00y', '﻿') },
  {
    weight: 2,
    arbitrary: fc.constantFrom(undefined, () => 1, Symbol('s'), new Date(0), new Map(), new Set()),
  },
)

const key = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('a', 'b', 'c', '0', '1', '10', 'z') },
  { weight: 2, arbitrary: fc.constantFrom('k﻿', '\ud800', '\udc00x', '__proto__') },
  { weight: 1, arbitrary: fc.string({ maxLength: 3 }) },
)

const value: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', maxDepth: 4 },
    leaf,
    fc.array(tie('node'), { maxLength: 3 }),
    fc.array(tie('node'), { maxLength: 3 }).map(hole),
    fc
      .array(fc.tuple(key, tie('node')), { maxLength: 3 })
      .map((entries) => Object.fromEntries(entries)),
  ),
})).node

const frontmatter = fc
  .record(
    {
      title: value,
      facets: fc.dictionary(fc.constantFrom('a.b/v1', 'c.d/v2', 'a.b/v0'), value, { maxKeys: 3 }),
      facetsRaw: fc.dictionary(key, value, { maxKeys: 3 }),
    },
    { requiredKeys: [] },
  )
  .map((rest) => ({ type: 'note', ...rest }) as unknown as OkfMarkdownDocument['frontmatter'])

const tally = { unsafe: 0, several: 0, written: 0, declined: 0 }

function expectSameAsTypeScript(doc: OkfMarkdownDocument): void {
  const reports: OkfMismatch[] = []
  const codec = okfCodec({
    okf: core,
    impl: { parseOkf: 'ts', serializeOkf: 'differential' },
    onMismatch: (m) => reports.push(m),
  })
  let threw: unknown
  let written: string | undefined
  try {
    written = codec.serializeOkf(doc)
  } catch (err) {
    threw = err
  }
  expect(
    reports.filter((r) => r.kind === 'differs'),
    'the core named other places than the TypeScript, or wrote other text',
  ).toEqual([])
  if (threw instanceof OkfNotYamlSafeError) {
    tally.unsafe++
    if (threw.issues.length > 1) tally.several++
    // A refusal the core made itself, not the TypeScript answering for it.
    expect(reports, 'the core declined a document the TypeScript refuses').toEqual([])
  } else if (written !== undefined) {
    // Only a document the TypeScript writes may be declined: one the wire does not carry.
    if (reports.length > 0) tally.declined++
    else tally.written++
    expect(written).toBe(serializeOkfTs(doc))
  } else {
    throw threw
  }
}

describe('a frontmatter with values that have no YAML spelling, through the core', () => {
  fcTest.prop(
    [fc.record({ frontmatter, body: fc.constantFrom('', 'body\n') })],
    withDefaults({ numRuns: 1500 }),
  )('names the places the TypeScript names, in its order and words', (doc) => {
    expectSameAsTypeScript(doc as OkfMarkdownDocument)
  })

  it('reached refusals of several places, writes, and documents the wire does not carry', () => {
    // A comparison over one outcome passes for any subject, so say what was reached.
    expect(tally.unsafe).toBeGreaterThan(300)
    expect(tally.several).toBeGreaterThan(100)
    expect(tally.written).toBeGreaterThan(50)
    expect(tally.declined).toBeGreaterThan(5)
  })
})
