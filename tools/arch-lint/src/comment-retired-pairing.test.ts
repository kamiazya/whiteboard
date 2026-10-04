import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// Local pairing is retired (ADR-0050 decisions 3 and 8): a hosted page no
// longer reaches the daemon over loopback, so there is no pairing page, link,
// consent step, token or grant to describe. A comment that still talks about
// one reads as live behaviour to the next person, who then looks for the code
// it describes. The daemon's identity keypair and its did:key outlived the
// flow, and their comments say what they are for now.
//
// Narrow on purpose. The noun "pair" is ordinary vocabulary — a key pair, a
// (workspace, path) pair, a pair of boxes — and a scan for it read about 280
// comment lines of which four were about the retired flow. What names the flow
// is the verb forms (`pairing`, `paired`), the daemon's `/pair` route and "pair
// again". Those are also ordinary English elsewhere ("paired t test", "a
// double-press pairing"), so each file that legitimately carries one is
// ledgered with the count and the reason.

const RETIRED_PAIRING = /\bpair(?:ing|ed)\b|(?<![\w.])\/pair\b|\bpair again\b/i

type Why =
  | 'ordinary English'
  | 'says the flow is gone, or what a migration drops'
  | 'describes the flow as live; to rewrite'

/**
 * The comment lines per file that match, each file with what they are (the
 * strongest reason any of its lines has). The ledger only shrinks: a count
 * that no longer matches fails in both directions, so a rewritten comment
 * takes its entry down and a new one never joins.
 */
const LEDGER: Readonly<Record<string, { readonly count: number; readonly why: Why }>> = {
  'apps/web/src/App.test.tsx': {
    count: 6,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/components/AppShell.tsx': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/components/connection/ConnectionStatus.test.tsx': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/components/connection/ExtensionConnectOption.test.tsx': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/components/markdown-editor/editor-verbs.property.test.ts': {
    count: 1,
    why: 'ordinary English',
  },
  'apps/web/src/components/spatial-editor/facet-widgets/FacetFormPanel.tsx': {
    count: 1,
    why: 'ordinary English',
  },
  'apps/web/src/components/spatial-editor/link-node.browser.test.tsx': {
    count: 1,
    why: 'ordinary English',
  },
  'apps/web/src/components/spatial-editor/use-editor-pointer.ts': {
    count: 1,
    why: 'ordinary English',
  },
  'apps/web/src/components/tags/TagChipsEditor.tsx': { count: 2, why: 'ordinary English' },
  'apps/web/src/hooks/use-daemon-reconnect.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/hooks/use-daemon-reconnect.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/hooks/use-workspace-address-sync.ts': {
    count: 3,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/hooks/useDocumentSync.ts': { count: 1, why: 'ordinary English' },
  'apps/web/src/hooks/useFavicon.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/lib/app-routes.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/lib/browser-idb-upgrades.ts': { count: 1, why: 'ordinary English' },
  'apps/web/src/lib/browser-idb.ts': { count: 2, why: 'ordinary English' },
  'apps/web/src/lib/commands/create-commands.test.ts': { count: 1, why: 'ordinary English' },
  'apps/web/src/lib/document-outline.ts': { count: 2, why: 'ordinary English' },
  'apps/web/src/lib/document-sync-session.test.ts': { count: 1, why: 'ordinary English' },
  'apps/web/src/lib/document-sync-session.ts': { count: 1, why: 'ordinary English' },
  'apps/web/src/lib/extension-connection.test.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/lib/extension-connection.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/lib/promote-workspace.keeper-agnostic.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/lib/render-preview.ts': { count: 1, why: 'ordinary English' },
  'apps/web/src/lib/replica-unlock.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/lib/replica-wrapped-key-store.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/lib/sse-shared-stream-source.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/lib/sse-shared-worker-protocol.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/lib/sse-shared-worker.test.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/lib/sse-shared-worker.ts': {
    count: 2,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/lib/user-settings-store.property.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/lib/user-settings-store.test.ts': {
    count: 2,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/lib/user-settings-store.ts': {
    count: 2,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/pages/DaemonDocumentPage.server-mode.test.tsx': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pages/DaemonDocumentPage.test.tsx': {
    count: 2,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pages/DaemonDocumentPage.tsx': {
    count: 2,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pages/DaemonIndexPage.test.tsx': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/pages/ServerModeWorkspace.tsx': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pages/SettingsPage.test.tsx': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pages/daemon-index-page-props.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pages/use-daemon-document-backend.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pages/use-daemon-document-controller.test.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pages/use-daemon-document-controller.ts': {
    count: 3,
    why: 'describes the flow as live; to rewrite',
  },
  'apps/web/src/pwa/register-sw.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'apps/web/src/pwa/register-sw.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'packages/canvas-render/src/layout/edges/edge-anchors.ts': { count: 1, why: 'ordinary English' },
  'packages/canvas-render/src/layout/edges/grid-route.ts': { count: 1, why: 'ordinary English' },
  'packages/canvas-render/src/layout/edges/spatial-edges.ts': { count: 2, why: 'ordinary English' },
  'packages/canvas-render/src/layout/spatial-canvas.bench.ts': {
    count: 1,
    why: 'ordinary English',
  },
  'packages/canvas-render/src/svg/vnode.ts': { count: 1, why: 'ordinary English' },
  'packages/daemon-client/src/sse-stream-hub.test.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/daemon-client/src/sse-stream-hub.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/daemon-client/src/sync-frames.ts': { count: 1, why: 'ordinary English' },
  'packages/loro-adapter/src/workspace-tree.convergence.property.test.ts': {
    count: 1,
    why: 'ordinary English',
  },
  'packages/mcp-server/src/server/backup-restore.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'packages/mcp-server/src/server/backup-restore.ts': { count: 1, why: 'ordinary English' },
  'packages/mcp-server/src/server/backup-secret-surface.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'packages/mcp-server/src/server/log.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'packages/mcp-server/src/server/mcp/tool-surface-quality.test.ts': {
    count: 1,
    why: 'says the flow is gone, or what a migration drops',
  },
  'packages/mcp-server/src/server/routes/document/crud-adapter.test.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/mcp-server/src/server/routes/document/workspaces.test.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/mcp-server/src/server/routes/error-body-shape.test.ts': {
    count: 2,
    why: 'says the flow is gone, or what a migration drops',
  },
  'packages/mcp-server/src/server/routes/replica-key-rotate.test.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/mcp-server/src/server/routes/runtime.test.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/mcp-server/src/server/security/daemon-identity.test.ts': {
    count: 2,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/mcp-server/src/server/store/document-store.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/mcp-server/src/server/store/version-store.ts': { count: 1, why: 'ordinary English' },
  'packages/mcp-server/src/shared/diagnostics/support-bundle.ts': {
    count: 1,
    why: 'describes the flow as live; to rewrite',
  },
  'packages/ports/src/document-store.ts': { count: 1, why: 'ordinary English' },
  'packages/search/src/snippet.ts': { count: 1, why: 'ordinary English' },
  'packages/server-core/src/search/eval.test.ts': { count: 1, why: 'ordinary English' },
  'packages/server-core/src/search/eval.ts': { count: 3, why: 'ordinary English' },
  'packages/server-core/src/tools/body-edit.ts': { count: 1, why: 'ordinary English' },
}

const isComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line)

const hasRetiredPairing = (line: string): boolean => isComment(line) && RETIRED_PAIRING.test(line)

const isScanned = (path: string): boolean =>
  /^(?:packages\/[^/]+|apps\/web)\/src\/.+\.(?:tsx?|mjs)$/.test(path) &&
  !path.includes('/migrations/') &&
  path !== 'tools/arch-lint/src/comment-retired-pairing.test.ts'

describe('a source comment does not describe the retired pairing flow', () => {
  it('matches the flow in a comment and leaves the ordinary noun and code alone', () => {
    expect(hasRetiredPairing('  // a paired browser fails closed on the key mismatch')).toBe(true)
    expect(hasRetiredPairing(' * pinned at /pair consent time')).toBe(true)
    expect(hasRetiredPairing('   * so the person can pair again; a new connection')).toBe(true)
    expect(hasRetiredPairing(' * the pairing token is rotated under it')).toBe(true)
    expect(hasRetiredPairing('  // A key pair and a (workspace, path) pair')).toBe(false)
    expect(hasRetiredPairing('  // each pair of boxes, and pairs of edges')).toBe(false)
    expect(hasRetiredPairing('  // see ./pair.ts')).toBe(false)
    expect(hasRetiredPairing("const label = 'pairing'")).toBe(false)
  })

  const hits = new Map<string, number>()
  const files = trackedFiles(REPO_ROOT).filter(isScanned)
  for (const file of files) {
    const count = readFileSync(join(REPO_ROOT, file), 'utf8')
      .split('\n')
      .filter(hasRetiredPairing).length
    if (count > 0) hits.set(file, count)
  }

  it('reads the comment sources worth reading', () => {
    // A scan over an empty list reports clean, which reads as a rule being kept.
    expect(files.length).toBeGreaterThan(1_500)
    expect(files).toContain('apps/web/src/lib/daemon-auth-fetch.ts')
    expect(hits.size).toBeGreaterThan(5)
  })

  it('finds the flow in no comment outside the ledger', () => {
    const unledgered = [...hits]
      .filter(([file]) => !(file in LEDGER))
      .map(([file, count]) => `${file}: ${count}`)
    expect(unledgered).toEqual([])
  })

  it('holds a ledger entry only for the count its file still carries', () => {
    const stale = Object.entries(LEDGER)
      .filter(([file, { count }]) => hits.get(file) !== count)
      .map(([file, { count }]) => `${file}: ledger ${count}, found ${hits.get(file) ?? 0}`)
    expect(stale).toEqual([])
  })
})
