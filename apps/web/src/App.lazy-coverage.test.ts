// App reaches every page through React.lazy(). In a test run that dynamic
// import is resolved by the dev server while a `findBy*` query counts down its
// 1000ms retry budget, so a page that is neither mocked nor pre-imported turns
// its test into a race — one that is won on an idle machine and lost under a
// full parallel suite. That is not a hypothetical: NotFoundPage was added as
// the fourth lazy page after a comment in App.test.tsx had already enumerated
// "the other three", and it flaked in CI while passing in isolation for months.
//
// A count in a comment goes stale. This does not: it reads both files and
// fails when App gains a lazy page that App.test.tsx neither mocks nor imports.
// Source is captured at build time via `?raw` rather than read at runtime, so
// this stays free of `node:fs` — apps/web is browser-only (see
// web-app-boundary.test.ts).
import appSource from './App.tsx?raw'
import testSource from './App.test.tsx?raw'
import { describe, expect, it } from 'vitest'

/** Every module path App hands to `lazy(() => import('...'))`. */
const lazyImports = (source: string): string[] =>
  [...source.matchAll(/lazy\(\s*\(\)\s*=>\s*\n?\s*import\(\s*'([^']+)'/g)].map(
    (m) => m[1] as string,
  )

describe('every page App lazy-loads is covered by App.test.tsx', () => {
  it('is either vi.mock ed or statically imported, so lazy() settles in a microtask', () => {
    const pages = lazyImports(appSource)
    // A regex that silently matched nothing would make this guard vacuous.
    expect(pages.length).toBeGreaterThan(3)

    const uncovered = pages.filter(
      (path) =>
        !testSource.includes(`vi.mock('${path}'`) && !testSource.includes(`import '${path}'`),
    )

    expect(
      uncovered,
      `App.test.tsx must vi.mock or statically import each of these, or a findBy* query races the dynamic import: ${uncovered.join(', ')}`,
    ).toEqual([])
  })
})
