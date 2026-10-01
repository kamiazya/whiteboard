// A fetch double answers a daemon route with a JSON body, and
// `daemon-api-client` reads the `Content-Type` before it parses one. Written
// by hand each answer is four lines that can drop the header, and the drift
// is silent: a double that omits it reads the same as one that sends it
// until a client starts to care. `test-utils/json-response.ts` is the one
// place the header is attached, so a test builds its JSON answers through it.
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

// Assembled from two pieces so this file does not contain the text it forbids.
const HAND_WRITTEN_JSON_RESPONSE = new RegExp(`${'new Response\\(\\s*'}${'JSON\\.stringify\\('}`)

describe('JSON responses in fetch doubles', () => {
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
