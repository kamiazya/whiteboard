import { describe, expect, it } from 'vitest'

/**
 * OpenCanvas cutover guard: `@excalidraw/excalidraw` must not creep back into
 * apps/web's editor surfaces. Sources are captured via Vite's build-time
 * `import.meta.glob` (raw text), NOT `node:fs` at runtime, so this file
 * scans every source file the same way `canvas-render`'s import-guard.test.ts
 * does (see that file's doc comment) — covering static, side-effect, and
 * dynamic (`import(...)`) import forms in one regex pass.
 *
 * The dependency itself, `excalidraw-asset-path.ts` (+ its test), `main.tsx`,
 * and `docs-snapshots/*` are the intended end state for this dependency —
 * see `tmp/notes/opencanvas-cutover-design.md`'s D4/slice-D notes. The three
 * `lib/commands/*` / `lib/canvas-sync-export.ts` files below are a TEMPORARY
 * allowlist entry for the still-live `exportJson` command chain, tracked as
 * its own follow-up (removing `exportJson`/`getSceneSummary` rather than
 * porting them) — this allowlist entry shrinks to zero when that lands.
 */
const sourceModules = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const EXCALIDRAW_IMPORT_PATTERN =
  /from\s+['"]@excalidraw\/excalidraw[^'"]*['"]|import\(\s*['"]@excalidraw\/excalidraw/

const ALLOWED_PATH_SUBSTRINGS = [
  '/excalidraw-asset-path.ts',
  '/excalidraw-asset-path.test.ts',
  '/main.tsx',
  '/docs-snapshots/',
  // Temporary — the still-live exportJson command chain (Task #20 removes
  // rather than ports it; see this file's doc comment).
  '/lib/canvas-sync-export.ts',
  '/lib/commands/excalidraw-json.ts',
  '/lib/commands/types.ts',
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

  it.each(
    allSources.filter(([path]) => !isAllowed(path)),
  )('%s does not import @excalidraw/excalidraw', (path, contents) => {
    expect(EXCALIDRAW_IMPORT_PATTERN.test(contents), `${path} imports @excalidraw/excalidraw`).toBe(
      false,
    )
  })
})
