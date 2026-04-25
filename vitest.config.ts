import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/mcp-server/vitest.node.config.ts',
      'packages/mcp-server/vitest.jsdom.config.ts',
      'packages/mcp-server/vitest.browser.config.ts',
    ],
  },
})
