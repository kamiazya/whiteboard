import { describe, expect, it } from 'vitest'

/**
 * The Excalidraw export stack was deleted wholesale in favor of the
 * canvas-render + resvg headless renderer. A hoisted or transitive copy of
 * one of its dependencies could still satisfy an import that should no
 * longer exist anywhere under this directory — `pnpm build` passing is only
 * a proxy for that, since a sibling module could re-export a forbidden
 * import without this directory's own entry points ever naming it directly.
 *
 * Sources are captured via Vite's build-time `import.meta.glob` (raw text),
 * NOT `node:fs` at runtime, mirroring canvas-render's own import guard
 * (packages/canvas-render/src/import-guard.test.ts).
 */
const sourceModules = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const FORBIDDEN_MODULES = ['happy-dom', '@excalidraw/utils', '@napi-rs/canvas', 'wawoff2'] as const

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Three import forms per module: `from 'x'`, `import('x')`, and the bare
// side-effect form `import 'x'` — a module with no bindings to pull in
// (e.g. `happy-dom`'s ambient DOM globals) is imported this way, and would
// satisfy neither of the first two patterns.
const FORBIDDEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = FORBIDDEN_MODULES.flatMap(
  (moduleName) => {
    const quoted = `['"]${escapeRegExp(moduleName)}['"]`
    return [
      { name: `${moduleName} (static import)`, pattern: new RegExp(`from\\s+${quoted}`) },
      {
        name: `${moduleName} (dynamic import)`,
        pattern: new RegExp(`import\\(\\s*${quoted}\\s*\\)`),
      },
      {
        name: `${moduleName} (side-effect import)`,
        pattern: new RegExp(`import\\s+${quoted}`),
      },
    ]
  },
)

describe('src/server/export import guard', () => {
  const productionSources = Object.entries(sourceModules).filter(
    ([path]) => !path.includes('.test.'),
  )

  it('scans at least one production source file', () => {
    expect(productionSources.length).toBeGreaterThan(0)
  })

  it.each(productionSources)('%s has no forbidden Excalidraw-stack import', (path, contents) => {
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      expect(pattern.test(contents), `${path} matched forbidden pattern: ${name}`).toBe(false)
    }
  })

  it('would catch a bare side-effect import that the other two forms miss', () => {
    const syntheticSource = `import 'happy-dom'\n`
    const sideEffectPattern = FORBIDDEN_PATTERNS.find(
      (p) => p.name === 'happy-dom (side-effect import)',
    )
    if (!sideEffectPattern) throw new Error('expected a happy-dom side-effect pattern')
    expect(sideEffectPattern.pattern.test(syntheticSource)).toBe(true)
  })
})
