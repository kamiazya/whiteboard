import { describe, expect, it } from 'vitest'
import { mcpSourceAlias } from './mcp-source-alias.js'
import viteConfig from './vite.config.js'
import vitestBrowserConfig from './vitest.browser.config.js'
import vitestConfig from './vitest.config.js'
import vitestDocsSnapshotsConfig from './vitest.docs-snapshots.config.js'
import { workerSafeDepsAlias } from './worker-safe-deps-alias.js'

// Each config below independently resolves `@kamiazya/whiteboard-mcp/*`
// subpaths to source (see mcp-source-alias.ts). A subpath added to
// mcp-source-alias.ts that a config forgets to spread resolves through the
// package's export map instead — silently stale `dist` on a machine that has
// built once, and an outright failure on a clean checkout. This test is what
// turns that drift class into a red test instead of a silent stale build.
describe('mcpSourceAlias coverage across apps/web configs', () => {
  it.each([
    ['vite.config.ts', viteConfig],
    ['vitest.config.ts', vitestConfig],
    ['vitest.browser.config.ts', vitestBrowserConfig],
    ['vitest.docs-snapshots.config.ts', vitestDocsSnapshotsConfig],
  ] as const)('%s aliases every mcpSourceAlias key to its source path', (_name, config) => {
    // All four configs export a plain object; a switch to defineConfig's
    // factory/promise form leaves `alias` empty here, which fails red.
    const alias = (config.resolve?.alias ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(mcpSourceAlias)) {
      expect(alias[key]).toBe(value)
    }
  })

  // Same drift class, worse failure mode: the browser config's copy is the one
  // every test exercises, so a vite.config.ts that lost the pin would ship a
  // production worker chunk that throws `document is not defined` at
  // evaluation while the whole suite stays green.
  it.each([
    ['vite.config.ts', viteConfig],
    ['vitest.browser.config.ts', vitestBrowserConfig],
  ] as const)('%s aliases every workerSafeDepsAlias key', (_name, config) => {
    const alias = (config.resolve?.alias ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(workerSafeDepsAlias)) {
      expect(alias[key]).toBe(value)
    }
  })
})
