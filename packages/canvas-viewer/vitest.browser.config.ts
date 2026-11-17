import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'
import { browserTracesSetup, sharedBrowserTestConfig } from '../../vitest.browser.shared.js'

export default defineProject({
  plugins: [react()],
  test: {
    name: 'canvas-viewer-browser',
    include: ['src/**/*.browser.test.tsx', 'src/**/*.browser.test.ts'],
    globalSetup: [browserTracesSetup],
    // The browser realm has no `process.env`: a test whose premise can skip
    // asks this, so the skip is impossible on CI (test-authoring rule 9).
    provide: { onCi: process.env.CI === 'true' },
    browser: sharedBrowserTestConfig(),
  },
})
