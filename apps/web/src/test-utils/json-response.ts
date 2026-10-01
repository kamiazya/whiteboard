/**
 * A JSON `Response` for a fetch double, as a daemon answers one.
 *
 * Written by hand in eighteen test files before this existed, each the same
 * four lines; the headers matter, because `daemon-api-client` reads the
 * content type before it parses a body.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
