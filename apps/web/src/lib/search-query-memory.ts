/**
 * The search box's text per workspace, kept for the life of the page.
 *
 * Opening a result is a route change, so the list that held the query
 * unmounts; coming back to a box that has forgotten what you searched costs
 * the search. Held in memory rather than storage on purpose: a query is a
 * moment's intent, and one that survives a reload is stale text the next
 * visit has to clear.
 */
const queries = new Map<string, string>()

export function recallSearchQuery(scope: string | undefined): string {
  return scope === undefined ? '' : (queries.get(scope) ?? '')
}

export function rememberSearchQuery(scope: string | undefined, query: string): void {
  if (scope === undefined) return
  if (query === '') queries.delete(scope)
  else queries.set(scope, query)
}
