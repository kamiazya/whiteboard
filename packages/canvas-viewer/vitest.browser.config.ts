import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'
import { sharedBrowserTestConfig } from '../../vitest.browser.shared.js'

export default defineProject({
  plugins: [react()],
  test: {
    name: 'canvas-viewer-browser',
    include: ['src/**/*.browser.test.tsx'],
    browser: sharedBrowserTestConfig({ projectRoot: import.meta.dirname }),
  },
})
