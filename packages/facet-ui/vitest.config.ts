import { defineConfig } from 'vitest/config'

// A bare `vitest run` goes through this aggregate rather than naming
// `vitest.jsdom.config.ts`: vitest removes a project's scratch directory on close,
// while a single non-aggregate config runs as an instance whose
// `<tmpdir>/<id>/ssr` copy of the transformed modules is never removed.
export default defineConfig({
  test: {
    projects: ['./vitest.jsdom.config.ts'],
  },
})
