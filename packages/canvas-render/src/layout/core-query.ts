import { highlightCode } from '../highlight/lowlight.js'
import type { LayoutCore } from '../layout-core.js'
import type { MeasureText } from '../measure.js'
import type { QueryAnswer, QueryRequest } from '../query-core.js'
import type { LayoutRefusal } from '../refusal.js'

/** A query the core answered, in the core's shape. */
export type Answered = Exclude<QueryAnswer, { readonly refused: unknown }>

/** How a query asks the core and reads its answer. */
export interface Querying<T> {
  /** The request; throwing `CoreUnaskable` for one it cannot be. */
  readonly request: () => QueryRequest
  /**
   * The answer to a query the core refused (a request past its
   * caps, a number it cannot spell, a host measurer that did not answer): what
   * the surface asking can show without the core's geometry.
   */
  readonly unanswered: (refused: LayoutRefusal) => T
  /** The core's answer in the query's shape, or undefined when it is not one. */
  readonly read: (answer: Answered) => T | undefined
  /** The host's measurer, for a request naming `{kind: 'host'}`. */
  readonly measure?: MeasureText
}

/**
 * A query answered by `core`. A query the core refused is answered by `unanswered`; a core
 * that throws, or answers in a shape the query does not have, throws to the
 * caller, since either is a defect rather than an input.
 */
export function queried<T>(core: LayoutCore, querying: Querying<T>): T {
  const request = querying.request()
  const answer = core.query.layoutQuery(request, highlightCode, querying.measure)
  if ('refused' in answer) return querying.unanswered(answer.refused)
  const read = querying.read(answer)
  if (read === undefined) throw new Error(`the core answered ${request.query} in another shape`)
  return read
}
