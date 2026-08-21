// `userEvent.keyboard` / `userEvent.type` synthesize one key event per
// character — except for characters with no keycode (CJK, em dash, …), which
// are synthesized OUT OF BAND from the plain keystrokes around them. Under a
// loaded parallel browser run that out-of-band synthesis is the part that
// goes missing: measured as `'# Hello from an agent  edited here'` — both
// spaces present, the em dash gone — indistinguishable from an edit that
// never reached the backend. Non-ASCII input belongs in `userEvent.fill`
// (one atomic value set) instead.
//
// Source is captured at build time via `?raw` rather than read at runtime,
// so this stays free of `node:fs` — apps/web is browser-only (see
// web-app-boundary.test.ts).

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(['./**/*.browser.test.ts', './**/*.browser.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * Every string literal passed as the FIRST argument of a `.keyboard(` /
 * `.type(` call, however the userEvent object was named (`userEvent.keyboard`,
 * `user.keyboard` from `userEvent.setup()`, …) — matching the method, not the
 * receiver, so an alias cannot slip past. `.type(`'s first argument is the
 * element, so its TEXT is the second literal; matching any literal between
 * the paren and the line end covers both shapes without an AST.
 */
const KEY_SYNTHESIS_CALL = /\.(?:keyboard|type)\(([^)\n]*)/g

const NON_ASCII = /[^\x20-\x7E\t]/

function offendingCalls(source: string): string[] {
  const hits: string[] = []
  for (const match of source.matchAll(KEY_SYNTHESIS_CALL)) {
    if (NON_ASCII.test(match[1])) hits.push(match[0])
  }
  return hits
}

describe('browser tests type ASCII', () => {
  it('found the browser test population and real key-synthesis calls', () => {
    // A glob that silently matches nothing would pass the rule vacuously.
    const files = Object.keys(sources)
    expect(files.length).toBeGreaterThan(100)
    const totalCalls = Object.values(sources).flatMap((s) =>
      Array.from(s.matchAll(KEY_SYNTHESIS_CALL)),
    ).length
    expect(totalCalls).toBeGreaterThan(50)
  })

  it('detects a non-ASCII literal in a key-synthesis call (self-test)', () => {
    expect(offendingCalls(`await userEvent.keyboard('リリース計画')`)).toHaveLength(1)
    expect(offendingCalls(`await user.type(input, '計画')`)).toHaveLength(1)
    expect(offendingCalls('await userEvent.keyboard(`—dash`)')).toHaveLength(1)
    expect(offendingCalls(`await userEvent.keyboard('{Enter}plain ascii')`)).toHaveLength(0)
  })

  it('no browser test feeds non-ASCII through userEvent.keyboard/type', () => {
    const offenders = Object.entries(sources).flatMap(([file, source]) =>
      offendingCalls(source).map((call) => `${file}: ${call}`),
    )
    expect(offenders).toEqual([])
  })
})
