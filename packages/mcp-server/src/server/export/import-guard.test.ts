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

const FORBIDDEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'happy-dom (static import)', pattern: /from\s+['"]happy-dom['"]/ },
  { name: 'happy-dom (dynamic import)', pattern: /import\(\s*['"]happy-dom['"]\s*\)/ },
  { name: '@excalidraw/utils (static import)', pattern: /from\s+['"]@excalidraw\/utils['"]/ },
  {
    name: '@excalidraw/utils (dynamic import)',
    pattern: /import\(\s*['"]@excalidraw\/utils['"]\s*\)/,
  },
  { name: '@napi-rs/canvas (static import)', pattern: /from\s+['"]@napi-rs\/canvas['"]/ },
  {
    name: '@napi-rs/canvas (dynamic import)',
    pattern: /import\(\s*['"]@napi-rs\/canvas['"]\s*\)/,
  },
  { name: 'wawoff2 (static import)', pattern: /from\s+['"]wawoff2['"]/ },
  { name: 'wawoff2 (dynamic import)', pattern: /import\(\s*['"]wawoff2['"]\s*\)/ },
]

function isProductionSource(path: string): boolean {
  return !path.includes('.test.')
}

describe('src/server/export import guard', () => {
  const productionSources = Object.entries(sourceModules).filter(([path]) =>
    isProductionSource(path),
  )

  it('scans at least one production source file', () => {
    expect(productionSources.length).toBeGreaterThan(0)
  })

  it.each(productionSources)('%s has no forbidden Excalidraw-stack import', (path, contents) => {
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      expect(pattern.test(contents), `${path} matched forbidden pattern: ${name}`).toBe(false)
    }
  })
})
