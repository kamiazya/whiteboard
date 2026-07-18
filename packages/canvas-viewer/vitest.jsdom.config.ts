import { defineProject } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { widgetFontsPlugin } from './vite.widget.config.js'

export default defineProject({
  // widgetFontsPlugin resolves the `virtual:widget-fonts` module widget-entry.ts
  // imports unconditionally — needed here so widget-entry.test.tsx can import
  // that file as source, not just the production widget build.
  plugins: [react(), widgetFontsPlugin()],
  test: {
    name: 'canvas-viewer-jsdom',
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    exclude: ['src/**/*.browser.test.tsx'],
  },
})
