import { defineProject } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineProject({
  plugins: [react()],
  test: {
    name: 'canvas-viewer-jsdom',
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    exclude: ['src/**/*.browser.test.tsx'],
  },
})
