import { playwright } from '@vitest/browser-playwright'
// Import the source file directly rather than `@kamiazya/whiteboard-mcp/test-utils`:
// that package export resolves to the built `dist/` output, which is gitignored
// and not produced by a plain `pnpm install` on a clean checkout (CI's browser
// job never builds packages/mcp-server before running Vitest).
import { resolveBrowserLaunchOptions } from './packages/mcp-server/src/server/browser-test-config.js'

/**
 * The one definition of how this repo runs a Vitest browser project —
 * headless chromium via Playwright, launch options honouring
 * WHITEBOARD_CHROME_PATH, failure traces retained under the package's
 * `tmp/vitest-traces` (see AGENTS.md's browser-mode section). Three configs
 * spread this; before it existed each carried its own copy, and a knob
 * tuned in one (a trace setting, a connect timeout) silently missed the
 * other two.
 *
 * `viewport` is the one knob that legitimately differs per project:
 * component-scale projects render at 800x600, apps/web's page tests at
 * 1280x900.
 */
export function sharedBrowserTestConfig(
  options: { viewport?: { width: number; height: number } } = {},
) {
  return {
    enabled: true,
    headless: true,
    connectTimeout: 120_000,
    screenshotFailures: false,
    trace: {
      mode: 'retain-on-failure' as const,
      tracesDir: './tmp/vitest-traces',
      screenshots: true,
      snapshots: true,
    },
    viewport: options.viewport ?? { width: 800, height: 600 },
    provider: playwright({
      launchOptions: resolveBrowserLaunchOptions(process.env),
    }),
    instances: [{ browser: 'chromium' as const }],
  }
}
