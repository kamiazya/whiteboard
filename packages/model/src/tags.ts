import { z } from 'zod'

/**
 * Half of a scoped tag: the facet-name grammar
 * ([ADR-0040](../../../docs/contributing/adr/0040-scoped-tags.md) decision 1).
 */
export const TAG_IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/

/** The rule, spelled once so every refusal quotes the same sentence. */
export const SCOPED_TAG_RULE =
  'a scoped tag is key:value with both halves lowercase identifiers ([a-z][a-z0-9-]*) and exactly one colon, e.g. health:failing'

export interface ScopedTag {
  readonly key: string
  readonly value: string
}

/**
 * `key:value` when the tag is a well-formed scoped tag, `undefined` for a
 * PLAIN tag — which is any other string OKF allows, `Machine Learning`,
 * `v1.2`, `foo:Bar` and `a:b:c` included. Reading never refuses: a tag that
 * fails the grammar is a plain tag, preserved verbatim and never interpreted.
 */
export function parseScopedTag(tag: string): ScopedTag | undefined {
  const colon = tag.indexOf(':')
  if (colon === -1 || tag.indexOf(':', colon + 1) !== -1) return undefined
  const key = tag.slice(0, colon)
  const value = tag.slice(colon + 1)
  if (!TAG_IDENTIFIER_PATTERN.test(key) || !TAG_IDENTIFIER_PATTERN.test(value)) return undefined
  return { key, value }
}

/**
 * The grammar, checked on WRITE and for scoped tags only: a tag with a colon
 * in it has to be a scoped tag, and is refused with the rule when it is not.
 * A tag without one is plain and passes verbatim. Strict where this codebase
 * produces, lenient where it consumes — the shape ADR-0037 chose for the
 * extension key, so a document another tool wrote is never refused for its
 * tags while nothing here can write a tag that reads as scoped and is not.
 */
export const tagWriteSchema = z
  .string()
  .min(1)
  .superRefine((tag, ctx) => {
    if (!tag.includes(':') || parseScopedTag(tag) !== undefined) return
    ctx.addIssue({
      code: 'custom',
      message: `tag "${tag}" is not a scoped tag: ${SCOPED_TAG_RULE}`,
    })
  })

/**
 * A tag SET as a writer states one: no duplicates, since order carries no
 * meaning and a second copy says nothing the first did not. Several values
 * under one key (`hoge:foo` beside `hoge:bar`) are allowed — decision 3 says
 * what each consumer does with them.
 */
export const tagsWriteSchema = z.array(tagWriteSchema).superRefine((tags, ctx) => {
  const seen = new Set<string>()
  for (const tag of tags) {
    if (seen.has(tag)) {
      ctx.addIssue({ code: 'custom', message: `duplicate tag "${tag}"` })
      return
    }
    seen.add(tag)
  }
})

/**
 * The STORED shape at every site that carries tags: a list of strings, read
 * verbatim. Lenient on purpose — the grammar above is the write side's — and
 * `.catch(undefined)` so a malformed value costs the tags, never the element
 * they sit on, the way a malformed facet bucket costs the facets.
 */
export const storedTagsSchema = z.array(z.string()).optional().catch(undefined)
