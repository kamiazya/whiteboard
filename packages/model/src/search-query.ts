import { z } from 'zod'

/**
 * The most characters (UTF-16 code units) one search query may carry.
 *
 * Ranking is linear in the query's distinct tokens over the whole corpus,
 * and the excerpts scan every answered text once per token, so the query is
 * a multiplier on every document a workspace holds. Measured through
 * wb_document_search on a 4-core machine: 400 notes of ~6 Ki each answer a
 * 7.9 Ki query in about 2.2 s of CPU, a 32 Ki one in about 6 s. The longest
 * query in either judged search corpus is under 90 characters, so 1 Ki is
 * an order of magnitude over a real one — a sentence or two of words — and
 * a longer text is a document to compare against, not a query.
 */
export const SEARCH_QUERY_MAX_CHARS = 1024

/** The query bound as every refusal of it ends. */
const SEARCH_QUERY_LIMIT_PHRASE = `the ${SEARCH_QUERY_MAX_CHARS}-character limit`

/** A search query as a tool or route accepts it. */
export const searchQueryInputSchema = z
  .string()
  .min(1)
  .max(SEARCH_QUERY_MAX_CHARS, `a search query is longer than ${SEARCH_QUERY_LIMIT_PHRASE}`)
