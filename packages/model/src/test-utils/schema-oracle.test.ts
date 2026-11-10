import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { brokenVariant, randomFrom } from './broken-variants.js'
import { answerSchema, decode, encode, encodeIssues, hasLoneSurrogate } from './schema-oracle.js'

describe('the recording encoding of a value', () => {
  it('round-trips every kind of value, a number by its bits and a mapping in key order', () => {
    const value = {
      b: 1.5,
      a: [null, true, 'text', -0, Number.NaN, 2 ** 60, Number.MIN_VALUE],
      10: 'ten',
      2: 'two',
    }
    const encoded = encode(value)
    expect(encoded).toEqual({
      m: [
        ['2', 'two'],
        ['10', 'ten'],
        ['b', { f: '3ff8000000000000' }],
        [
          'a',
          [
            null,
            true,
            'text',
            { f: '8000000000000000' },
            { f: '7ff8000000000000' },
            { f: expect.stringMatching(/^[0-9a-f]{16}$/) },
            { f: '0000000000000001' },
          ],
        ],
      ],
    })
    const decoded = decode(encoded) as typeof value
    expect(Object.keys(decoded)).toEqual(['2', '10', 'b', 'a'])
    expect(Object.is(decoded.a[3], -0)).toBe(true)
    expect(Number.isNaN(decoded.a[4])).toBe(true)
    expect(decoded.a[5]).toBe(2 ** 60)
  })

  it('keeps a safe integer as itself and refuses what JSON cannot say', () => {
    expect(encode(7)).toBe(7)
    expect(encode(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => encode(undefined)).toThrow('cannot be undefined')
  })

  it('finds a lone surrogate in a value, a key or a nested item', () => {
    expect(hasLoneSurrogate('\ud800')).toBe(true)
    expect(hasLoneSurrogate('\u{1f600}')).toBe(false)
    expect(hasLoneSurrogate({ '\udc00': 1 })).toBe(true)
    expect(hasLoneSurrogate([{ a: ['x', '\ud83d'] }])).toBe(true)
    expect(hasLoneSurrogate({ a: [1, null, 'fine'] })).toBe(false)
  })
})

describe('the recorded answer of a schema', () => {
  const arm = z.object({ kind: z.literal('a'), n: z.number() })
  const other = z.object({ kind: z.literal('b') })
  const schema = z.strictObject({
    either: z.union([arm, other]),
    keyed: z.record(z.string().regex(/^[a-z]+$/), z.number()),
  })

  it('records the parsed value of an accepted input', () => {
    const input = { keyed: { a: 1 }, either: { kind: 'b', extra: 1 } }
    expect(answerSchema(schema, input)).toEqual({
      ok: {
        m: [
          ['either', { m: [['kind', 'b']] }],
          ['keyed', { m: [['a', 1]] }],
        ],
      },
    })
  })

  it('records where, why and what each code carries, one level down for a union and a key', () => {
    const answer = answerSchema(schema, { either: { kind: 'a' }, keyed: { A: 1 }, stray: 1 })
    expect(answer).toEqual({
      err: [
        [
          ['either'],
          'invalid_union',
          { arms: [[[['n'], 'invalid_type', null]], [[['kind'], 'invalid_value', null]]] },
        ],
        [['keyed', 'A'], 'invalid_key', { key: [[[], 'invalid_format', null]] }],
        [[], 'unrecognized_keys', { keys: ['stray'] }],
      ],
    })
  })

  it('writes an array index as a number and a record key as a string', () => {
    const issues = z.array(z.record(z.string(), z.number())).safeParse([{ a: 'x' }])
    expect(issues.success ? [] : encodeIssues(issues.error.issues)).toEqual([
      [[0, 'a'], 'invalid_type', null],
    ])
  })
})

describe('a damaged copy of a value', () => {
  const valid = { name: 'x', tags: ['a', 'b'], nested: { n: 1, ok: true } }

  it('differs from the original, which it leaves untouched', () => {
    const before = JSON.stringify(valid)
    const damaged = Array.from({ length: 40 }, (_, seed) =>
      JSON.stringify(brokenVariant(valid, randomFrom(seed))),
    )
    expect(JSON.stringify(valid)).toBe(before)
    expect(damaged.filter((copy) => copy !== before).length).toBeGreaterThan(30)
    expect(new Set(damaged).size).toBeGreaterThan(10)
  })

  it('is the same damage for the same seed and replaces a bare value outright', () => {
    expect(brokenVariant(valid, randomFrom(7))).toEqual(brokenVariant(valid, randomFrom(7)))
    expect(brokenVariant('bare', randomFrom(1))).not.toBe('bare')
  })
})
