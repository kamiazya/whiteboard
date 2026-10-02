/**
 * A JSON `Response` for a fetch double, as a daemon answers one.
 *
 * A real daemon sends the JSON content type with a JSON body, so a double
 * should too: no client reads it today, and the first one that does would
 * otherwise pass against every double that dropped it.
 * `json-response-guard.test.ts` keeps a test from writing the same four lines
 * by hand.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
