/**
 * A fixed-duration sleep in a test — `await new Promise((r) => setTimeout(r,
 * N))` with N > 0 — is a wait for TIME standing in for a wait for a
 * CONDITION. It is wrong in both directions at once: under a saturated run
 * the condition has not arrived when the sleep ends, so the test fails on a
 * machine it passed on yesterday; on an idle one it waited for nothing, and
 * the suite carries every such sleep as pure cost. The repo already has the
 * condition-shaped tools (`vi.waitFor` 428 call sites, `waitFor` 824,
 * `expect.poll` 14 when this was written), and fake timers with
 * `advanceTimersByTime` for code that itself waits on a timer.
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
 * Lower an entry whenever you touch a file here; never raise one without
 * saying in the diff why the condition cannot be waited on.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listTestFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** `new Promise((resolve) => setTimeout(resolve, 50))`, any callback name, N > 0. */
const FIXED_SLEEP = /new Promise\(\s*\(?\w*\)?\s*=>\s*setTimeout\(\w+,\s*[1-9][0-9]*\s*\)/g

export function countFixedSleeps(source: string): number {
  return [...source.matchAll(FIXED_SLEEP)].length
}

/** Repo-relative file -> fixed sleeps it held when last pinned. */
const LEDGER: Record<string, number> = {
  'apps/web/src/components/HeaderBranchChip.browser.test.tsx': 1,
  'apps/web/src/components/PairedOriginsCard.test.tsx': 2,
  'apps/web/src/components/StorageReportCard.test.tsx': 1,
  'apps/web/src/components/document-editor/canvas-verb-bar.browser.test.tsx': 1,
  'apps/web/src/components/markdown-editor/touch-formatting-bar.browser.test.tsx': 1,
  'apps/web/src/components/markdown-editor/verb-bar-measure.browser.test.tsx': 1,
  'apps/web/src/components/markdown-editor/wiki-link-completion.browser.test.tsx': 4,
  'apps/web/src/components/spatial-editor/SpatialEditor.browser.test.tsx': 2,
  'apps/web/src/components/spatial-editor/comment-move.browser.test.tsx': 3,
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
  'apps/web/src/hooks/use-markdown-embed-content.test.tsx': 2,
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
  'apps/web/src/pages/BrowserIndexPage.back-during-load.browser.test.tsx': 1,
  'apps/web/src/pages/BrowserIndexPage.defaults.browser.test.tsx': 1,
  'apps/web/src/pages/DaemonDocumentPage.surface-outlives-document.test.tsx': 1,
  'apps/web/src/pages/PairConsentPage.test.tsx': 1,
  'apps/web/src/pages/ReplicaReadPage.browser.test.tsx': 1,
  'packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.script.test.ts': 1,
  'packages/mcp-server/src/cli/dispatcher-mcp.test.ts': 1,
  'packages/mcp-server/src/cli/dispatcher.routing.test.ts': 1,
  'packages/mcp-server/src/server/app.merge-race.test.ts': 1,
  'packages/mcp-server/src/server/http-server.test.ts': 2,
  'packages/mcp-server/src/server/routes/document/auto-version.test.ts': 1,
  'packages/mcp-server/src/server/routes/document/restore-race.test.ts': 2,
  'packages/mcp-server/src/server/routes/document/versions.test.ts': 2,
  'packages/mcp-server/src/server/routes/document/workspaces.test.ts': 2,
  'packages/mcp-server/src/server/routes/ws-rename-race.test.ts': 1,
  'packages/mcp-server/src/server/routes/ws.test.ts': 8,
  'packages/mcp-server/src/server/security/pairing-session.test.ts': 2,
  'packages/mcp-server/src/server/store/backup-blob-mirror.test.ts': 2,
  'packages/mcp-server/src/server/store/backup-in-progress.test.ts': 1,
  'packages/mcp-server/src/server/store/backup-scheduler.test.ts': 2,
  'packages/mcp-server/src/server/store/branches-store.test.ts': 4,
  // The sleeps ride with the auto-compact describes, split out of document-store.test.ts.
  'packages/mcp-server/src/server/store/document-store.compact.test.ts': 6,
  'packages/mcp-server/src/server/store/document-write-lock.test.ts': 1,
  'packages/mcp-server/src/server/store/lease.test.ts': 1,
  'packages/mcp-server/src/server/store/workspace-lock.test.ts': 2,
  'packages/mcp-server/src/shared/mkdir-lock.test.ts': 2,
}

describe('fixed-duration sleeps in test files', () => {
  it('counts the shape and leaves zero-ms yields alone (self-test)', () => {
    expect(countFixedSleeps('await new Promise((resolve) => setTimeout(resolve, 50))')).toBe(1)
    expect(countFixedSleeps('await new Promise((r) => setTimeout(r, 1200))')).toBe(1)
    expect(countFixedSleeps('await new Promise(r => setTimeout(r, 5))')).toBe(1)
    expect(countFixedSleeps('await new Promise((resolve) => setTimeout(resolve, 0))')).toBe(0)
    expect(countFixedSleeps('await vi.waitFor(() => expect(x).toBe(1))')).toBe(0)
    expect(countFixedSleeps('setTimeout(tick, 100)')).toBe(0)
  })

  it('matches the ledger exactly: no file gained a sleep, and every entry is still earned', () => {
    const actual: Record<string, number> = {}
    for (const dir of TEST_SCAN_DIRS) {
      for (const file of listTestFiles(join(REPO_ROOT, dir))) {
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

  it('reaches the population it governs', () => {
    // A walker that stopped matching would report an empty tree as "no
    // sleeps anywhere", which is exactly what a clean tree looks like.
    const all = TEST_SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir)))
    expect(all.length).toBeGreaterThan(900)
    expect(Object.keys(LEDGER).length).toBeGreaterThan(0)
  })
})
