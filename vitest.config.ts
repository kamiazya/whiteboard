import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/mcp-server/vitest.node.config.ts',
      'packages/mcp-server/vitest.smoke.config.ts',
      'packages/canvas-model/vitest.node.config.ts',
      'packages/canvas-viewer/vitest.node.config.ts',
      'packages/canvas-viewer/vitest.jsdom.config.ts',
      'packages/canvas-viewer/vitest.browser.config.ts',
      'apps/web/vitest.config.ts',
      'apps/web/vitest.node.config.ts',
      'apps/web/vitest.browser.config.ts',
    ],
  },
})
