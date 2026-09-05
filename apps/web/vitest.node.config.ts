import { defineConfig } from 'vitest/config'
import { rendererBuildDefine } from './renderer-build-id.js'

// Node-environment guards for build/deploy config that never reaches the
// browser: the PWA plugin options object and the static `public/_headers`
// file. These assert on the raw config values so a future edit cannot
// silently reopen the daemon/LNA fetch-interception hole (see
// vite-pwa-options.ts) or the CSP worker-src gap.
export default defineConfig({
  define: { ...rendererBuildDefine },
  test: {
    name: 'web-node',
    environment: 'node',
    // Root-level build/deploy guards by glob, not a hand list: a new root
    // test file added without editing this line used to run NOWHERE while
    // CI stayed green (src/** belongs to web-jsdom/web-browser).
    include: ['*.test.ts', 'scripts/**/*.test.ts'],
  },
})
