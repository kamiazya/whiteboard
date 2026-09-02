/**
 * The one spelling of "what do we call this thrown thing" — previously
 * copy-pasted verbatim into five files, where a behavior change (an
 * `AggregateError`, a `cause` chain, a non-Error throw) would have had to
 * find every copy by hand.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}
