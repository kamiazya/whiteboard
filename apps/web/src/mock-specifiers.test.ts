/**
 * `vi.mock('./x.js', factory)` names a module by a STRING, and nothing
 * checks the string. A mock for a path nothing imports is registered and
 * never consulted, so a module that moves or is deleted leaves its mocks
 * behind as silent no-ops — the test keeps passing, now against the real
 * module (or against nothing).
 *
 * Measured before writing this: two mocks of `HeaderVersionDot`, a
 * component deleted months earlier, still in place and green — and a third
 * found only because the test happened to count the spy's calls
 * (`MinimapRail.render-memo`, when `rail-geometry` moved to `lib/`). The
 * import rewrite that carries a move cannot see these; a resolver can.
 *
 * Every relative or `@/` specifier handed to `vi.mock` / `vi.doMock` /
 * `vi.unmock` / `vi.importActual` / `vi.importMock` must resolve to a
 * module the glob captured. Bare package specifiers are out of scope — a
 * package's existence is the lockfile's job.
 *
 * Sources are read via `?raw` glob, not `node:fs` — apps/web is browser-only
 * (the same reason `layer-order.test.ts` reads them that way).
 */

import { describe, expect, it } from 'vitest'

const RAW_SOURCES = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const isTest = (key: string): boolean => key.includes('.test.')

/** `vi.mock('spec', …)` and friends, string form only — `vi.mock(import('x'))` is unused here. */
function mockSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(
      /\bvi\.(?:mock|doMock|unmock|importActual|importMock)\(\s*['"]([^'"]+)['"]/g,
    ),
  ].map((m) => m[1] as string)
}

/** Resolves a specifier from a glob key to another glob key, or null for a bare package specifier. */
function resolveLocal(fromKey: string, specifier: string): { local: boolean; key: string | null } {
  let path: string
  if (specifier.startsWith('@/')) {
    path = `./${specifier.slice(2)}`
  } else if (specifier.startsWith('.')) {
    const dir = fromKey.split('/').slice(0, -1)
    for (const segment of specifier.split('/')) {
      if (segment === '.') continue
      if (segment === '..') dir.pop()
      else dir.push(segment)
    }
    path = dir.join('/')
  } else {
    return { local: false, key: null }
  }
  const stems = [path, path.replace(/\.js$/, '')]
  const candidates = stems.flatMap((stem) => [
    stem,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
  ])
  return { local: true, key: candidates.find((candidate) => candidate in RAW_SOURCES) ?? null }
}

describe('vi.mock specifiers name modules that exist', () => {
  const mocks = Object.entries(RAW_SOURCES)
    .filter(([key]) => isTest(key))
    .flatMap(([key, source]) => mockSpecifiers(source).map((specifier) => ({ key, specifier })))

  it('scans a real population of mocks', () => {
    // A resolver over a glob that matched nothing passes for the wrong reason.
    expect(
      mocks.filter(({ specifier }) => resolveLocal('./x.ts', specifier).local).length,
    ).toBeGreaterThan(50)
  })

  it('resolves every local specifier to a module', () => {
    const dangling = mocks
      .map(({ key, specifier }) => ({ key, specifier, target: resolveLocal(key, specifier) }))
      .filter((m) => m.target.local && m.target.key === null)
      .map((m) => `${m.key.slice(2)} mocks ${m.specifier}`)
    expect(
      dangling,
      'a vi.mock names a module that does not exist — it mocks nothing, so the test runs against the real module; delete it or re-point it',
    ).toEqual([])
  })
})
