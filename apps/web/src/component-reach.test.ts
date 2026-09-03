/**
 * A component nothing renders is a component nobody can reach, and its own
 * test is what makes it look alive.
 *
 * `DocumentThumb` sat that way: 160 lines with a nine-case suite covering
 * authorized fetches, object URLs, 204 bodies and a guarded in-render state
 * reset — every one of them green, and no screen in the app importing it.
 * The suite is not the accident; it is what a reader checks and what makes
 * the module look wired.
 *
 * Measured before writing this: `pnpm knip` passes over that file, passes
 * with its test deleted, and `knip --include files` reports nothing either.
 * So the strongest tool aimed at dead code does not answer this question
 * for `apps/web`, which is why the question is asked here instead.
 *
 * What this checks is one edge, not reachability: every component module
 * under `components/` or `pages/` is IMPORTED by some module that is not a
 * test. A pair of components importing only each other would pass — that is
 * graph reachability from an entry point, which is knip's job where knip can
 * do it. One edge is enough for the shape that actually occurs: a component
 * whose call site was removed, or which was written before its screen.
 */

import { describe, expect, it } from 'vitest'

// `?raw` rather than node:fs — apps/web is browser-only and must not import a
// Node builtin (the same reason App.lazy-coverage.test.ts reads files this way).
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * A component module with no importer that is nonetheless not dead — an app
 * entry, or something a bundler reaches by a path this scan cannot see.
 *
 * Empty, and guarded from both sides below so an entry cannot outlive the
 * exemption it names. It exists so the next genuine root has a sanctioned
 * place to be written down, rather than a reason to weaken the scan.
 */
const REACHED_ANOTHER_WAY: Record<string, string> = {}

const isTest = (path: string): boolean => path.includes('.test.')

/** `/src/components/VersionThumbnail.tsx` -> `VersionThumbnail`. */
const moduleName = (path: string): string => {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.slice(0, file.indexOf('.'))
}

function componentModules(): string[] {
  return Object.keys(sources)
    .filter((path) => path.endsWith('.tsx') && !isTest(path))
    .filter((path) => path.startsWith('/src/components/') || path.startsWith('/src/pages/'))
    .sort()
}

/**
 * Whether any non-test module imports this one. Matched on the import
 * SPECIFIER rather than the component's name, because a name matches its own
 * mention in a comment — which is exactly what hid this module from a first
 * pass of this scan, and would have let a deleted call site keep a component
 * looking alive for as long as some file still talked about it.
 */
function hasProductionImporter(path: string): boolean {
  const name = moduleName(path)
  const specifier = new RegExp(
    `from\\s*['"][^'"]*/${name}(\\.jsx?)?['"]|import\\(\\s*['"][^'"]*/${name}(\\.js)?['"]`,
  )
  return Object.entries(sources).some(
    ([other, text]) => other !== path && !isTest(other) && specifier.test(text),
  )
}

describe('every component module is imported by something that is not a test', () => {
  const modules = componentModules()

  it('finds a plausible number of component modules', () => {
    // A glob that stopped matching would otherwise pass this file silently,
    // which reads exactly like a scan that checked.
    expect(modules.length).toBeGreaterThan(50)
  })

  it.each(modules)('%s', (path) => {
    if (path in REACHED_ANOTHER_WAY) return
    expect(
      hasProductionImporter(path),
      `${path} is imported by nothing but tests — render it from the screen it belongs to, delete it, or, if a bundler reaches it a way this scan cannot see, say so in REACHED_ANOTHER_WAY`,
    ).toBe(true)
  })

  it('names no exemption that has since gained an importer', () => {
    expect(
      Object.keys(REACHED_ANOTHER_WAY).filter(
        (path) => !modules.includes(path) || hasProductionImporter(path),
      ),
      'these REACHED_ANOTHER_WAY entries are stale — the module is gone or now has a real importer; delete the entry',
    ).toEqual([])
  })
})
