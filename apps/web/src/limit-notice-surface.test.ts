// @vitest-environment node
/**
 * The words a text bound is refused in exist in one place,
 * `lib/limit-notice.ts`, and this fails on any other source that writes them
 * out. Four bounds (a markdown body, a node's text, a label, a comment
 * message) are each refused by more than one door, and copy written per door
 * drifted: one bound said its limit three ways, and a count formatter was
 * declared six times so that each notice could print "8,192" the same way
 * whatever the browser's locale.
 *
 * Two probes, each derived from what the module does rather than from any
 * one sentence: the en-US count formatter, and the `-character limit` clause
 * every notice ends on. A test that wants a notice's exact words imports its
 * builder, so it passes this scan for the same reason it can never drift.
 *
 * Comments are stripped, so prose may still quote a limit. Source comes from
 * `?raw`, not `node:fs`: apps/web is browser-only and
 * `web-app-boundary.test.ts` enforces it.
 */
import { describe, expect, it } from 'vitest'
import { stripComments } from './test-utils/strip-comments.js'

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const DECLARATION = './lib/limit-notice.ts'

/**
 * The declaration, and its own unit test, which pins the words it declares.
 * This file spells its probes too, and the glob never returns its importer.
 */
const EXEMPT: ReadonlySet<string> = new Set([DECLARATION, './lib/limit-notice.test.ts'])

const PROBES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'an en-US count formatter', pattern: /Intl\.NumberFormat\(\s*['"`]en-US['"`]/ },
  { name: 'a "-character limit" sentence', pattern: /-character limit/ },
]

const code = Object.fromEntries(
  Object.entries(sources).map(([path, source]) => [path, stripComments(source)]),
)

describe('limit notice copy', () => {
  it('reads the whole app, the declaration included', () => {
    expect(Object.keys(code).length).toBeGreaterThan(500)
    for (const exempt of EXEMPT) expect(code[exempt]).toBeDefined()
    for (const { pattern } of PROBES) expect(code[DECLARATION]).toMatch(pattern)
  })

  for (const { name, pattern } of PROBES) {
    it(`is the only source writing ${name}`, () => {
      const offenders = Object.entries(code)
        .filter(([path, source]) => !EXEMPT.has(path) && pattern.test(source))
        .map(([path]) => path)
      expect(offenders, `import the notice from ${DECLARATION} instead`).toEqual([])
    })
  }
})
