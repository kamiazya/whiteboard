// Vitest project that regenerates the screenshots committed under
// docs/assets/. Run via `pnpm docs:snapshots` (NOT part of the default
// `pnpm test` run — it writes into the repo and is slower than the
// regular browser project).
//
// Each test file under src/docs-snapshots/**/*.docs-snapshot.test.tsx
// mounts a component with deterministic mocked data, waits for the
// relevant DOM to settle, and calls `page.screenshot({ path:
// <repo>/docs/assets/... })` so the source-of-truth image lives next to
// the markdown that embeds it.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import svgr from 'vite-plugin-svgr'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'
import { defineConfig } from 'vitest/config'
import { resolveBrowserLaunchOptions } from '../../packages/mcp-server/src/server/browser-test-config.js'
import { mcpSourceAlias } from './mcp-source-alias.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Absolute path so test files can ship a single string literal to
// page.screenshot regardless of the CWD vitest is launched from. Inlined
// at build time via `define` because the test code runs in the browser
// where node:path / node:url are unavailable.
const DOCS_ASSETS_DIR = resolve(__dirname, '..', '..', 'docs', 'assets')

export default defineConfig({
  define: {
    __DOCS_ASSETS_DIR__: JSON.stringify(DOCS_ASSETS_DIR),
  },
  // The doc-snapshot tests need to read existing scene fixtures (e.g.
  // docs/assets/architecture.canvas) as raw JSON Canvas text so they can
  // parse and render them without an extra fixture-copy step. Vite's
  // default allow-list is the package root; widen it to the repo root
  // so the `@docs-assets/...` alias resolves under `docs/assets/`.
  server: {
    fs: { allow: [resolve(__dirname, '..', '..')] },
  },
  resolve: {
    alias: {
      ...mcpSourceAlias,
      // '@' matches vitest.config.ts / tsconfig's app-source root.
      '@': resolve(__dirname, 'src'),
      // '@docs-assets' is unique to this config: only the snapshot fixtures
      // that generate docs/assets/ need to read files under docs/assets/.
      '@docs-assets': DOCS_ASSETS_DIR,
    },
  },
  plugins: [tailwindcss(), react(), svgr(), wasm(), topLevelAwait()],
  test: {
    name: 'web-docs-snapshots',
    include: ['src/docs-snapshots/**/*.docs-snapshot.test.tsx'],
    setupFiles: ['./src/docs-snapshots/_setup.ts'],
    css: true,
    // Generous timeout: each test mounts a real component, waits for
    // network-mocked content and fonts to settle, then writes a PNG to
    // disk. Cold-start on the first test in the suite can take several
    // seconds even before any rendering.
    testTimeout: 30_000,
    api: { host: '127.0.0.1' },
    browser: {
      enabled: true,
      headless: true,
      // Doc screenshots are not regression assertions — they are the
      // generated artifact. Failing the test on a bitmap diff would
      // defeat the "regenerate to update" workflow.
      screenshotFailures: false,
      // Fixed viewport so screenshots are reproducible across machines
      // (within OS-font-rendering noise). Match the README hero width
      // so `width="780"` in the markup does not get heavily downscaled.
      viewport: { width: 1280, height: 800 },
      provider: playwright({
        launchOptions: resolveBrowserLaunchOptions(process.env),
        // Animated brand surfaces (the onboarding hero plays the boot-splash
        // story inside an <img>) would put a different mid-animation frame in
        // every regeneration. Reduced motion collapses them to their static
        // landing frame — the same truth reduced-motion users see — and a
        // page-side style injection cannot reach inside an <img>'s SVG
        // document, so the context option is the only lever that works.
        contextOptions: { reducedMotion: 'reduce' },
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
})
