import { defineConfig } from 'vitest/config'
import jsdom from './vitest.config.ts'

// What `scripts/run-web-tests.mjs` runs each half through, one `--project`
// at a time. A single non-aggregate config runs as a vitest instance whose
// `<tmpdir>/<id>/ssr` copy of the transformed modules is never removed, while
// each project's own scratch directory is removed on close.
//
// `onUnhandledError` is read from the ROOT config only, so the jsdom
// config's filter is carried up here or it would stop applying.
export default defineConfig({
  test: {
    onUnhandledError: jsdom.test?.onUnhandledError,
    projects: ['./vitest.config.ts', './vitest.node.config.ts'],
  },
})
