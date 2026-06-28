import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isCI = !!process.env.CI

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
    // Rolldown's native binding init hangs on GitHub Actions Linux runners.
    // Skip automatic dependency discovery in CI to avoid the optimizer entirely.
    noDiscovery: isCI,
    include: isCI
      ? []
      : [
          'react',
          'react/jsx-runtime',
          'react-dom',
          'react-router-dom',
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
