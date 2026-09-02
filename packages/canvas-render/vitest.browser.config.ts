import { defineProject } from 'vitest/config'
import { sharedBrowserTestConfig } from '../../vitest.browser.shared.js'

export default defineProject({
  test: {
    name: 'canvas-render-browser',
    include: ['src/**/*.browser.test.ts'],
    browser: sharedBrowserTestConfig({ projectRoot: import.meta.dirname }),
  },
})
