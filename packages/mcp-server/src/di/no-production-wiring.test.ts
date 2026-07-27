import { describe, expect, it } from 'vitest'

/**
 * storeMemoryModule/createContainer/the InMemory doubles are a test-level
 * composition, not something the live server wires up yet. Real store
 * implementations (libSQL/fs) land in a later slice and bind into the same
 * container factory — until then, production entrypoints must stay free of
 * this surface so a reviewer sees at a glance that it isn't load-bearing.
 *
 * Sources are captured via Vite's build-time `import.meta.glob` (raw text),
 * not `node:fs` at runtime, so a bad glob pattern fails loudly (empty match)
 * instead of silently scanning nothing.
 */
const productionSources = {
  ...import.meta.glob('../server/index.ts', { query: '?raw', eager: true, import: 'default' }),
  ...import.meta.glob('../server/app.ts', { query: '?raw', eager: true, import: 'default' }),
  ...import.meta.glob('../server/entrypoint.ts', {
    query: '?raw',
    eager: true,
    import: 'default',
  }),
  ...import.meta.glob('../server/http-server.ts', {
    query: '?raw',
    eager: true,
    import: 'default',
  }),
  ...import.meta.glob('../server/server-mode-http.ts', {
    query: '?raw',
    eager: true,
    import: 'default',
  }),
  ...import.meta.glob('../server/mcp/**/*.ts', { query: '?raw', eager: true, import: 'default' }),
  ...import.meta.glob('../server/routes/**/*.ts', {
    query: '?raw',
    eager: true,
    import: 'default',
  }),
} as Record<string, string>

const FORBIDDEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: 'static import of di/store-memory.module',
    pattern: /from\s+['"].*di\/store-memory\.module/,
  },
  { name: 'static import of di/container', pattern: /from\s+['"].*di\/container/ },
  {
    name: 'dynamic import of di/store-memory.module',
    pattern: /import\(['"].*di\/store-memory\.module/,
  },
  { name: 'dynamic import of di/container', pattern: /import\(['"].*di\/container/ },
  { name: 'server/store/inmemory import', pattern: /server\/store\/inmemory/ },
  { name: 'bare createContainer identifier', pattern: /\bcreateContainer\b/ },
  { name: 'bare storeMemoryModule identifier', pattern: /\bstoreMemoryModule\b/ },
]

function isProductionSource(path: string): boolean {
  return !path.includes('.test.')
}

describe('DI/in-memory composition stays out of production wiring', () => {
  const productionEntries = Object.entries(productionSources).filter(([path]) =>
    isProductionSource(path),
  )

  it('scans at least one production composition entrypoint', () => {
    expect(productionEntries.length).toBeGreaterThan(0)
  })

  it.each(productionEntries)('%s does not import the DI/in-memory surface', (path, contents) => {
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      expect(pattern.test(contents), `${path} matched forbidden pattern: ${name}`).toBe(false)
    }
  })
})
