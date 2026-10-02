import { defineProject } from 'vitest/config'
import { browserTracesSetup, sharedBrowserTestConfig } from '../../vitest.browser.shared.js'

export default defineProject({
  test: {
    name: 'canvas-render-browser',
    include: ['src/**/*.browser.test.ts'],
    globalSetup: [browserTracesSetup],
    browser: sharedBrowserTestConfig(),
  },
})
