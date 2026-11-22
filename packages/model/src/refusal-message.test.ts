import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { REFUSAL_CODES, REFUSALS, type RefusalName } from './generated/refusals.js'
import { refusalMessage, renderRefusalTemplate } from './refusal-message.js'
import { RESERVED_MAP_KEY } from './reserved-key.js'

// The contract is parsed here with its own schema, so a shape the generator
// and this reader would take differently shows as a failure in one of them.
const entrySchema = z.strictObject({
  name: z.string(),
  code: z.string(),
  status: z.number(),
  family: z.enum(['sync-write', 'version']).optional(),
  description: z.string(),
  message: z.string(),
  params: z.record(z.string(), z.enum(['string', 'integer', 'string[]'])).default({}),
  example: z.record(z.string(), z.unknown()).default({}),
  exampleText: z.string(),
  surfaces: z.array(z.string()).min(1),
  source: z.string(),
})
const contractSchema = z.strictObject({
  $comment: z.string(),
  surfaces: z.record(z.string(), z.string()),
  refusals: z.array(entrySchema),
})

const contract = contractSchema.parse(
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../contracts/api/refusals.json'), 'utf8'),
  ),
)

describe('the generated refusals table', () => {
  it('lists every entry of the contract with its code, status and template, and nothing else', () => {
    expect(contract.refusals.length).toBeGreaterThan(100)
    expect(Object.keys(REFUSALS)).toEqual(contract.refusals.map((e) => e.name))
    for (const entry of contract.refusals) {
      expect(REFUSALS[entry.name as RefusalName], entry.name).toEqual({
        code: entry.code,
        status: entry.status,
        message: entry.message,
      })
    }
  })

  it('names each distinct code once, under the camelCase of the code', () => {
    const codes = [...new Set(contract.refusals.map((e) => e.code))]
    expect(Object.values(REFUSAL_CODES)).toEqual(codes)
    for (const [key, code] of Object.entries(REFUSAL_CODES)) {
      expect(key).toBe(code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()))
    }
  })

  it('renders every entry`s example to the text the contract pins', () => {
    for (const entry of contract.refusals) {
      // The name and its params are only known together once a name is chosen.
      const said = (refusalMessage as (n: RefusalName, p: unknown) => string)(
        entry.name as RefusalName,
        entry.example,
      )
      expect(said, entry.name).toBe(entry.exampleText)
    }
  })
})

describe('the template language', () => {
  const say = (template: string, params: Record<string, unknown>) =>
    renderRefusalTemplate(template, params)

  it('fills a param, applies a filter and reads doubled braces as braces', () => {
    expect(say('a {x} {{b}} {n}', { x: 'X', n: 3 })).toBe('a X {b} 3')
  })

  it('applies each filter as the JavaScript it names', () => {
    expect(say('{v|json}', { v: 'a"b\\c\n' })).toBe('"a\\"b\\\\c\\n"')
    expect(say('[{v|trim}]', { v: '  x y﻿\n' })).toBe('[x y]')
    expect(say('{n|s}', { n: 1 })).toBe('')
    expect(say('{n|s}', { n: 0 })).toBe('s')
    expect(say('{n|s}', { n: 2 })).toBe('s')
    expect(say('{v|list}', { v: ['a', 'b'] })).toBe('a, b')
    expect(say('{v|and_list}', { v: ['a', 'b'] })).toBe('a and b')
    expect(say('{v|json_list}', { v: ['a"', 'b'] })).toBe('"a\\"", "b"')
    expect(say('{v|quoted_list}', { v: ['a"', 'b'] })).toBe('"a"", "b"')
  })

  it('refuses a param nobody supplied and a filter nobody defined', () => {
    expect(() => say('{x}', {})).toThrow(/x/)
    expect(() => say('{x|nope}', { x: 'a' })).toThrow(/nope/)
  })
})

describe('what a template spells that the model also defines', () => {
  it('names the reserved map key the way the writer that refuses it does', () => {
    for (const name of ['ReservedKeyWrite', 'ReservedMapKeyUpdate'] as const) {
      expect(REFUSALS[name].message).toContain(`"${RESERVED_MAP_KEY}"`)
    }
  })
})
