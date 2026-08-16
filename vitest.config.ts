import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/mcp-server/vitest.node.config.ts',
      'packages/mcp-server/vitest.smoke.config.ts',
      'packages/model/vitest.node.config.ts',
      'packages/ports/vitest.node.config.ts',
      'packages/codec/vitest.node.config.ts',
      'tools/arch-lint/vitest.node.config.ts',
      'packages/loro-adapter/vitest.node.config.ts',
      'packages/server-core/vitest.node.config.ts',
      'packages/canvas-render/vitest.node.config.ts',
      'packages/canvas-render/vitest.browser.config.ts',
      'packages/canvas-viewer/vitest.node.config.ts',
      'packages/canvas-viewer/vitest.jsdom.config.ts',
      'packages/canvas-viewer/vitest.browser.config.ts',
      'apps/web/vitest.config.ts',
      'apps/web/vitest.node.config.ts',
      'apps/web/vitest.browser.config.ts',
    ],
  },
})
