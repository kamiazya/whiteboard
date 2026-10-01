/**
 * An ADAPTER never composes its own dependencies.
 *
 * `server/routes/**` and `server/mcp/**` are ADR-0018's adapters: they
 * translate a request onto an operation the composition root handed them.
 * For a long time most routers also carried a fallback — "no `serverDeps`?
 * resolve the production wiring yourself through `di/`" — which read as a
 * convenience and was a second composition path: fourteen call sites in
 * eight files built `ServerDeps` of their own, none of them carrying what
 * the root attaches (the live-audience notifier), and a router threaded
 * without the field compiled clean and passed every test that only ever
 * took the fallback. `serverDeps` is required now, and this scan is what
 * keeps the fallback from growing back: an adapter that imports the di
 * graph fails here, whatever it imports it for.
 *
 * The one adapter-adjacent module allowed to know the graph is the stdio
 * root (`server/mcp/index.ts`), which IS a composition root — it has nobody
 * above it to hand deps down — so it is listed by name rather than by
 * pattern.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, walk } from './scan-roots.js'

const SERVER_ROOT = join(REPO_ROOT, 'packages/mcp-server/src/server')
const ADAPTER_DIRS = ['routes', 'mcp'] as const
/** Composition roots that live beside the adapters; each carries its reason. */
const COMPOSITION_ROOTS_AMONG_ADAPTERS: ReadonlySet<string> = new Set([
  // The packaged stdio entry: it is the root, so it resolves its own deps.
  'mcp/index.ts',
])
// Static and dynamic alike: the SSE router's fallback hid behind `await import`.
const DI_IMPORT = /(?:from\s+|import\()\s*'(?:\.\.\/)+di\//

// `_test-helpers.ts` is a test utility that happens to live beside the
// routes; it builds deps for tests the way a root would.
const isAdapterFile = (full: string): boolean =>
  full.endsWith('.ts') && !/(\.test|_test-helpers)\.ts$/.test(full)

describe('an adapter never imports the di graph', () => {
  const files = ADAPTER_DIRS.flatMap((dir) =>
    walk(join(SERVER_ROOT, dir), { include: isAdapterFile }),
  )

  it('scans the adapter population', () => {
    // A walk that found nothing would pass the rule vacuously.
    expect(files.length).toBeGreaterThan(40)
  })

  it('finds no route or MCP adapter resolving its own ServerDeps through di/', () => {
    const offenders = files
      .map((full) => relative(SERVER_ROOT, full))
      .filter((rel) => !COMPOSITION_ROOTS_AMONG_ADAPTERS.has(rel))
      .filter((rel) => DI_IMPORT.test(readFileSync(join(SERVER_ROOT, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('lists no composition root that has stopped importing di/', () => {
    const stale = [...COMPOSITION_ROOTS_AMONG_ADAPTERS].filter(
      (rel) => !DI_IMPORT.test(readFileSync(join(SERVER_ROOT, rel), 'utf8')),
    )
    expect(stale).toEqual([])
  })
})
