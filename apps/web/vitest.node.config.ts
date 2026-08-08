import { defineConfig } from 'vitest/config'

// Node-environment guards for build/deploy config that never reaches the
// browser: the PWA plugin options object and the static `public/_headers`
// file. These assert on the raw config values so a future edit cannot
// silently reopen the daemon/LNA fetch-interception hole (see
// vite-pwa-options.ts) or the CSP worker-src gap.
export default defineConfig({
  test: {
    name: 'web-node',
    environment: 'node',
    include: [
      'vite-pwa-options.test.ts',
      'public-headers.test.ts',
      'vite-dev-headers.test.ts',
      'vite-plugin-strip-wasm-sourcemap.test.ts',
      'scripts/**/*.test.ts',
    ],
  },
})
