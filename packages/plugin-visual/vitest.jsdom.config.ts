import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: { name: 'plugin-visual-jsdom', environment: 'jsdom', include: ['src/**/*.test.tsx'] },
})
