import { defineConfig } from 'vitest/config'

// One vitest process over all three halves, so `pnpm test <file>` filters each
// project rather than only the last command of a chained script.
export default defineConfig({
  test: {
    projects: ['./vitest.node.config.ts', './vitest.jsdom.config.ts', './vitest.browser.config.ts'],
  },
})
