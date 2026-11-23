import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as generated from './index.js'
import { RESERVED_MAP_KEY } from './reserved-key.js'

// The contract is read here with its own schema, so a shape the generator and
// this reader would take differently shows as a failure in one of them.
const entrySchema = z.strictObject({
  name: z.string(),
  code: z.string(),
  status: z.number(),
  family: z.enum(['sync-write', 'version']).optional(),
  breach: z.strictObject({ table: z.enum(['text', 'workspace']), shape: z.string() }).optional(),
  module: z.string().optional(),
  description: z.string(),
  message: z.string(),
  params: z.record(z.string(), z.enum(['string', 'integer', 'string[]'])).default({}),
  example: z.record(z.string(), z.unknown()).default({}),
  exampleText: z.string(),
  surfaces: z.array(z.string()).min(1),
  source: z.string(),
})
const contract = z
  .strictObject({
    $comment: z.string(),
    surfaces: z.record(z.string(), z.string()),
    refusals: z.array(entrySchema),
  })
  .parse(
    JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../contracts/api/refusals.json'), 'utf8'),
    ),
  )

/** The names a message fills, in the order it first names them: the order a generated function takes them. */
const paramOrder = (message: string): string[] => [
  ...new Set([...message.matchAll(/\{([A-Za-z0-9]+)(?:\|[a-z_]+)?\}/g)].map((m) => m[1] as string)),
]

const sentence = (entry: { name: string; message: string; example: Record<string, unknown> }) =>
  (generated as unknown as Record<string, (...args: unknown[]) => string>)[entry.name]?.(
    ...paramOrder(entry.message).map((name) => entry.example[name]),
  )

describe('the generated refusals', () => {
  it('has one function per entry of the contract and no other', () => {
    expect(contract.refusals.length).toBeGreaterThan(100)
    const exported = Object.entries(generated)
      .filter(
        ([key, value]) =>
          typeof value === 'function' &&
          contract.refusals.some((e) => e.name === key && e.module === undefined),
      )
      .map(([key]) => key)
    expect(exported.sort()).toEqual(
      contract.refusals
        .filter((e) => e.module === undefined)
        .map((e) => e.name)
        .sort(),
    )
  })

  it('says each entry`s example as the contract pins it', () => {
    // An entry with a module is generated into its raiser's package, where that package's class test pins it.
    for (const entry of contract.refusals.filter((e) => e.module === undefined)) {
      expect(sentence(entry), entry.name).toBe(entry.exampleText)
    }
  })

  it('names each distinct code once, as a constant and under the camelCase of the code', () => {
    const codes = [...new Set(contract.refusals.map((e) => e.code))]
    expect(Object.values(generated.REFUSAL_CODES)).toEqual(codes)
    for (const [key, code] of Object.entries(generated.REFUSAL_CODES)) {
      expect(key).toBe(code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()))
      const constant = (generated as unknown as Record<string, string>)[
        `REFUSAL_CODE_${code.toUpperCase()}`
      ]
      expect(constant, code).toBe(code)
    }
  })

  it('lists the families' + ' codes the contract tags', () => {
    const family = (name: 'sync-write' | 'version') => [
      ...new Set(contract.refusals.filter((e) => e.family === name).map((e) => e.code)),
    ]
    expect([...generated.SYNC_WRITE_REFUSAL_CODES]).toEqual(family('sync-write'))
    expect([...generated.VERSION_REFUSAL_CODES]).toEqual(family('version'))
  })

  it('names the reserved map key the way the writer that refuses it does', () => {
    for (const name of ['ReservedKeyWrite', 'ReservedMapKeyUpdate']) {
      const entry = contract.refusals.find((e) => e.name === name)
      expect(entry?.message).toContain(`"${RESERVED_MAP_KEY}"`)
    }
  })
})
