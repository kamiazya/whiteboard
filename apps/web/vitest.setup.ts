import { cleanup } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'
import { drainSchedulerMacrotasks } from './src/test-utils/scheduler-drain.js'

// jsdom ships no ResizeObserver; Radix popper-positioned surfaces
// (DropdownMenu/Popover content) observe their anchor on mount and throw
// without one. A no-op is enough — layout geometry is a browser-mode
// concern, jsdom tests only assert structure and wiring.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
}

// Shared jsdom-project teardown hook. See src/test-utils/scheduler-drain.ts
// for why this exists: React's scheduler can outlive a test's own cleanup,
// so every test gets a bounded drain window before the next test (or the
// file's environment teardown) runs.
//
// Exposed under a globalThis key (not a module-level array) so
// src/test-utils/vitest-setup.infra.test.tsx — a different module, loaded by
// a different Vitest transform pass — observes the same log this file
// writes to, and to prove the ordering claim below empirically rather than
// assume it holds across Vitest versions.
const HOOK_ORDER_KEY = '__whiteboardWebVitestSetupHookOrder__'

function hookOrderLog(): string[] {
  const g = globalThis as Record<string, unknown>
  if (!Array.isArray(g[HOOK_ORDER_KEY])) g[HOOK_ORDER_KEY] = []
  return g[HOOK_ORDER_KEY] as string[]
}

export function recordSharedAfterEachRan(): void {
  hookOrderLog().push('shared-setup-afterEach')
}

export function readHookOrderLog(): string[] {
  return hookOrderLog()
}

export function clearHookOrderLog(): void {
  hookOrderLog().length = 0
}

/**
 * The body of the shared afterEach, factored out so the infra test can
 * exercise it directly (assert throw + restore behavior) without relying on
 * an intentionally-failing test inside the real suite run.
 *
 * A test that leaves fake timers active is a leak into the next test, not a
 * benign default — restoring silently would hide that, so this reports the
 * offending test by name and fails loudly instead of papering over it.
 */
export async function runSharedTestTeardown(currentTestName: string | undefined): Promise<void> {
  // vitest globals:false means @testing-library/react cannot self-register
  // its usual auto-cleanup afterEach, so a test file that omits its own
  // cleanup() leaves a mounted tree (and any timers its effects scheduled)
  // running past the test's own teardown. Unmount first, before the
  // fake-timer guard below, so a file that also leaks fake timers still
  // gets its trees torn down.
  cleanup()
  if (vi.isFakeTimers()) {
    vi.useRealTimers()
    throw new Error(
      `[vitest.setup] "${currentTestName ?? '(unknown test)'}" left fake timers active after ` +
        'its own cleanup ran. Call vi.useRealTimers() before the test finishes — restoring ' +
        'silently here would hide the leak from whichever test runs next.',
    )
  }
  recordSharedAfterEachRan()
  await drainSchedulerMacrotasks()
}

afterEach(async () => {
  await runSharedTestTeardown(expect.getState().currentTestName)
})
