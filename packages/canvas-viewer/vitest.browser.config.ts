import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'
import { browserTracesSetup, sharedBrowserTestConfig } from '../../vitest.browser.shared.js'

export default defineProject({
  plugins: [react()],
  test: {
    name: 'canvas-viewer-browser',
    include: ['src/**/*.browser.test.tsx', 'src/**/*.browser.test.ts'],
    globalSetup: [browserTracesSetup],
    browser: sharedBrowserTestConfig(),
  },
})
