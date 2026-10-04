/**
 * A fixed-duration sleep in a test — `await new Promise((r) => setTimeout(r,
 * N))` with N > 0, however N is spelled (`PAUSE_MS + 50` is as fixed as `50`),
 * or a call to a local `sleep`/`delay` helper that wraps it — is a wait for
 * TIME standing in for a wait for a CONDITION. It is wrong in both directions at once: under a saturated run
 * the condition has not arrived when the sleep ends, so the test fails on a
 * machine it passed on yesterday; on an idle one it waited for nothing, and
 * the suite carries every such sleep as pure cost. The repo already has the
 * condition-shaped tools (`vi.waitFor` 428 call sites, `waitFor` 824,
 * `expect.poll` 14 when this was written), and fake timers with
 * `advanceTimersByTime` for code that itself waits on a timer.
 *
 * What counts, and what is left alone (a fake's injected latency), is
 * `fixed-sleep-count.ts`.
 *
 * A zero-millisecond sleep is not this shape: `setTimeout(r, 0)` yields one
 * macrotask turn and waits for no duration, so it is left alone.
 *
 * This is a RATCHET, not a ban. 117 sleeps in 60 files were already there
 * when it was added (2026-09-05), and rewriting them is per-file work with
 * per-file verification. So the ledger pins today's count per file by
 * equality: a file that gains a sleep fails here naming itself, and a file
 * that loses one fails too — until its entry is lowered, which is the point
 * of pinning by equality rather than by ceiling. Stale headroom in a ceiling
 * is how a later +1 walks through. Guarded from both sides: an entry for a
 * file that no longer holds any sleep, or no longer exists, fails as well.
 *
 * The population is every `*.test.ts(x)` AND the helpers that run inside tests
 * (`test-utils/**`, `*-contract.ts`): a sleep in a shared contract suite is paid
 * by every project that calls it, and a scan that only read test files never
 * saw it. A helper entry counts its own sleeps, not its callers' — a `settle()`
 * called eight times is one line here.
 *
 * Lower an entry whenever you touch a file here; never raise one without
 * saying in the diff why the condition cannot be waited on.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countFixedSleeps } from './fixed-sleep-count.js'
import { REPO_ROOT } from './scan-roots.js'
import { listTestFiles, listTestHelperFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

/** Repo-relative file -> fixed sleeps it held when last pinned. */
const LEDGER: Record<string, number> = {
  // The second waits out the real STATUS_CLEAR_MS timer so it fires after the window is gone.
  'apps/web/src/components/StorageReportCard.test.tsx': 2,
  'apps/web/src/components/document-editor/canvas-verb-bar.browser.test.tsx': 1,
  'apps/web/src/components/markdown-editor/touch-formatting-bar.browser.test.tsx': 1,
  'apps/web/src/components/markdown-editor/verb-bar-measure.browser.test.tsx': 1,
  'apps/web/src/components/markdown-editor/wiki-link-completion.browser.test.tsx': 3,
  'apps/web/src/components/spatial-editor/SpatialEditor.browser.test.tsx': 2,
  'apps/web/src/components/spatial-editor/comment-move.browser.test.tsx': 3,
  // Each waits out STROKE_GROUP_PAUSE_MS on the wall clock so the next stroke opens its own group.
  'apps/web/src/components/spatial-editor/freehand-ink.browser.test.tsx': 3,
  'apps/web/src/components/spatial-editor/image-node.browser.test.tsx': 1,
  'apps/web/src/components/spatial-editor/inspector-reserves-space.browser.test.tsx': 1,
  'apps/web/src/components/spatial-editor/keyboard-avoidance.browser.test.tsx': 3,
  'apps/web/src/components/spatial-editor/link-node.browser.test.tsx': 1,
  'apps/web/src/components/spatial-editor/live-drag-side-tracking.browser.test.tsx': 4,
  'apps/web/src/components/spatial-editor/lost-pointer-capture.browser.test.tsx': 7,
  'apps/web/src/components/spatial-editor/touch-exit-controls.browser.test.tsx': 1,
  'apps/web/src/components/spatial-editor/touch-long-press-menu.browser.test.tsx': 4,
  'apps/web/src/components/workspace-files/body-search.test.tsx': 1,
  'apps/web/src/components/workspace-files/open-wayfinding.test.tsx': 2,
  'apps/web/src/docs-snapshots/onboarding-chooser.docs-snapshot.test.tsx': 1,
  'apps/web/src/hooks/use-document-file-seams.test.tsx': 3,
  'apps/web/src/lib/browser-backend.browser.test.tsx': 1,
  'apps/web/src/lib/browser-backend.restore.browser.test.tsx': 1,
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx': 1,
  'apps/web/src/lib/render-store.browser.test.tsx': 1,
  'apps/web/src/lib/replica-refresh.test.ts': 5,
  'apps/web/src/lib/sse-shared-worker-resend.test.ts': 1,
  'apps/web/src/lib/sse-shared-worker.test.ts': 1,
  'apps/web/src/lib/versions-backend.contract.browser.test.tsx': 1,
  'apps/web/src/pages/BrowserDocumentPage.browser.test.tsx': 1,
  'apps/web/src/pages/BrowserDocumentPage.dialog-outlives-document.test.tsx': 5,
  'apps/web/src/pages/BrowserDocumentPage.rename.browser.test.tsx': 1,
  'apps/web/src/pages/BrowserDocumentPage.test.tsx': 1,
  'apps/web/src/pages/BrowserIndexPage.defaults.browser.test.tsx': 1,
  'apps/web/src/pages/DaemonDocumentPage.surface-outlives-document.test.tsx': 1,
  'apps/web/src/pages/ReplicaReadPage.browser.test.tsx': 1,
  // The poll interval of a deadline loop that watches for a deleted database to come back: a poll
  // between reads, not a wait for something to finish.
  'apps/web/src/test-utils/browser-document.ts': 1,
  // The settle window of `waitForMarkdownSaved` when the caller has nothing to anchor on: it lets
  // the debounce window pass so a write scheduled behind the one just seen would show itself.
  'apps/web/src/test-utils/wait-for-saved.ts': 1,
  // `settle()`, called per case: the contract asserts that nothing further happens after a
  // connect or disconnect, and waiting for nothing to happen is the assertion.
  'packages/daemon-client/src/test-utils/document-backend-contract.ts': 1,
  // `settle()`, called per case: a real window in which a wrong delivery could arrive, so
  // asserting none did is the assertion.
  'packages/daemon-client/src/test-utils/sse-stream-source-contract.ts': 1,
  'packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.script.test.ts': 1,
  // One is the poll interval of a hand-rolled deadline loop (a vi.waitFor in all but name); two
  // are settle windows, since "nothing was opened" can only be shown by letting time pass.
  'packages/mcp-server/src/cli/daemon-run-auto-open-launch.test.ts': 3,
  'packages/mcp-server/src/cli/dispatcher-mcp.test.ts': 1,
  'packages/mcp-server/src/cli/dispatcher.routing.test.ts': 1,
  'packages/mcp-server/src/server/http-server.test.ts': 1,
  // A local `sleep` helper, called per wait: the subject is WHEN a debounced checkpoint lands, on
  // the real clock. Fake timers (`advanceTimersByTimeAsync`) can express every case.
  'packages/mcp-server/src/server/store/auto-version-timing.test.ts': 6,
  'packages/mcp-server/src/server/store/auto-version.test.ts': 1,
  'packages/mcp-server/src/server/routes/document/restore-race.test.ts': 2,
  'packages/mcp-server/src/server/routes/document/versions.test.ts': 2,
  'packages/mcp-server/src/server/routes/document/workspaces.test.ts': 2,
  'packages/mcp-server/src/server/store/backup-blob-mirror.test.ts': 2,
  'packages/mcp-server/src/server/store/backup-in-progress.test.ts': 1,
  'packages/mcp-server/src/server/store/backup-scheduler.test.ts': 2,
  // The sleeps ride with the auto-compact describes, split out of document-store.test.ts.
  'packages/mcp-server/src/server/store/document-store.compact.test.ts': 6,
  'packages/mcp-server/src/server/store/lease.test.ts': 1,
  'packages/mcp-server/src/shared/mkdir-lock.test.ts': 2,
  // The instrument is calibrated against stalls of known duration; the sleeps are the free-loop
  // controls and the quiet stretches around a blocked one.
  'packages/mcp-server/src/shared/test-utils/loop-availability.test.ts': 4,
}

describe('fixed-duration sleeps in test files and the helpers they call', () => {
  it('counts the shape and leaves zero-ms yields alone (self-test)', () => {
    expect(countFixedSleeps('await new Promise((resolve) => setTimeout(resolve, 50))')).toBe(1)
    expect(countFixedSleeps('await new Promise((r) => setTimeout(r, 1200))')).toBe(1)
    expect(countFixedSleeps('await new Promise(r => setTimeout(r, 5))')).toBe(1)
    expect(countFixedSleeps('await new Promise((resolve) => setTimeout(resolve, 0))')).toBe(0)
    expect(countFixedSleeps('await new Promise((r) => setTimeout(r, (50)))')).toBe(1)
    expect(countFixedSleeps('await vi.waitFor(() => expect(x).toBe(1))')).toBe(0)
    expect(countFixedSleeps('setTimeout(tick, 100)')).toBe(0)
  })

  it('counts a duration through a type-only wrapper, which changes the type and not the wait', () => {
    expect(countFixedSleeps('await new Promise((r) => setTimeout(r, 50 as number))')).toBe(1)
    expect(countFixedSleeps('await new Promise((r) => setTimeout(r, 50 satisfies number))')).toBe(1)
    expect(countFixedSleeps('await new Promise((r) => setTimeout(r, PAUSE_MS!))')).toBe(1)
    expect(
      countFixedSleeps('use((ms: number) => new Promise((r) => setTimeout(r, ms as number)))'),
    ).toBe(0)
  })

  it('counts a constant-offset delay, a local sleep helper and a timers/promises call', () => {
    expect(countFixedSleeps('await new Promise((r) => setTimeout(r, PAUSE_MS + 50))')).toBe(1)
    expect(countFixedSleeps('await new Promise((r) => { setTimeout(r, SETTLE_MS) })')).toBe(1)
    const helper = 'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))\n'
    expect(countFixedSleeps(`${helper}await sleep(30)\nawait sleep(300)`)).toBe(2)
    expect(countFixedSleeps(`${helper}await sleep(0)`)).toBe(0)
    const timers = "import { setTimeout as delay } from 'node:timers/promises'\n"
    expect(countFixedSleeps(`${timers}await delay(50)`)).toBe(1)
    expect(countFixedSleeps(`${timers}await Promise.race([p, delay(5000, 'timeout')])`)).toBe(0)
  })

  it('counts a call by what the name resolves to, not by the name', () => {
    const timers = "import { setTimeout as delay } from 'node:timers/promises'\n"
    // A parameter named like the import is whatever was passed in.
    expect(
      countFixedSleeps(`${timers}function invoke(delay: (v: number) => void) { delay(50) }`),
    ).toBe(0)
    const helper = 'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))\n'
    expect(countFixedSleeps(`${helper}it('x', (sleep: Fn) => { sleep(50) })`)).toBe(0)
    expect(countFixedSleeps(`${helper}it('x', () => { sleep(50) })`)).toBe(1)
    expect(
      countFixedSleeps(
        `${helper}async function wait(ms: number) { await sleep(ms) }\nawait wait(50)`,
      ),
    ).toBe(0)
  })

  it('does not take a callback handed to a call for a sleep helper, and does not throw on one', () => {
    expect(
      countFixedSleeps('use((ms: number) => new Promise((r) => setTimeout(r, ms)))\nuse(50)'),
    ).toBe(0)
    expect(
      countFixedSleeps('use(function (ms) { return new Promise((r) => setTimeout(r, ms)) })'),
    ).toBe(0)
  })

  it('resolves a name through a catch clause: bound by a catch variable, or not bound by a bare catch', () => {
    const timers = "import { setTimeout as delay } from 'node:timers/promises'\n"
    expect(countFixedSleeps(`${timers}try { run() } catch (delay) { delay(50) }`)).toBe(0)
    expect(countFixedSleeps(`${timers}try { run() } catch (error) { await delay(50) }`)).toBe(1)
    expect(countFixedSleeps(`${timers}try { run() } catch { await delay(50) }`)).toBe(1)
  })

  it('does not take a body that is one statement of another kind for a sleep helper', () => {
    expect(
      countFixedSleeps(
        'function hold(ms: number) { const pending = new Promise((r) => setTimeout(r, ms)) }\nhold(50)',
      ),
    ).toBe(0)
  })

  it('registers a helper only when the sleep is its whole body', () => {
    // A fake that sleeps and then answers is a latency injection; its literal is configuration.
    const fake =
      "async function fakePut(ms: number) {\n  await new Promise((r) => setTimeout(r, ms))\n  return 'stored'\n}\n"
    expect(countFixedSleeps(`${fake}await fakePut(50)`)).toBe(0)
    const block =
      'async function sleep(ms: number) {\n  await new Promise((r) => setTimeout(r, ms))\n}\n'
    expect(countFixedSleeps(`${block}await sleep(50)`)).toBe(1)
    const returned =
      'function sleep(ms: number) {\n  return new Promise((r) => setTimeout(r, ms))\n}\n'
    expect(countFixedSleeps(`${returned}await sleep(50)`)).toBe(1)
  })

  it('leaves a fake latency read from a parameter, this or a property alone', () => {
    expect(
      countFixedSleeps(
        'const slow = (ms: number) => async () => { await new Promise((r) => setTimeout(r, ms)) }',
      ),
    ).toBe(0)
    expect(
      countFixedSleeps(
        'class F { async go() { await new Promise((r) => setTimeout(r, this.delayMs)) } }',
      ),
    ).toBe(0)
    expect(
      countFixedSleeps(
        'if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs))',
      ),
    ).toBe(0)
  })

  it('matches the ledger exactly: no file gained a sleep, and every entry is still earned', () => {
    const actual: Record<string, number> = {}
    for (const dir of TEST_SCAN_DIRS) {
      const root = join(REPO_ROOT, dir)
      for (const file of [...listTestFiles(root), ...listTestHelperFiles(root)]) {
        // This guard names the pattern it hunts, in its self-test.
        if (file.endsWith('test-fixed-sleep-ledger.test.ts')) continue
        const count = countFixedSleeps(readFileSync(file, 'utf-8'))
        if (count > 0) actual[relative(REPO_ROOT, file).split(sep).join('/')] = count
      }
    }
    const drift: string[] = []
    for (const path of new Set([...Object.keys(LEDGER), ...Object.keys(actual)]).values()) {
      const pinned = LEDGER[path] ?? 0
      const found = actual[path] ?? 0
      if (pinned === found) continue
      drift.push(
        found > pinned
          ? `${path}: ${found} fixed sleeps, ledger says ${pinned} — wait on the condition (vi.waitFor / expect.poll / fake timers) instead of on time`
          : `${path}: ${found} fixed sleeps, ledger says ${pinned} — lower the entry (or remove it at 0)`,
      )
    }
    expect(drift).toEqual([])
  })

  it('holds no entry at zero, which `?? 0` would read as absence', () => {
    // The header promises that an entry for a file holding no sleep fails;
    // the comparison above cannot tell a `0` entry from a missing one, so a
    // zero would sit in the ledger as a claim nothing checks.
    const zeros = Object.entries(LEDGER).filter(([, count]) => count <= 0)
    expect(zeros.map(([path]) => path)).toEqual([])
  })

  it('reaches the population it governs', () => {
    // A walker that stopped matching would report an empty tree as "no
    // sleeps anywhere", which is exactly what a clean tree looks like.
    const all = TEST_SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir)))
    expect(all.length).toBeGreaterThan(1500)
    expect(Object.keys(LEDGER).length).toBeGreaterThan(0)
    // The helper walk matches nothing silently if its predicate drifts, so both shapes it reads
    // are asserted present, and no test file is counted twice.
    const helpers = TEST_SCAN_DIRS.flatMap((dir) => listTestHelperFiles(join(REPO_ROOT, dir))).map(
      (file) => relative(REPO_ROOT, file).split(sep).join('/'),
    )
    expect(helpers.length).toBeGreaterThan(80)
    expect(helpers).toContain('packages/daemon-client/src/test-utils/document-backend-contract.ts')
    expect(helpers).toContain('packages/daemon-client/src/document-backend-contract.ts')
    expect(helpers.filter((file) => /\.test\.tsx?$/.test(file))).toEqual([])
  })
})
