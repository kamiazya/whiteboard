import { describe, expect, it } from 'vitest'
import { mcpSourceAlias } from './mcp-source-alias.js'
import viteConfig from './vite.config.js'
import vitestBrowserConfig from './vitest.browser.config.js'
import vitestConfig from './vitest.config.js'
import vitestDocsSnapshotsConfig from './vitest.docs-snapshots.config.js'

// vite/vitest's `defineConfig` overloads also accept a factory function or a
// promise (`(env) => UserConfig`, `Promise<UserConfig>`); none of the four
// configs below use that form today, but resolving generically keeps the
// guard from silently no-op'ing if one switches to it later.
async function resolveAlias(config: unknown): Promise<Record<string, unknown>> {
  const resolved =
    typeof config === 'function'
      ? (config as (env: { mode: string; command: string }) => unknown)({
          mode: 'test',
          command: 'serve',
        })
      : config
  const awaited = (await resolved) as { resolve?: { alias?: Record<string, unknown> } }
  return awaited.resolve?.alias ?? {}
}

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
  ] as const)('%s aliases every mcpSourceAlias key to its source path', async (_name, config) => {
    const alias = await resolveAlias(config)
    for (const [key, value] of Object.entries(mcpSourceAlias)) {
      expect(alias[key]).toBe(value)
    }
  })
})
