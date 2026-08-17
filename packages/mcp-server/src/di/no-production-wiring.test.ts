import { describe, expect, it } from 'vitest'

/**
 * storeMemoryModule/the InMemory doubles are test-only composition and must
 * never leak into production wiring. createContainer/createStoreLocalModule
 * ARE the production boot path now (real libSQL/fs implementations bound
 * through the DI container) — but the boot path must construct stores only
 * through that container, never by importing the concrete store classes
 * directly, so a reviewer can see at a glance that DI is the single wiring
 * point.
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
  {
    name: 'dynamic import of di/store-memory.module',
    pattern: /import\(['"].*di\/store-memory\.module/,
  },
  { name: 'server/store/inmemory import', pattern: /server\/store\/inmemory/ },
  { name: 'bare storeMemoryModule identifier', pattern: /\bstoreMemoryModule\b/ },
]

// The boot path (server/mcp/index.ts) must construct stores only through the
// DI container (createContainer + createStoreLocalModule), never by
// importing a concrete store class directly — that would let a manual
// `new LibsqlDocumentStore(...)` construction bypass the container and
// silently drift from what the container actually binds.
const FORBIDDEN_MANUAL_STORE_IMPORTS_IN_BOOT_PATH: readonly { name: string; pattern: RegExp }[] = [
  {
    name: 'direct import of LibsqlDocumentStore',
    pattern: /from\s+['"].*libsql-document-store/,
  },
  { name: 'direct import of FsBlobStore', pattern: /from\s+['"].*fs-blob-store/ },
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

  const bootPathEntries = productionEntries.filter(([path]) => path.includes('server/mcp/index.ts'))

  it('scans the mcp boot path entrypoint', () => {
    expect(bootPathEntries.length).toBe(1)
  })

  it.each(
    bootPathEntries,
  )('%s constructs stores only through the DI container, not by direct class import', (path, contents) => {
    for (const { name, pattern } of FORBIDDEN_MANUAL_STORE_IMPORTS_IN_BOOT_PATH) {
      expect(pattern.test(contents), `${path} matched forbidden pattern: ${name}`).toBe(false)
    }
  })
})
