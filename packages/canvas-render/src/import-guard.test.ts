import { describe, expect, it } from 'vitest'

/**
 * Shared-layer boundary guard: this package must run unchanged on Node,
 * the browser, and Cloudflare Workers, so its production sources may
 * import none of `node:*`, a bare DOM global, or `inversify`.
 *
 * Sources are captured via Vite's build-time `import.meta.glob` (raw text),
 * NOT `node:fs` at runtime, so the guard test itself never imports a
 * `node:*` specifier while still scanning every production source file.
 */
const sourceModules = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const FORBIDDEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'node: specifier', pattern: /from\s+['"]node:/ },
  { name: 'bare DOM global (document)', pattern: /\bdocument\./ },
  { name: 'bare DOM global (window)', pattern: /\bwindow\./ },
  { name: 'bare DOM global (navigator)', pattern: /\bnavigator\./ },
  { name: 'bare DOM global (HTMLElement)', pattern: /\bHTMLElement\b/ },
  { name: 'inversify import', pattern: /from\s+['"]inversify['"]/ },
]

function isProductionSource(path: string): boolean {
  return !path.includes('.test.') && !path.includes('.browser.test.')
}

describe('shared-layer import guard', () => {
  const productionSources = Object.entries(sourceModules).filter(([path]) =>
    isProductionSource(path),
  )

  it('scans at least one production source file', () => {
    expect(productionSources.length).toBeGreaterThan(0)
  })

  it.each(productionSources)('%s has no forbidden platform import', (path, contents) => {
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      expect(pattern.test(contents), `${path} matched forbidden pattern: ${name}`).toBe(false)
    }
  })
})
