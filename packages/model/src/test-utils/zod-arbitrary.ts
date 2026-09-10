/**
 * A fast-check arbitrary derived from a zod v4 schema, so a property's
 * inputs follow the schema rather than a generator someone wrote the day
 * the test was written and never met the field added later.
 *
 * The walk reads zod's internal `_zod.def` — the one place a schema's
 * shape is machine-readable, and what every zod-to-generator library reads
 * too; none of them supports zod 4 at the time of writing, which is why
 * this exists. It lives in model's test-utils because model is the lowest
 * package and already the home of the shared arbitraries, so every package
 * above it reaches the generator through the dependency it already has.
 * Two disciplines keep it honest:
 *
 * - Everything drawn is filtered through the schema itself, so a
 *   refinement or a check the walk does not model is still honoured — by
 *   rejection rather than by luck. A filter that rejects nearly everything
 *   fails loudly at construction, never silently.
 * - A construct with no generator THROWS naming the path. Yielding nothing
 *   for it would widen a property's domain by zero while the property
 *   still reads as covering the schema.
 *
 * What comes out is the schema's OUTPUT: each draw is parsed, so a default
 * is filled and a transform applied, and the value is what a consumer
 * holds after `schema.parse`. An optional field is drawn as an absent key,
 * never as a key holding `undefined` — the two are equal to `toEqual` and
 * different to everything that serialises, and a generator that produced
 * the second would be claiming a shape the schema's own output never has.
 *
 * Numbers and strings are drawn small on purpose: a property over model
 * values wants the schema's choices reached, not the extremes of IEEE
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
  readonly prefix?: string
  readonly suffix?: string
  readonly includes?: string
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
interface ZodInternals {
  readonly def: ZodDef
  /** `'optional'` when the key may be absent on input: optional, default, prefault, catch. */
  readonly optin?: string
  /** A lazy schema's resolved inner schema, cached by zod on first access. */
  readonly innerType?: z.ZodTypeAny
}
const internalsOf = (schema: z.ZodTypeAny): ZodInternals =>
  (schema as unknown as { _zod: ZodInternals })._zod
const defOf = (schema: z.ZodTypeAny): ZodDef => internalsOf(schema).def

/**
 * Whether two schema objects are the SAME schema. `.describe()` and
 * `.meta()` clone the object and share its def, so a field declared as
 * `documentIdSchema.describe('…')` is `documentIdSchema` for an override
 * that matches by identity — comparing the objects alone would miss it.
 */
export function sameSchema(a: z.ZodTypeAny, b: z.ZodTypeAny): boolean {
  return a === b || defOf(a) === defOf(b)
}

export interface SchemaArbitraryOptions {
  /**
   * Replace the generator at a path or for a schema — `$` is the root,
   * `$.field`, `$.items[]`, `$.entries{}`, `$.entries{key}`, `$.either|1`,
   * `$.pair[0]` below it, and the schema object itself is passed beside the
   * path so a shared schema (`extensionFacetsSchema`, say) can be matched by
   * identity wherever it appears. An `assetRefs` field, say, draws the
   * registered ids instead of any string. Return `undefined` to keep
   * walking. Under a recursive (`z.lazy`) schema the path is the one of the
   * first expansion, since the expansion is built once and shared.
   */
  readonly override?: (path: string, schema: z.ZodTypeAny) => fc.Arbitrary<unknown> | undefined
  /**
   * How deep a recursive schema may nest inside itself: `0` expands every
   * `z.lazy` once and then only draws what needs no further expansion, `3`
   * (the default) allows three nested expansions. A schema whose recursion
   * is unavoidable — no option, no empty array, no absent key can end it —
   * throws naming the path.
   */
  readonly maxDepth?: number
}

/** Numbers are drawn from here unless the schema bounds them tighter. */
const NUMBER_SPAN = 1000
/** Single grapheme clusters, so a one-character refinement keeps a share of the draws. */
const GRAPHEMES = ['a', '✅', '🔥', '字'] as const
const DEFAULT_MAX_DEPTH = 3
/** Stands in for an optional key that is not drawn; stripped before the record is handed back. */
const ABSENT = Symbol('absent')
const AFFIX_FORMATS = new Set(['starts_with', 'ends_with', 'includes'])

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
  // `z.url()` / `z.email()` carry the format on the string's own def; the
  // `.url()` / `.regex()` / `.startsWith()` methods carry it as a check.
  const formats = checks.filter((c) => c.check === 'string_format')
  const affixes = formats.filter((c) => AFFIX_FORMATS.has(c.format ?? ''))
  const format = def.format ?? formats.find((c) => !AFFIX_FORMATS.has(c.format ?? ''))?.format
  if (format === undefined && affixes.length > 0) {
    // `.startsWith` / `.includes` / `.endsWith`: built around the affixes
    // rather than drawn from the first one's pattern, which would leave the
    // others to the filter and reject nearly everything.
    const prefix = affixes.find((c) => c.format === 'starts_with')?.prefix ?? ''
    const infix = affixes.find((c) => c.format === 'includes')?.includes ?? ''
    const suffix = affixes.find((c) => c.format === 'ends_with')?.suffix ?? ''
    return fc.string({ maxLength: 4 }).map((s) => prefix + infix + s + suffix)
  }
  if (format !== undefined) {
    if (format === 'url') return fc.webUrl()
    const pattern = formats.find((c) => c.pattern !== undefined)?.pattern
    // fast-check builds a generator from the regex itself; a format whose
    // pattern it cannot express (email's lookaheads) or that carries none
    // is refused with the format's name rather than approximated. A second
    // format on the same string is honoured by the schema filter.
    try {
      if (pattern !== undefined) return fc.stringMatching(pattern)
    } catch (cause) {
      throw new Error(
        `zod-arbitrary: no generator for string format "${format}" at ${path}: ${String(cause)}`,
      )
    }
    throw new Error(`zod-arbitrary: no generator for string format "${format}" at ${path}`)
  }
  const exact = checks.find((c) => c.check === 'length_equals')?.length
  const minLength = exact ?? checks.find((c) => c.check === 'min_length')?.minimum ?? 0
  const maxLength = exact ?? checks.find((c) => c.check === 'max_length')?.maximum ?? minLength + 4
  return fc.oneof(
    fc.string({ minLength, maxLength: Math.max(minLength, maxLength) }),
    fc.constantFrom(...GRAPHEMES),
  )
}

/**
 * Whether the walk can draw a value for `schema` without expanding any
 * `z.lazy` — what decides, at the recursion ceiling, which union options
 * stay, which arrays go empty and which optional keys go absent. A lazy
 * itself never terminates: the question is about the schema AROUND it.
 */
function canTerminate(schema: z.ZodTypeAny, memo: Map<z.ZodTypeAny, boolean>): boolean {
  const known = memo.get(schema)
  if (known !== undefined) return known
  const def = defOf(schema)
  let answer: boolean
  switch (def.type) {
    case 'lazy':
      answer = false
      break
    case 'object':
      answer = Object.values(def.shape ?? {}).every(
        (field) => internalsOf(field).optin === 'optional' || canTerminate(field, memo),
      )
      break
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'catch':
      answer = true
      break
    case 'readonly':
    case 'nonoptional':
      answer = canTerminate(def.innerType as z.ZodTypeAny, memo)
      break
    case 'pipe':
      answer = canTerminate(def.in as z.ZodTypeAny, memo)
      break
    case 'union':
      answer = (def.options ?? []).some((option) => canTerminate(option, memo))
      break
    case 'array': {
      const minLength = checksOf(def).find((c) => c.check === 'min_length')?.minimum ?? 0
      answer = minLength === 0 || canTerminate(def.element as z.ZodTypeAny, memo)
      break
    }
    case 'tuple':
      answer = (def.items ?? []).every((item) => canTerminate(item, memo))
      break
    default:
      // record (may be empty), and every primitive.
      answer = true
  }
  memo.set(schema, answer)
  return answer
}

interface WalkState {
  readonly options: SchemaArbitraryOptions
  readonly maxDepth: number
  readonly terminates: Map<z.ZodTypeAny, boolean>
  /** One expansion per lazy schema per depth, shared by every path that reaches it. */
  readonly expansions: Map<z.ZodTypeAny, Map<number, fc.Arbitrary<unknown>>>
}

/** Whether a `z.lazy` met at `depth` may still be expanded. */
const mayExpand = (state: WalkState, depth: number): boolean => depth <= state.maxDepth

/** A child that would need an expansion the budget no longer allows. */
const mustPrune = (state: WalkState, depth: number, child: z.ZodTypeAny): boolean =>
  !mayExpand(state, depth) && !canTerminate(child, state.terminates)

const ABSENCE_WRAPPERS = new Set([
  'optional',
  'default',
  'prefault',
  'catch',
  'readonly',
  'nonoptional',
])

/** The schema under the wrappers that let a key be absent. */
function coreOf(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema
  while (ABSENCE_WRAPPERS.has(defOf(current).type)) {
    current = defOf(current).innerType as z.ZodTypeAny
  }
  return current
}

const firstIssue = (result: z.ZodSafeParseResult<unknown>): string | undefined =>
  result.success ? undefined : (result.error.issues[0]?.message ?? 'rejected')

const hasRefinement = (def: ZodDef): boolean => checksOf(def).some((c) => c.check === 'custom')

function walk(
  schema: z.ZodTypeAny,
  state: WalkState,
  path: string,
  depth: number,
): fc.Arbitrary<unknown> {
  const overridden = state.options.override?.(path, schema)
  if (overridden !== undefined) return overridden
  const drawn = walkShape(schema, state, path, depth)
  // A refinement is honoured where it is DECLARED, not only at the root.
  // Filtering at the root alone skews what a union or an array reaches:
  // the arm with the fewest refinements passes most often and comes to
  // dominate the draws, and one rejected element rejects its whole
  // collection. Measured before this: a discriminated union of three
  // anchor arms drew its refinement-free arm 645 times in 1000.
  if (!hasRefinement(defOf(schema))) return drawn
  return acceptedOrThrow(
    drawn,
    (value) => firstIssue(schema.safeParse(value)),
    `the schema at ${path}`,
  )
}

function walkShape(
  schema: z.ZodTypeAny,
  state: WalkState,
  path: string,
  depth: number,
): fc.Arbitrary<unknown> {
  const def = defOf(schema)
  switch (def.type) {
    case 'object': {
      const fields: Record<string, fc.Arbitrary<unknown>> = {}
      for (const [name, field] of Object.entries(def.shape ?? {})) {
        const fieldPath = `${path}.${name}`
        if (internalsOf(field).optin === 'optional') {
          // A pruned key is always absent; any other optional key is absent
          // half the time. Drawn here rather than through `fc.record`'s
          // `requiredKeys`, which keeps an optional key present four draws
          // in five — enough to starve a refinement over several optional
          // keys (an anchor naming at most one of three references, with a
          // region needing both of two more) down to a few draws in a
          // hundred, where the preflight below could see none.
          if (mustPrune(state, depth, coreOf(field))) continue
          fields[name] = fc.option(walk(field, state, fieldPath, depth), { nil: ABSENT, freq: 2 })
        } else {
          fields[name] = walk(field, state, fieldPath, depth)
        }
      }
      return fc
        .record(fields)
        .map((record) =>
          Object.fromEntries(Object.entries(record).filter(([, value]) => value !== ABSENT)),
        )
    }
    case 'optional':
    case 'default':
    case 'prefault':
    case 'catch': {
      // Reached outside an object key (a tuple item, a root schema): the
      // value is drawn, and `undefined` — filled by the default or the
      // catch on parse — is what a pruned recursion leaves.
      const inner = def.innerType as z.ZodTypeAny
      if (mustPrune(state, depth, coreOf(inner))) return fc.constant(undefined)
      return walk(inner, state, path, depth)
    }
    case 'readonly':
    case 'nonoptional':
      return walk(def.innerType as z.ZodTypeAny, state, path, depth)
    case 'nullable': {
      const inner = def.innerType as z.ZodTypeAny
      if (mustPrune(state, depth, inner)) return fc.constant(null)
      return fc.option(walk(inner, state, path, depth), { nil: null })
    }
    case 'pipe':
      return walk(def.in as z.ZodTypeAny, state, path, depth)
    case 'lazy': {
      if (!mayExpand(state, depth)) {
        throw new Error(
          `zod-arbitrary: recursion at ${path} cannot end within maxDepth ${state.maxDepth}`,
        )
      }
      const byDepth = state.expansions.get(schema) ?? new Map<number, fc.Arbitrary<unknown>>()
      state.expansions.set(schema, byDepth)
      const known = byDepth.get(depth)
      if (known !== undefined) return known
      const inner = internalsOf(schema).innerType as z.ZodTypeAny
      const expanded = walk(inner, state, path, depth + 1)
      byDepth.set(depth, expanded)
      return expanded
    }
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
    case 'union': {
      const options = (def.options ?? []).map((option, i) => [option, i] as const)
      const live = mayExpand(state, depth)
        ? options
        : options.filter(([option]) => canTerminate(option, state.terminates))
      if (live.length === 0) {
        throw new Error(
          `zod-arbitrary: no option of the union at ${path} ends within maxDepth ${state.maxDepth}`,
        )
      }
      return fc.oneof(...live.map(([option, i]) => walk(option, state, `${path}|${i}`, depth)))
    }
    case 'array': {
      const checks = checksOf(def)
      const minLength = checks.find((c) => c.check === 'min_length')?.minimum ?? 0
      const maxLength = checks.find((c) => c.check === 'max_length')?.maximum ?? minLength + 3
      const element = def.element as z.ZodTypeAny
      if (mustPrune(state, depth, element)) {
        if (minLength > 0) {
          throw new Error(
            `zod-arbitrary: the array at ${path} needs an element and none ends within maxDepth ${state.maxDepth}`,
          )
        }
        return fc.constant([])
      }
      return fc.array(walk(element, state, `${path}[]`, depth), { minLength, maxLength })
    }
    case 'tuple': {
      const items = (def.items ?? []).map((item, i) => walk(item, state, `${path}[${i}]`, depth))
      const head = fc.tuple(...items)
      if (def.rest === null || def.rest === undefined || mustPrune(state, depth, def.rest)) {
        return head
      }
      const rest = fc.array(walk(def.rest, state, `${path}[...]`, depth), { maxLength: 3 })
      return fc.tuple(head, rest).map(([fixed, tail]) => [...fixed, ...tail])
    }
    case 'record': {
      const valueType = def.valueType as z.ZodTypeAny
      if (mustPrune(state, depth, valueType)) return fc.constant({})
      const keys = walk(def.keyType as z.ZodTypeAny, state, `${path}{key}`, depth).map(String)
      const values = walk(valueType, state, `${path}{}`, depth)
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
 *
 * The draws are seeded, so the decision is the same on every run: a filter
 * accepting one draw in a hundred either passes this preflight every time
 * or fails it every time, never one run in twenty. This is a construction
 * guard, not a property — the property's own runs stay unseeded.
 */
const PREFLIGHT_DRAWS = 300
const PREFLIGHT_SEED = 0

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
  const rejections = fc.sample(raw, { numRuns: PREFLIGHT_DRAWS, seed: PREFLIGHT_SEED }).map(accept)
  if (rejections.every((rejection) => rejection !== undefined)) {
    throw new Error(
      `zod-arbitrary: nothing drawn for ${what} is accepted (first rejection: ${rejections[0]}); give the field an override`,
    )
  }
  return raw.filter((value) => accept(value) === undefined)
}

/**
 * Values `schema` produces: drawn on its input side, filtered through the
 * schema, and handed back parsed — so a default is filled, a transform
 * applied, and the type is the one a consumer holds.
 */
export function arbitraryForSchema<S extends z.ZodTypeAny>(
  schema: S,
  options: SchemaArbitraryOptions = {},
): fc.Arbitrary<z.output<S>> {
  const state: WalkState = {
    options,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    terminates: new Map(),
    expansions: new Map(),
  }
  return acceptedOrThrow(
    walk(schema, state, '$', 0),
    (value) => firstIssue(schema.safeParse(value)),
    'the schema at $',
  ).map((value) => schema.parse(value) as z.output<S>)
}
