/**
 * A JSON `Response` for a fetch double, as a daemon answers one.
 *
 * The header matters, because `daemon-api-client` reads the content type
 * before it parses a body; `json-response-guard.test.ts` keeps a test from
 * writing the same four lines by hand.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
