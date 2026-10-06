// @vitest-environment node
/**
 * What an unnamed document is called is derived in one place,
 * `lib/document-label.ts`, and this fails on any other source that derives
 * it by hand. Written per surface, the derivation was spelled seventeen ways
 * under two rules, and one keeper decoded "unnamed" by comparing a name with
 * its path — so a name somebody typed equal to the path read as none.
 *
 * Three probes, one per way the derivation was written: a name falling back
 * to a path, a path's last segment cut off with `split('/')`, and a name
 * compared against a path. Which RULE a surface uses (the leaf or the whole
 * path) is that surface's choice; how the rule is applied is not.
 *
 * Production source only: a test double that stands in for the daemon may
 * spell the daemon's own fallback, and a test may split a URL. Comments are
 * stripped. Source comes from `?raw`, not `node:fs`: apps/web is
 * browser-only and `web-app-boundary.test.ts` enforces it.
 */
import { describe, expect, it } from 'vitest'
import { stripComments } from './test-utils/strip-comments.js'

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const DECLARATION = './lib/document-label.ts'

const isProduction = (path: string): boolean =>
  !/\.test\.tsx?$/.test(path) && !path.startsWith('./test-utils/')

const PROBES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'a name falling back to a path',
    pattern: /\.name\s*\?\?\s*[\w$][\w$.?]*\.path\b/,
  },
  {
    name: "a path's last segment as a label",
    pattern: /split\(\s*['"`]\/['"`]\s*\)\s*\.\s*(?:at\(\s*-1\s*\)|pop\(\s*\))/,
  },
  {
    name: 'a name compared against a path',
    pattern: /\.name\s*[!=]==?\s*[\w$][\w$.?]*\.path\b|\.path\s*[!=]==?\s*[\w$][\w$.?]*\.name\b/,
  },
]

/** What each probe must catch, and the near-misses it must leave alone. */
const PROBE_FIXTURES: Readonly<
  Record<string, { readonly caught: readonly string[]; readonly passed: readonly string[] }>
> = {
  'a name falling back to a path': {
    caught: ['entry.name ?? entry.path', 'node.canvas?.name ?? node.canvas.path'],
    passed: ["entry.name ?? 'Untitled'", 'row.path === path', 'here?.name ?? fallback'],
  },
  "a path's last segment as a label": {
    caught: ["path.split('/').at(-1)", 'doc.path.split("/").pop()'],
    passed: ["path.split('/')", "name.split('.').at(-1)", "path.slice(0, path.lastIndexOf('/'))"],
  },
  'a name compared against a path': {
    caught: ['snap.name === snap.path', 'entry.path !== entry.name'],
    passed: ['snap.name === null', 'row.path === path', 'a.name === b.name'],
  },
}

const code = Object.fromEntries(
  Object.entries(sources)
    .filter(([path]) => isProduction(path))
    .map(([path, source]) => [path, stripComments(source)]),
)

describe('unnamed document labels', () => {
  it('catches the variant spellings of each probe (self-test)', () => {
    for (const { name, pattern } of PROBES) {
      const fixtures = PROBE_FIXTURES[name]
      expect(fixtures, name).toBeDefined()
      for (const text of fixtures?.caught ?? []) expect(text, name).toMatch(pattern)
      for (const text of fixtures?.passed ?? []) expect(text, name).not.toMatch(pattern)
    }
  })

  it('reads the whole app, the declaration included', () => {
    expect(Object.keys(code).length).toBeGreaterThan(500)
    expect(code[DECLARATION]).toBeDefined()
  })

  for (const { name, pattern } of PROBES) {
    it(`leaves ${name} to the declaration`, () => {
      const offenders = Object.entries(code)
        .filter(([path, source]) => path !== DECLARATION && pattern.test(source))
        .map(([path]) => path)
      expect(offenders, `call documentLabel from ${DECLARATION} instead`).toEqual([])
    })
  }
})
