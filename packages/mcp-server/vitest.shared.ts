import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { defineConfig } from 'vitest/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root: __dirname,
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './tmp/coverage',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.*', '**/*.smoke-impl.ts', '**/*.distribution-impl.ts', 'dist/**'],
    },
  },
})
