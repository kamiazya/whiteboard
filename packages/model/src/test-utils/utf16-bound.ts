/**
 * Finds every string schema with a length limit reachable from a schema, and
 * judges each one by the one question that matters: does a string whose
 * UTF-16 length is over the limit, but whose code-point count is under it,
 * get refused for being too long?
 *
 * Reachability is read off zod's `_zod.def` the way `zod-arbitrary.ts` does,
 * so a bounded string added to a payload tomorrow is judged without anyone
 * listing it. The refusal is recognised by the tag the bound puts on its
 * issue, not by a message, so a string that is merely malformed (a URL
 * format, a regex) cannot stand in for one that was measured.
 */
import { z } from 'zod'
import { UTF16_MAX_PARAM } from '../utf16-max.js'

interface Def {
  readonly type: string
  readonly shape?: Readonly<Record<string, z.ZodTypeAny>>
  readonly innerType?: z.ZodTypeAny
  readonly in?: z.ZodTypeAny
  readonly out?: z.ZodTypeAny
  readonly options?: readonly z.ZodTypeAny[]
  readonly element?: z.ZodTypeAny
  readonly items?: readonly z.ZodTypeAny[]
  readonly rest?: z.ZodTypeAny | null
  readonly keyType?: z.ZodTypeAny
  readonly valueType?: z.ZodTypeAny
  readonly left?: z.ZodTypeAny
  readonly right?: z.ZodTypeAny
}
interface Internals {
  readonly def: Def
  readonly innerType?: z.ZodTypeAny
}
const internalsOf = (schema: z.ZodTypeAny): Internals =>
  (schema as unknown as { _zod: Internals })._zod

export interface BoundedString {
  readonly schema: z.ZodTypeAny
  readonly max: number
}

function childrenOf(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  const internals = internalsOf(schema)
  const def = internals.def
  const found: Array<z.ZodTypeAny | null | undefined> = [
    ...Object.values(def.shape ?? {}),
    def.innerType,
    def.in,
    def.out,
    ...(def.options ?? []),
    def.element,
    ...(def.items ?? []),
    def.rest,
    def.keyType,
    def.valueType,
    def.left,
    def.right,
  ]
  if (def.type === 'lazy') found.push(internals.innerType)
  return found.filter((child): child is z.ZodTypeAny => child != null)
}

/** Every string schema under `root` that carries a maximum length. */
export function boundedStringsIn(root: z.ZodTypeAny): readonly BoundedString[] {
  const seen = new Set<z.ZodTypeAny>()
  const found: BoundedString[] = []
  const visit = (schema: z.ZodTypeAny): void => {
    if (seen.has(schema)) return
    seen.add(schema)
    const internals = internalsOf(schema)
    const max = (schema as { maxLength?: number | null }).maxLength
    if (internals.def.type === 'string' && typeof max === 'number') found.push({ schema, max })
    for (const child of childrenOf(schema)) visit(child)
  }
  visit(root)
  return found
}

/**
 * The shortest run of astral characters whose UTF-16 length passes `max`.
 * Its code-point count is half that, so a bound counting code points lets it
 * through.
 */
export function astralOverUtf16(max: number): string {
  return '😀'.repeat(Math.floor(max / 2) + 1)
}

/** Whether `schema` refuses `astralOverUtf16(max)` for its length, tagged as the bound tags it. */
export function refusesAstralOverflow({ schema, max }: BoundedString): boolean {
  const verdict = schema.safeParse(astralOverUtf16(max))
  return (
    !verdict.success &&
    verdict.error.issues.some(
      (issue) =>
        issue.code === 'custom' &&
        (issue as { params?: Record<string, unknown> }).params?.[UTF16_MAX_PARAM] === max,
    )
  )
}

/** Every bounded string under every schema a module exports, named by the export that reaches it. */
export function boundedStringsInExports(
  moduleNamespace: Record<string, unknown>,
): ReadonlyArray<BoundedString & { readonly name: string }> {
  return Object.entries(moduleNamespace).flatMap(([name, value]) =>
    value instanceof z.ZodType ? boundedStringsIn(value).map((found) => ({ name, ...found })) : [],
  )
}
