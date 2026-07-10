import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './tmp/coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/*.smoke-impl.ts',
        '**/*.distribution-impl.ts',
        'src/app/components/ui/**',
        'dist/**',
      ],
    },
  },
  optimizeDeps: {
    include: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      // Vitest browser mode fetches test dependencies through the Vite dev
      // server on demand instead of bundling them ahead of time. Under CI
      // load the lazy dependency-optimization scan can race with the
      // browser's first fetch of one of these modules, producing a spurious
      // "Failed to fetch dynamically imported module" import error unrelated
      // to the test itself. Listing every browser test's transitive deps
      // here forces them into the pre-bundle before any test file runs.
      'react-dom/client',
      'react-router-dom',
      '@testing-library/react',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-tooltip',
    ],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/app'),
    },
  },
})
