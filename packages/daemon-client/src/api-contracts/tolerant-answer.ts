import { z } from 'zod'

/**
 * Re-derives a schema so it READS an answer a newer daemon has added a field
 * to — every object in it, at any depth, stops refusing a key it does not
 * declare and strips it instead (Zod's default object).
 *
 * The daemon declares the shape of a tool's output once and keeps it
 * `.strict()` there, where the MCP SDK checks what a handler returned. The
 * browser parses the same payload from an `/api/v1` route, and it is a
 * different reader: the hosted app updates itself behind a service worker
 * while the daemon is installed separately, so the version that wrote the
 * answer is routinely newer than the one reading it. `.loose()` on the top
 * object would not be enough — the nested objects (a search hit, a backlink,
 * a tag count) are strict too, and a field added to any of them fails the
 * whole parse. Deriving rather than re-declaring keeps one definition of
 * what a field IS; this only changes what a reader does about one it has
 * not heard of.
 *
 * An optional enum also stops failing on a member it does not know and reads
 * as absent (`unknownIsAbsent`): a document `kind` a newer daemon added must
 * not make a whole search or backlink list unreadable.
 *
 * Only strictness and that absence rule change, so the inferred type is the
 * schema's own and the result is returned as the same type. A schema built
 * from a kind this does not walk is returned untouched rather than
 * half-converted, and `v1-answers.test.ts` parses an extra key at every level
 * of each answer to hold that the walk reached all of them.
 */
export function tolerantAnswer<S extends z.ZodType>(schema: S): S {
  return derive(schema) as S
}

/**
 * An optional enum that reads a member this build has no name for as ABSENT
 * rather than failing the answer around it. Absence is a state every reader of
 * an optional field already handles, so the newer daemon's new member costs
 * the one field instead of the listing it sits in (every document in a list,
 * every hit of a search). The inferred type is the schema's own.
 *
 * Only for a field whose absence a reader copes with: a value a decision is
 * made on (custody, an exhaustive report) stays strict, and
 * `answers-tolerant.test.ts` holds that split by listing the strict ones.
 */
export function unknownIsAbsent<S extends z.ZodType>(schema: S) {
  return schema.optional().catch(undefined)
}

type Def = z.core.$ZodTypeDef & Record<string, unknown>

// Memoised per source schema: a schema shared by several answers (a record
// value, a recursive reference) is derived once, and a self-referencing
// `lazy` terminates instead of recursing forever.
function derive(schema: z.core.$ZodType, seen = new Map<z.core.$ZodType, z.core.$ZodType>()) {
  const known = seen.get(schema)
  if (known !== undefined) return known
  const result = rebuild(schema, (inner) => derive(inner, seen))
  seen.set(schema, result)
  return result
}

type Next = (inner: z.core.$ZodType) => z.core.$ZodType
type Schemas = z.core.$ZodType[]

// A definition's own parts, re-derived; undefined for a kind with nothing
// inside it to loosen (a string, a literal, a transform).
function changes(def: Def, next: Next): Record<string, unknown> | undefined {
  switch (def.type) {
    case 'object': {
      const shape = def.shape as Record<string, z.core.$ZodType>
      return {
        shape: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, next(value)])),
        // `never` is what `.strict()` sets; a catchall that is a real schema
        // (a typed rest) keeps its meaning and is derived like any other.
        catchall: isNever(def.catchall) ? undefined : mapOptional(def.catchall, next),
      }
    }
    case 'array':
      return { element: next(def.element as z.core.$ZodType) }
    case 'union':
      return { options: (def.options as Schemas).map(next) }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return { innerType: next(def.innerType as z.core.$ZodType) }
    case 'pipe':
      return { in: next(def.in as z.core.$ZodType), out: next(def.out as z.core.$ZodType) }
    case 'record':
      return { valueType: next(def.valueType as z.core.$ZodType) }
    case 'tuple':
      return { items: (def.items as Schemas).map(next), rest: mapOptional(def.rest, next) }
    case 'intersection':
      return { left: next(def.left as z.core.$ZodType), right: next(def.right as z.core.$ZodType) }
    case 'lazy': {
      const getter = def.getter as () => z.core.$ZodType
      return { getter: () => next(getter()) }
    }
    default:
      return undefined
  }
}

function rebuild(schema: z.core.$ZodType, next: Next): z.core.$ZodType {
  const def = schema._zod.def as Def
  if (def.type === 'optional' && isEnum(def.innerType)) {
    return unknownIsAbsent(def.innerType as z.ZodEnum)
  }
  const changed = changes(def, next)
  return changed === undefined ? schema : z.core.clone(schema, { ...def, ...changed } as never)
}

function isEnum(schema: unknown): boolean {
  return (schema as z.core.$ZodType | undefined)?._zod.def.type === 'enum'
}

function isNever(schema: unknown): boolean {
  return (schema as z.core.$ZodType | undefined)?._zod.def.type === 'never'
}

function mapOptional(schema: unknown, next: Next): z.core.$ZodType | undefined {
  return schema === undefined ? undefined : next(schema as z.core.$ZodType)
}
