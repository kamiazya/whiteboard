// @vitest-environment node
import { describe, expect, it } from 'vitest'
import pkgJson from '../../../package.json' with { type: 'json' }

// Vite's import.meta.glob (not node:fs) enumerates and reads every source
// file so this guard stays inside the Node-builtin-free boundary the
// web-app-boundary test enforces for all of apps/web/src.
const rawModules = import.meta.glob('/src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

describe('WebMCP: no polyfill in production bundle', () => {
  // Phase 0 relies on feature-detecting Chrome's native WebMCP surface
  // (see use-browser-tool-registry.ts) and staying a no-op elsewhere; it
  // deliberately ships without a @mcp-b/webmcp-polyfill (or equivalent)
  // dependency at all. If a future phase adds one, it must land in
  // devDependencies only, and this test should be extended to assert
  // apps/web's production build never bundles it (e.g. via a build-output
  // grep), not merely that package.json omits it.
  it('apps/web package.json has no WebMCP polyfill dependency of any kind', () => {
    const pkg = pkgJson as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const polyfillDeps = Object.keys(allDeps).filter((name) => /webmcp.*polyfill|mcp-b/i.test(name))

    expect(polyfillDeps).toEqual([])
  })

  it('no source file under apps/web/src statically imports a WebMCP polyfill package', () => {
    const offenders = Object.entries(rawModules)
      .filter(([, content]) => /from ['"].*(webmcp[-/]polyfill|mcp-b)/i.test(content))
      .map(([moduleKey]) => moduleKey)

    expect(offenders).toEqual([])
  })
})
