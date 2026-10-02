// A fetch double answers a daemon route with a JSON body. A real daemon always
// sends `Content-Type: application/json` with one, and written by hand each
// answer is four lines that can drop the header: a double that omits it is a
// double that differs from the thing it stands in for, and nothing fails until
// a client starts to care. Nothing reads the header today (`daemon-api-client`
// calls `res.json()` without looking at it), so this guard is about fidelity
// and one place to change, not about a failure it prevents now.
// `test-utils/json-response.ts` is the one place the header is attached, so a
// test builds its JSON answers through it.
//
// Both spellings of a hand-written JSON body are held: one built by
// `JSON.stringify`, and one written as a string literal that opens like JSON
// (`{` or `[`). A body that is not JSON (`'nope'`, `''`) is not governed.
// A plain object posing as a `Response` (`{ ok: true, json: ... }`) is not
// matched either: it has no header to drop, and what it stands in for is
// `fetch`'s result by shape rather than a `Response`.
//
// Source is captured at build time via `?raw` rather than read at runtime, so
// this stays free of `node:fs` — apps/web is browser-only (see
// web-app-boundary.test.ts).

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(['./**/*.test.ts', './**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

// Assembled from pieces so this file does not contain the text it forbids.
const HAND_WRITTEN_JSON_RESPONSE = new RegExp(
  `${'new Response\\(\\s*'}(?:${'JSON\\.stringify\\('}|${'[\'"`]\\s*[\\[{]'})`,
)

describe('JSON responses in fetch doubles', () => {
  it('recognises both hand-written spellings and not a body that is not JSON (self-test)', () => {
    const response = (body: string) => `new ${'Response'}(${body}, { status: 200 })`
    expect(HAND_WRITTEN_JSON_RESPONSE.test(response('JSON.stringify({ a: 1 })'))).toBe(true)
    expect(HAND_WRITTEN_JSON_RESPONSE.test(response("'{}'"))).toBe(true)
    expect(HAND_WRITTEN_JSON_RESPONSE.test(response('`{"a": 1}`'))).toBe(true)
    expect(HAND_WRITTEN_JSON_RESPONSE.test(response("'[]'"))).toBe(true)
    expect(HAND_WRITTEN_JSON_RESPONSE.test(response("'nope'"))).toBe(false)
    expect(HAND_WRITTEN_JSON_RESPONSE.test(response("''"))).toBe(false)
    expect(HAND_WRITTEN_JSON_RESPONSE.test(response('bytes'))).toBe(false)
  })

  it('reaches the suite it is guarding', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200)
    expect(
      Object.values(sources).filter((source) => source.includes('jsonResponse(')).length,
    ).toBeGreaterThan(20)
  })

  it('are built by jsonResponse, never by hand', () => {
    const offenders = Object.entries(sources)
      .filter(([, source]) => HAND_WRITTEN_JSON_RESPONSE.test(source))
      .map(([file]) => file)
    expect(
      offenders,
      'build the answer with jsonResponse from test-utils/json-response.ts, which attaches the JSON content type',
    ).toEqual([])
  })
})
