/**
 * Facet payloads drawn from the REGISTRY, so a property over "a canvas with
 * facets" follows every facet a plugin registers instead of a list someone
 * typed the day the test was written.
 *
 * The generator walks each facet's Zod schema (zod v4's `_zod.def`), swaps
 * an `assetRefs` field for the registered asset ids, and keeps only what
 * the schema accepts — a `.refine` the walk cannot see (a single-grapheme
 * check) is honoured by the filter rather than reproduced. The one thing
 * it refuses is a construct it has no generator for: that throws naming the
 * path, so a new schema shape fails the test that uses it instead of
 * quietly generating nothing for that facet. `facet-arbitrary.test.ts`
 * pins that every canvas facet the bundled registry holds is generable.
 */
import type { FacetRegistry, FacetTarget } from '@kamiazya/whiteboard-facet-engine'
import * as fc from 'fast-check'
import type { z } from 'zod'

type Check = { readonly _zod: { readonly def: ZodCheckDef } }
interface ZodCheckDef {
  readonly check: string
  readonly pattern?: RegExp
  readonly minimum?: number
  readonly maximum?: number
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
  readonly valueType?: z.ZodTypeAny
  readonly checks?: readonly Check[]
}
const defOf = (schema: z.ZodTypeAny): ZodDef =>
  (schema as unknown as { _zod: { def: ZodDef } })._zod.def

export interface FacetEntry {
  readonly key: string
  readonly schema: z.ZodTypeAny
  readonly assetRefs: Readonly<Record<string, string>> | undefined
}

/** Every facet the registry holds for `target`, with its storage key. */
export function facetEntries(registry: FacetRegistry, target: FacetTarget): readonly FacetEntry[] {
  return registry.plugins.flatMap((plugin) =>
    plugin.facets
      .filter((facet) => facet.targets.includes(target))
      .map((facet) => ({
        key: `${plugin.id}.${facet.name}/${facet.version}`,
        schema: facet.schema,
        assetRefs: facet.assetRefs,
      })),
  )
}

function checksOf(def: ZodDef): readonly ZodCheckDef[] {
  return (def.checks ?? []).map((check) => check._zod.def)
}

function arbitraryOf(
  schema: z.ZodTypeAny,
  registry: FacetRegistry,
  refs: Readonly<Record<string, string>> | undefined,
  path: string,
): fc.Arbitrary<unknown> {
  const def = defOf(schema)
  switch (def.type) {
    case 'object': {
      const shape = def.shape ?? {}
      const fields: Record<string, fc.Arbitrary<unknown>> = {}
      const required: string[] = []
      for (const [name, field] of Object.entries(shape)) {
        const kind = refs?.[name]
        if (kind !== undefined) {
          const ids = registry.assetIds(kind as Parameters<FacetRegistry['assetIds']>[0])
          if (ids.length === 0) {
            throw new Error(`facet-arbitrary: no registered "${kind}" asset for ${path}.${name}`)
          }
          fields[name] = fc.constantFrom(...ids)
          required.push(name)
          continue
        }
        const fieldDef = defOf(field)
        if (fieldDef.type === 'optional') {
          fields[name] = arbitraryOf(
            fieldDef.innerType as z.ZodTypeAny,
            registry,
            undefined,
            `${path}.${name}`,
          )
        } else {
          fields[name] = arbitraryOf(field, registry, undefined, `${path}.${name}`)
          required.push(name)
        }
      }
      return fc.record(fields, { requiredKeys: required })
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'nonoptional':
      return arbitraryOf(def.innerType as z.ZodTypeAny, registry, refs, path)
    case 'pipe':
      return arbitraryOf(def.in as z.ZodTypeAny, registry, refs, path)
    case 'enum':
      return fc.constantFrom(...Object.values(def.entries ?? {}))
    case 'literal':
      return fc.constantFrom(...(def.values ?? []))
    case 'boolean':
      return fc.boolean()
    case 'number': {
      const checks = checksOf(def)
      const min = checks.find((c) => c.minimum !== undefined)?.minimum
      const max = checks.find((c) => c.maximum !== undefined)?.maximum
      const bounds = {
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      }
      return checks.some((c) => c.check === 'number_format')
        ? fc.integer({ min: -1000, max: 1000, ...bounds })
        : fc.double({ noNaN: true, noDefaultInfinity: true, min: -1000, max: 1000, ...bounds })
    }
    case 'string': {
      const checks = checksOf(def)
      const pattern = checks.find((c) => c.pattern !== undefined)?.pattern
      if (pattern !== undefined) return fc.stringMatching(pattern)
      const minLength = checks.find((c) => c.check === 'min_length')?.minimum ?? 0
      // Short strings plus a few single graphemes, so a refinement such as
      // "one character or emoji" keeps a share of what the filter sees.
      return fc.oneof(
        fc.string({ minLength, maxLength: Math.max(minLength, 4) }),
        fc.constantFrom('a', '✅', '🔥', '字'),
      )
    }
    case 'union':
      return fc.oneof(
        ...(def.options ?? []).map((option, i) =>
          arbitraryOf(option, registry, refs, `${path}|${i}`),
        ),
      )
    case 'array':
      return fc.array(arbitraryOf(def.element as z.ZodTypeAny, registry, undefined, `${path}[]`), {
        maxLength: 3,
      })
    case 'record':
      return fc.dictionary(
        fc.string({ minLength: 1, maxLength: 6 }),
        arbitraryOf(def.valueType as z.ZodTypeAny, registry, undefined, `${path}{}`),
        { maxKeys: 3 },
      )
    default:
      throw new Error(`facet-arbitrary: no generator for zod "${def.type}" at ${path}`)
  }
}

/** A payload the registry accepts for one facet. */
function facetPayloadArbitrary(entry: FacetEntry, registry: FacetRegistry): fc.Arbitrary<unknown> {
  return arbitraryOf(entry.schema, registry, entry.assetRefs, entry.key).filter(
    (payload) => registry.validateFacetWrite(entry.key, payload).ok,
  )
}

/**
 * A `facets` record over any subset of the registry's `target` facets, each
 * with a payload the registry accepts — the shape a canvas envelope or an
 * OKF frontmatter holds.
 */
export function facetsArbitrary(
  registry: FacetRegistry,
  target: FacetTarget,
): fc.Arbitrary<Readonly<Record<string, unknown>>> {
  const entries = facetEntries(registry, target)
  if (entries.length === 0) return fc.constant({})
  return fc
    .uniqueArray(fc.constantFrom(...entries), { selector: (entry) => entry.key })
    .chain((chosen) =>
      fc.record(
        Object.fromEntries(
          chosen.map((entry) => [entry.key, facetPayloadArbitrary(entry, registry)]),
        ),
      ),
    )
}
