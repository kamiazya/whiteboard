import { describe, expect, it } from 'vitest'
import viteConfig from './vite.config.js'
import vitestBrowserConfig from './vitest.browser.config.js'
import { workerSafeDepsAlias } from './worker-safe-deps-alias.js'

// The daemon-client subpaths need no alias map any more: the package's
// wildcard `exports` resolves straight to `src/*.ts`, so a clean checkout,
// `pnpm dev` and every vitest project all read the same source with no
// stale-`dist` window. workerSafeDepsAlias remains the one hand-kept map.
describe('workerSafeDepsAlias coverage across apps/web configs', () => {
  // The browser config's copy is the one
  // every test exercises, so a vite.config.ts that lost the pin would ship a
  // production worker chunk that throws `document is not defined` at
  // evaluation while the whole suite stays green. Both configs export a plain
  // object; a switch to defineConfig's factory/promise form leaves `alias`
  // empty here, which fails red.
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
