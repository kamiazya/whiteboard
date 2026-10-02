/**
 * The search route's query string, as one contract: the route that parses
 * it, the client that builds it and the fuzz lane that draws it all go
 * through here, so `q`/`tag` cannot be spelled differently on two sides.
 *
 * A subpath of its own, with no runtime import, because a browser client
 * reaches it and the schemas beside the tool would bring zod with them.
 */
import type { DocumentSearchInput } from './tools/document-search.schemas.js'

/** The names the query string carries, keyed by the input field each one is. */
const SEARCH_QUERY_PARAMS = {
  query: 'q',
  kind: 'kind',
  tags: 'tag',
  limit: 'limit',
} as const

export type SearchQueryInput = Omit<DocumentSearchInput, 'workspaceId'>

/** The query string a client sends for `input`: `tags` repeat as `tag`, absent fields are left out. */
export function searchQueryString(input: SearchQueryInput): string {
  const params = new URLSearchParams()
  if (input.query !== undefined) params.set(SEARCH_QUERY_PARAMS.query, input.query)
  if (input.kind !== undefined) params.set(SEARCH_QUERY_PARAMS.kind, input.kind)
  for (const tag of input.tags ?? []) params.append(SEARCH_QUERY_PARAMS.tags, tag)
  if (input.limit !== undefined) params.set(SEARCH_QUERY_PARAMS.limit, String(input.limit))
  return params.toString()
}

/**
 * What a request's query string says, as the raw input the schema then
 * judges — the inverse of `searchQueryString`. Takes readers rather than a
 * URL so the server keeps its framework's own decoding of the string.
 */
export function searchInputFromQuery(read: {
  one: (name: string) => string | undefined
  all: (name: string) => string[] | undefined
}): Record<string, unknown> {
  const kind = read.one(SEARCH_QUERY_PARAMS.kind)
  const tags = read.all(SEARCH_QUERY_PARAMS.tags)
  const limit = read.one(SEARCH_QUERY_PARAMS.limit)
  return {
    query: read.one(SEARCH_QUERY_PARAMS.query),
    ...(kind === undefined ? {} : { kind }),
    ...(tags === undefined || tags.length === 0 ? {} : { tags }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  }
}
