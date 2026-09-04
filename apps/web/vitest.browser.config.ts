import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'
import { defineConfig } from 'vitest/config'
import { sharedBrowserTestConfig } from '../../vitest.browser.shared.js'
import { mcpSourceAlias } from './mcp-source-alias.js'
import { rendererBuildDefine } from './renderer-build-id.js'
import { workerSafeDepsAlias } from './worker-safe-deps-alias.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  define: { ...rendererBuildDefine },
  resolve: {
    alias: {
      ...mcpSourceAlias,
      // Matches vitest.config.ts and tsconfig's '@/*' path — needed once any
      // browser-tested component pulls in a components/ui/* file (they all
      // import '@/lib/utils' for the cn() helper).
      '@': resolve(__dirname, 'src'),
      // Subpath alias must precede the root alias: rollup-alias prefix-matches,
      // so the root entry alone would rewrite '/scene' to 'index.ts/scene'.
      '@kamiazya/whiteboard-canvas-viewer/scene': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/scene.ts',
      ),
      // The layout worker imports these two rather than the barrel, which
      // re-exports React components whose graphs touch `document`.
      '@kamiazya/whiteboard-canvas-viewer/font-loading': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/font-loading.ts',
      ),
      '@kamiazya/whiteboard-canvas-viewer/measure-text': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/measure-text.ts',
      ),
      // Resolve canvas-viewer from source so tests run before `pnpm build`.
      '@kamiazya/whiteboard-canvas-viewer': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/index.ts',
      ),
      ...workerSafeDepsAlias,
    },
  },
  // tailwindcss: layout browser tests import src/index.css to assert real
  // computed geometry (e.g. the canvas viewer container filling the viewport).
  plugins: [tailwindcss(), react(), svgr(), wasm(), topLevelAwait()],
  // Vitest browser mode serves test dependencies from the Vite dev server on
  // demand instead of bundling them ahead of time. Under CI load, the lazy
  // dependency-optimization scan can race with the browser's first fetch of
  // one of these modules, producing a spurious "Failed to fetch dynamically
  // imported module" import error unrelated to the test itself. Listing the
  // packages every browser test transitively imports forces them into the
  // pre-bundle before any test file runs, removing the race at the source.
  optimizeDeps: {
    include: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      '@testing-library/react',
    ],
  },
  test: {
    name: 'web-browser',
    include: ['src/**/*.browser.test.tsx'],
    // Browser mode's 15s default is a real ceiling here, not a safety net: a
    // test that mounts a page, drives Radix through a portal and waits on
    // IndexedDB spends most of its budget on machine time, and vitest runs
    // these files in PARALLEL. On a loaded machine that tips whole files over
    // at once — the observed failures are `Test timed out`, not assertion
    // failures, and the same tests pass 4/4 when their file runs alone.
    //
    // A timeout costs nothing while tests pass; it only decides how long a
    // genuinely hung test takes to report.
    //
    // 30s was not enough either. The costliest test here (a markdown embed
    // that types into real CodeMirror and lays the preview out through the
    // render pipeline) takes 1.5s with its file alone and 1.6s with the twelve
    // IndexedDB-heavy page files running together — but 30–39s once all 115
    // browser files are in flight. Cutting `--maxWorkers` to 4 made it WORSE
    // (33–39s, and 40% more wall clock), and the IndexedDB-contention theory
    // is refuted by the 1.6s twelve-file run.
    //
    // This comment used to conclude from that that the budget is the only
    // lever that works. It is not, and the reasoning was wrong in a way worth
    // recording: those numbers are not machine time at all. `focusEditable`'s
    // diagnostic reported `document.hasFocus()=false` on its first CI run —
    // several browser pages run in parallel and only ONE can hold focus, so a
    // test in an unfocused page waits out its whole budget on a condition
    // nothing can satisfy. That single fact explains every observation above:
    // why the victim rotates, why every one passes in isolation, and why
    // FEWER workers made it worse rather than better (same contention, longer
    // run). Asking for focus back removed ten of eleven browser failures in
    // one run, so the budget's real job is narrower than it looked — it
    // bounds a genuinely hung test, and nothing else.
    //
    // Sized on a measurement, not a guess. Post-focus-fix, with the ten
    // IndexedDB-only suites migrated to jsdom (2026-08-21, 124 files / 716
    // tests, full parallel run): slowest test 27.0s (the markdown page's
    // pre-unification body case), p99 9.4s, p95 5.5s, median 0.85s. 60s is
    // ~2.2x that slowest test, leaving headroom for slower CI hardware while
    // still bounding the keystroke-leakage collateral below. Re-measure
    // before changing it; do not tighten toward p99 — the max is the binding
    // number, and it is one test, not an outlier family.
    //
    // What makes the overrun expensive is the collateral: vitest abandons the
    // test but its in-flight `userEvent.keyboard` keeps typing, so the NEXT
    // test in the file receives the leftover keystrokes interleaved with its
    // own — observed as `'nadn dm oarne  atpyppeinndged line'`, which reads
    // like lost input rather than like someone else's typing. One overrun
    // therefore fails two or three tests.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every browser test renders against the app's real stylesheet — see
    // browser-setup.ts for what silently breaks without it.
    setupFiles: ['./src/test-utils/browser-setup.ts'],
    browser: sharedBrowserTestConfig({
      viewport: { width: 1280, height: 900 },
      projectRoot: import.meta.dirname,
    }),
  },
})
