import { describe, expect, it } from 'vitest'

/**
 * OpenCanvas cutover guard: `@excalidraw/excalidraw` must not creep back into
 * apps/web's editor surfaces. Sources are captured via Vite's build-time
 * `import.meta.glob` (raw text), NOT `node:fs` at runtime, so this file
 * scans every source file the same way `canvas-render`'s import-guard.test.ts
 * does (see that file's doc comment).
 *
 * `excalidraw-asset-path.ts` (+ its test) and `docs-snapshots/*` are the
 * intended end state for this dependency; no other source file should
 * reference `@excalidraw/excalidraw` in an import position.
 *
 * The pattern samples further down are import statements in string form and
 * would trip the scan — they do not, because `import.meta.glob` never returns
 * the module that calls it. Moving those samples into a separate file would
 * make this guard flag that file.
 */
const sourceModules = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/**
 * Every import position the package can be reached from, not just the ones
 * this repo happens to use today:
 *
 * - `from '…'`      — static named/default imports AND `export … from`
 * - `import '…'`    — side-effect imports, which have no `from` clause. This
 *                     is how the stylesheet was pulled in, so a pattern
 *                     without it would let the heaviest form back in silently.
 * - `import('…')`   — dynamic import
 * - `require('…')`  — CJS interop
 *
 * The trailing `[^'"]*` admits subpaths (`/index.css`, `/types`) — matching
 * only the bare specifier would miss every deep import.
 */
const EXCALIDRAW_IMPORT_PATTERN =
  /(?:from|import|require)\s*\(?\s*['"]@excalidraw\/excalidraw[^'"]*['"]/

const ALLOWED_PATH_SUBSTRINGS = [
  '/excalidraw-asset-path.ts',
  '/excalidraw-asset-path.test.ts',
  '/docs-snapshots/',
]

function isAllowed(path: string): boolean {
  return ALLOWED_PATH_SUBSTRINGS.some((substr) => path.includes(substr))
}

describe('excalidraw import guard', () => {
  const allSources = Object.entries(sourceModules)

  it('scans at least one source file', () => {
    expect(allSources.length).toBeGreaterThan(0)
  })

  it('finds at least one file that legitimately imports @excalidraw/excalidraw', () => {
    // Sanity check for the guard itself: if this ever finds zero matches, the
    // pattern below is vacuously passing (see review-gate's "reject guards
    // that cannot fail").
    const matches = allSources.filter(([, contents]) => EXCALIDRAW_IMPORT_PATTERN.test(contents))
    expect(matches.length).toBeGreaterThan(0)
  })

  // Pins the pattern itself. The scan above can only fail when a real
  // violation exists, so a weakened regex would go unnoticed until the day it
  // was needed — these samples make the weakening fail immediately instead.
  it.each([
    ['side-effect stylesheet', "import '@excalidraw/excalidraw/index.css'"],
    ['side-effect bare', "import '@excalidraw/excalidraw'"],
    ['static named', "import { Excalidraw } from '@excalidraw/excalidraw'"],
    ['static default', "import Excalidraw from '@excalidraw/excalidraw'"],
    ['type-only', "import type { AppState } from '@excalidraw/excalidraw/types'"],
    ['re-export', "export { Excalidraw } from '@excalidraw/excalidraw'"],
    ['dynamic', "const m = await import('@excalidraw/excalidraw')"],
    ['require', "const m = require('@excalidraw/excalidraw')"],
  ])('the pattern catches a %s import', (_form, sample) => {
    expect(EXCALIDRAW_IMPORT_PATTERN.test(sample)).toBe(true)
  })

  it('the pattern does not fire on a prose mention', () => {
    // A comment naming the package is not an import; flagging one would push
    // authors to stop documenting the dependency.
    expect(EXCALIDRAW_IMPORT_PATTERN.test('// must run before @excalidraw/excalidraw loads')).toBe(
      false,
    )
  })

  it.each(
    allSources.filter(([path]) => !isAllowed(path)),
  )('%s does not import @excalidraw/excalidraw', (path, contents) => {
    expect(EXCALIDRAW_IMPORT_PATTERN.test(contents), `${path} imports @excalidraw/excalidraw`).toBe(
      false,
    )
  })
})
