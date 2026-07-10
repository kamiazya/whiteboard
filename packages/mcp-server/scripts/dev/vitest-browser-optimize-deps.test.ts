// @vitest-environment node
import { describe, expect, it } from 'vitest'
import browserConfig from '../../vitest.browser.config.js'

// Vitest browser mode fetches test dependencies through the Vite dev server
// instead of bundling them ahead of time. Under CI load the lazy
// dependency-optimization pass can race with the first HTTP fetch of a
// dynamically imported module, producing a "Failed to fetch dynamically
// imported module" error unrelated to the test's assertions. Pre-bundling
// the packages every browser test transitively imports removes that race
// at the source instead of retrying around it.
describe('mcp-server vitest.browser.config optimizeDeps', () => {
  it('pre-bundles the testing-library and react runtime deps every browser test imports', () => {
    const include = browserConfig.optimizeDeps?.include ?? []

    expect(include).toEqual(
      expect.arrayContaining([
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        'react-router-dom',
        '@testing-library/react',
      ]),
    )
  })
})
