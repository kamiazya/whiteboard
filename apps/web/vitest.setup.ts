import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { cleanup } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'
import { BROWSER_DEFAULT_SEGMENT } from './src/lib/browser-idb.js'
import { setBrowserWorkspaceIdForTests } from './src/lib/browser-workspace-id.js'
import { drainSchedulerMacrotasks } from './src/test-utils/scheduler-drain.js'

// jsdom page/hook tests read `getBrowserWorkspaceId()` at their existing
// production call sites (the id an IndexedDB-backed or in-memory double is
// seeded under) without going through the real boot resolver. A fixed
// per-file id — minted once here rather than per test — is what every such
// call site sees; a test exercising the accessor's own unresolved/failed
// states resets and restores it explicitly (see browser-workspace-id.test.ts
// and boot.test.ts).
//
// The SEGMENT is seeded too, and is what a browser address names. Without it
// the handle falls back to a per-file random ULID, which no fixture can spell
// — and a route naming a workspace this keeper does not have is not a browser
// document route at all, so every `/w/default/document/...` fixture would
// quietly render the index instead. `default` is the same segment the v15
// carrier mints in production, so the fixture and the product agree.
setBrowserWorkspaceIdForTests(generateDocumentId(), BROWSER_DEFAULT_SEGMENT)

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

// jsdom implements `getClientRects` on Element but NOT on Range — measured:
// `'getClientRects' in Range.prototype` is false, and `getBoundingClientRect`
// is missing from it too. CodeMirror measures text by putting a Range around
// it, so any mounted editor that SCROLLS reaches this: `EditorView.scrollIntoView`
// (which the annotation rail's reveal dispatches) runs `DocView.measureTextSize`
// inside a requestAnimationFrame callback and throws there.
//
// A throw in a rAF callback is not a test failure — it is an UNHANDLED error,
// and vitest reports those while still counting every test as passed. Measured
// on the run that caught this: `346 passed | 3648 passed`, `Errors 1 error`,
// job exit 1. The green count is what makes it worth shimming rather than
// leaving to whoever reads the next confusing stack.
//
// Empty geometry, for the ResizeObserver reason above: jsdom lays nothing out,
// so a jsdom test asserting on a character's width would be asserting about
// this shim. CodeMirror reads zero rects as "unknown" and keeps its defaults.
// `typeof` first, like the ResizeObserver guard above and for the same
// reason: this setup file is loaded for `// @vitest-environment node` files
// too, where there is no DOM and a bare `Range` is a ReferenceError that
// takes the whole FILE down rather than one test.
//
// The prototype is widened to `Partial<Range>` before either read, because
// lib.dom declares both methods: `'getClientRects' in Range.prototype` then
// narrows the negative branch to a Range that cannot have it, which is
// `never`, and every assignment inside fails to typecheck. `tsc` catches
// that and `vitest run` does not — the build job is a separate gate from the
// test job, and running only the second is how this reached CI.
if (typeof Range !== 'undefined') {
  const rangeProto: Partial<Range> = Range.prototype
  if (typeof rangeProto.getClientRects !== 'function') {
    rangeProto.getClientRects = (): DOMRectList => {
      const rects: DOMRect[] = []
      return Object.assign(rects, {
        item: (index: number): DOMRect | null => rects[index] ?? null,
      }) as unknown as DOMRectList
    }
    rangeProto.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 0, 0)
  }
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
  // localStorage outlives a test, and a worker runs many test FILES, so a
  // preference one test flips is a preference every later test inherits.
  // Measured: one test switching the document browser to a single column
  // made `folder-contents` — which only the two-column layout renders —
  // vanish for the thirteen tests after it, each failing on a missing
  // element with nothing naming the test that moved it.
  try {
    globalThis.localStorage?.clear()
  } catch {
    // Unavailable storage (a private window, blocked site data) throws on
    // access rather than answering empty. Nothing to clear either way.
  }
  recordSharedAfterEachRan()
  await drainSchedulerMacrotasks()
}

afterEach(async () => {
  await runSharedTestTeardown(expect.getState().currentTestName)
})
