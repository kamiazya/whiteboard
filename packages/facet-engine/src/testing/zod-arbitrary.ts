/**
 * A fast-check arbitrary derived from a zod v4 schema, so a property's
 * inputs follow the schema rather than a generator someone wrote the day
 * the test was written and never met the field added later.
 *
 * The walk reads zod's internal `_zod.def` — the one place a schema's
 * shape is machine-readable, and what every zod-to-generator library reads
 * too; none of them supports zod 4 at the time of writing, which is why
 * this exists. Two disciplines keep it honest:
 *
 * - Everything drawn is filtered through the schema itself, so a
 *   refinement or a check the walk does not model is still honoured — by
 *   rejection rather than by luck. A filter that rejects nearly everything
 *   makes fast-check fail loudly, never silently.
 * - A construct with no generator THROWS naming the path. Yielding nothing
 *   for it would widen a property's domain by zero while the property
 *   still reads as covering the schema.
 *
 * Numbers and strings are drawn small on purpose: a property over facet
 * payloads wants the schema's choices reached, not the extremes of IEEE
 * doubles.
 */
import * as fc from 'fast-check'
import type { z } from 'zod'

type Check = { readonly _zod: { readonly def: ZodCheckDef } }
interface ZodCheckDef {
  readonly check: string
  readonly format?: string
  readonly pattern?: RegExp
  readonly minimum?: number
  readonly maximum?: number
  readonly length?: number
  readonly value?: number
  readonly inclusive?: boolean
}
interface ZodDef {
  readonly type: string
  readonly shape?: Readonly<Record<string, z.ZodTypeAny>>
  readonly innerType?: z.ZodTypeAny
  readonly in?: z.ZodTypeAny
  readonly entries?: Readonly<Record<string, string | number>>
  readonly values?: readonly unknown[]
  readonly options?: readonly z.ZodTypeAny[]
  readonly element?: z.ZodTypeAny
  readonly items?: readonly z.ZodTypeAny[]
  readonly rest?: z.ZodTypeAny | null
  readonly keyType?: z.ZodTypeAny
  readonly valueType?: z.ZodTypeAny
  readonly format?: string
  readonly checks?: readonly Check[]
}
const defOf = (schema: z.ZodTypeAny): ZodDef =>
  (schema as unknown as { _zod: { def: ZodDef } })._zod.def

export interface SchemaArbitraryOptions {
  /**
   * Replace the generator at a path — `$` is the root, `$.field`,
   * `$.items[]`, `$.entries{}`, `$.either|1`, `$.pair[0]` below it. An
   * `assetRefs` field, say, draws the registered ids instead of any string.
   * Return `undefined` to keep walking.
   */
  readonly override?: (path: string, schema: z.ZodTypeAny) => fc.Arbitrary<unknown> | undefined
}

/** Numbers are drawn from here unless the schema bounds them tighter. */
const NUMBER_SPAN = 1000
/** Single grapheme clusters, so a one-character refinement keeps a share of the draws. */
const GRAPHEMES = ['a', '✅', '🔥', '字'] as const

function checksOf(def: ZodDef): readonly ZodCheckDef[] {
  return (def.checks ?? []).map((check) => check._zod.def)
}

function numberArbitrary(def: ZodDef): fc.Arbitrary<number> {
  const checks = checksOf(def)
  const lower = checks.find((c) => c.check === 'greater_than')
  const upper = checks.find((c) => c.check === 'less_than')
  const format = def.format ?? checks.find((c) => c.check === 'number_format')?.format
  if (format?.includes('int')) {
    const min = lower?.value === undefined ? -NUMBER_SPAN : lower.value + (lower.inclusive ? 0 : 1)
    const max = upper?.value === undefined ? NUMBER_SPAN : upper.value - (upper.inclusive ? 0 : 1)
    return fc.integer({ min: Math.ceil(min), max: Math.floor(max) })
  }
  return fc.double({
    noNaN: true,
    noDefaultInfinity: true,
    min: lower?.value ?? -NUMBER_SPAN,
    max: upper?.value ?? NUMBER_SPAN,
    ...(lower !== undefined && lower.inclusive === false ? { minExcluded: true } : {}),
    ...(upper !== undefined && upper.inclusive === false ? { maxExcluded: true } : {}),
  })
}

function stringArbitrary(def: ZodDef, path: string): fc.Arbitrary<string> {
  const checks = checksOf(def)
  const formats = checks.filter((c) => c.check === 'string_format')
  const format = formats[0]
  if (format !== undefined) {
    // fast-check builds a generator from the regex itself; a format whose
    // pattern it cannot express (email's lookaheads) or that carries none
    // (url) is refused with the format's name rather than approximated.
    try {
      if (format.pattern !== undefined) return fc.stringMatching(format.pattern)
    } catch (cause) {
      throw new Error(
        `zod-arbitrary: no generator for string format "${format.format}" at ${path}: ${String(cause)}`,
      )
    }
    throw new Error(`zod-arbitrary: no generator for string format "${format.format}" at ${path}`)
  }
  const exact = checks.find((c) => c.check === 'length_equals')?.length
  const minLength = exact ?? checks.find((c) => c.check === 'min_length')?.minimum ?? 0
  const maxLength = exact ?? checks.find((c) => c.check === 'max_length')?.maximum ?? minLength + 4
  return fc.oneof(
    fc.string({ minLength, maxLength: Math.max(minLength, maxLength) }),
    fc.constantFrom(...GRAPHEMES),
  )
}

function walk(
  schema: z.ZodTypeAny,
  options: SchemaArbitraryOptions,
  path: string,
): fc.Arbitrary<unknown> {
  const overridden = options.override?.(path, schema)
  if (overridden !== undefined) return overridden
  const def = defOf(schema)
  switch (def.type) {
    case 'object': {
      const fields: Record<string, fc.Arbitrary<unknown>> = {}
      const required: string[] = []
      for (const [name, field] of Object.entries(def.shape ?? {})) {
        const fieldDef = defOf(field)
        if (fieldDef.type === 'optional') {
          fields[name] = walk(fieldDef.innerType as z.ZodTypeAny, options, `${path}.${name}`)
        } else {
          fields[name] = walk(field, options, `${path}.${name}`)
          required.push(name)
        }
      }
      return fc.record(fields, { requiredKeys: required })
    }
    case 'optional':
      return fc.option(walk(def.innerType as z.ZodTypeAny, options, path), { nil: undefined })
    case 'nullable':
      return fc.option(walk(def.innerType as z.ZodTypeAny, options, path), { nil: null })
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
      return walk(def.innerType as z.ZodTypeAny, options, path)
    case 'pipe':
      return walk(def.in as z.ZodTypeAny, options, path)
    case 'enum':
      return fc.constantFrom(...Object.values(def.entries ?? {}))
    case 'literal':
      return fc.constantFrom(...(def.values ?? []))
    case 'boolean':
      return fc.boolean()
    case 'null':
      return fc.constant(null)
    case 'undefined':
      return fc.constant(undefined)
    case 'any':
    case 'unknown':
      return fc.jsonValue({ maxDepth: 2 })
    case 'number':
      return numberArbitrary(def)
    case 'string':
      return stringArbitrary(def, path)
    case 'union':
      return fc.oneof(
        ...(def.options ?? []).map((option, i) => walk(option, options, `${path}|${i}`)),
      )
    case 'array': {
      const checks = checksOf(def)
      const minLength = checks.find((c) => c.check === 'min_length')?.minimum ?? 0
      const maxLength = checks.find((c) => c.check === 'max_length')?.maximum ?? minLength + 3
      return fc.array(walk(def.element as z.ZodTypeAny, options, `${path}[]`), {
        minLength,
        maxLength,
      })
    }
    case 'tuple': {
      const items = (def.items ?? []).map((item, i) => walk(item, options, `${path}[${i}]`))
      const head = fc.tuple(...items)
      if (def.rest === null || def.rest === undefined) return head
      const rest = fc.array(walk(def.rest, options, `${path}[...]`), { maxLength: 3 })
      return fc.tuple(head, rest).map(([fixed, tail]) => [...fixed, ...tail])
    }
    case 'record': {
      const keys = walk(def.keyType as z.ZodTypeAny, options, `${path}{key}`).map(String)
      const values = walk(def.valueType as z.ZodTypeAny, options, `${path}{}`)
      return fc.dictionary(keys, values, { maxKeys: 3 })
    }
    default:
      throw new Error(`zod-arbitrary: no generator for zod "${def.type}" at ${path}`)
  }
}

/**
 * How many raw draws `acceptedOrThrow` tries before deciding a filter would
 * never pass. A filter that accepts nothing makes fast-check retry FOREVER,
 * synchronously — the test never starts and no timeout fires — so the
 * decision is taken here, with the reason, rather than left to a hang.
 */
const PREFLIGHT_DRAWS = 100

/**
 * `raw` filtered by `accept`, or an error naming `what` and the first
 * rejection when nothing drawn passes. A filter that accepts under one draw
 * in a hundred is a generator that needs an override, and this is where it
 * says so.
 */
export function acceptedOrThrow<T>(
  raw: fc.Arbitrary<T>,
  accept: (value: T) => string | undefined,
  what: string,
): fc.Arbitrary<T> {
  const rejections = fc.sample(raw, PREFLIGHT_DRAWS).map(accept)
  if (rejections.every((rejection) => rejection !== undefined)) {
    throw new Error(
      `zod-arbitrary: nothing drawn for ${what} is accepted (first rejection: ${rejections[0]}); give the field an override`,
    )
  }
  return raw.filter((value) => accept(value) === undefined)
}

const firstIssue = (result: z.ZodSafeParseResult<unknown>): string | undefined =>
  result.success ? undefined : (result.error.issues[0]?.message ?? 'rejected')

/** Values `schema` accepts — as input, so a transform's source side is what is drawn. */
export function arbitraryForSchema(
  schema: z.ZodTypeAny,
  options: SchemaArbitraryOptions = {},
): fc.Arbitrary<unknown> {
  return acceptedOrThrow(
    walk(schema, options, '$'),
    (value) => firstIssue(schema.safeParse(value)),
    'the schema at $',
  )
}
