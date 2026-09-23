/**
 * What the daemon keeper's page ANSWERS with when there is no document to
 * draw: the three terminal screens, the two empty states, and the labels an
 * unnamed-or-unloaded document still needs.
 *
 * A sibling module rather than more of `DaemonDocumentPage.tsx`, because
 * none of it is React state — each is a pure function of what the controller
 * already holds — and the page is the thing that has to be read in one
 * sitting.
 */

import {
  documentsApiUrl,
  saveVersionResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { ReactNode } from 'react'
import { DocumentPageSkeleton } from '../components/DocumentPageSkeleton.js'
import { LoadDegradedView } from '../components/document-editor/LoadDegradedView.js'
import { Button } from '../components/ui/button.js'
import { dispatchIdentityEvent } from '../hooks/useDocumentSync.js'
import { linkifyDocumentMentions } from '../lib/daemon-api-client.js'
import type { DaemonPageState } from './daemon-page-state.js'
import { DaemonTerminalScreen, membershipRefusedScreen } from './daemon-terminal-screens.js'
import type { DocumentKeeperAnswer } from './document-keeper.js'
import type { DocumentPageModel } from './document-page-model.js'
import type { DaemonConnections } from './use-daemon-connections.js'

/**
 * The three states where the page answers with a SCREEN instead of a
 * document, or `null` when there is a page to draw — including the two EMPTY
 * states, which are drawn inside the ordinary page chrome rather than
 * instead of it (see `daemonEmptyState`).
 */
export function daemonTerminalAnswer(
  pageState: DaemonPageState,
  daemonBaseUrl: string,
  retry: () => void,
): DocumentKeeperAnswer | null {
  if (pageState.kind === 'loading') {
    return {
      kind: 'terminal',
      node: (
        <DaemonTerminalScreen status="">
          <DocumentPageSkeleton label="Connecting to daemon" />
        </DaemonTerminalScreen>
      ),
    }
  }
  if (pageState.kind === 'membership-refused') {
    return { kind: 'terminal', node: membershipRefusedScreen(pageState, daemonBaseUrl, retry) }
  }
  if (pageState.kind === 'load-degraded') {
    return { kind: 'terminal', node: <LoadDegradedView message={pageState.message} /> }
  }
  return null
}

/**
 * One empty screen: a Back affordance, what is missing, whatever the last
 * create attempt said, and the control that fixes it.
 *
 * The Back button is here rather than in `WorkspaceTopBar` — its usual home
 * — because the bar only mounts once a canvas is selected, so a workspace
 * resolving to zero documents (an empty workspace, or a gallery row whose
 * canvas another client deleted) would otherwise be a dead end.
 *
 * The control keeps a TEXT label rather than becoming an icon-only "+": an
 * empty state is a reading surface, not a dense toolbar strip (ADR-0006
 * point 4).
 */
function DaemonEmptyScreen({
  onNavigateBack,
  children,
  createError,
  creating,
  actionLabel,
  onAction,
}: {
  onNavigateBack: (() => void) | undefined
  children: ReactNode
  createError: string | null
  creating: boolean
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
      {onNavigateBack && (
        <button
          type="button"
          onClick={onNavigateBack}
          className="self-start rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <span aria-hidden="true">← </span>Back to documents
        </button>
      )}
      <p className="text-sm text-muted-foreground">{children}</p>
      {createError && (
        <div role="alert" aria-live="assertive" className="text-xs text-destructive">
          {createError}
        </div>
      )}
      <Button type="button" variant="outline" size="sm" disabled={creating} onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  )
}

/**
 * The two states that have page chrome but nothing to edit, or `undefined`
 * when there is something. They differ in what is missing and in what the
 * control creates; everything else is `DaemonEmptyScreen`.
 */
export function daemonEmptyState({
  pageState,
  onNavigateBack,
  createError,
  creating,
  setCreating,
  createDocument,
  handleCreateDocument,
}: {
  pageState: DaemonPageState
  onNavigateBack: (() => void) | undefined
  createError: string | null
  creating: boolean
  setCreating: (next: boolean) => void
  createDocument: (path: string) => Promise<unknown>
  handleCreateDocument: () => Promise<unknown>
}): ReactNode | undefined {
  const shared = { onNavigateBack, createError, creating }
  if (pageState.kind === 'document-missing') {
    const { path } = pageState
    return (
      <DaemonEmptyScreen
        {...shared}
        actionLabel="Create a canvas at this path"
        onAction={() => {
          setCreating(true)
          void createDocument(path).finally(() => setCreating(false))
        }}
      >
        Nothing is at <span className="font-medium text-foreground">“{path}”</span> in this
        workspace. It may have been deleted or renamed.
      </DaemonEmptyScreen>
    )
  }
  if (pageState.kind === 'workspace-empty') {
    return (
      <DaemonEmptyScreen
        {...shared}
        actionLabel="Create a canvas"
        onAction={() => void handleCreateDocument()}
      >
        This workspace has no documents yet.
      </DaemonEmptyScreen>
    )
  }
  return undefined
}

/**
 * What an unloaded document is still called. Every one of these is read
 * before a canvas has arrived, and each default differs because each surface
 * differs: a React key needs any stable string, a scope key and a command
 * registry key need an identity (so they answer `null`), and the version
 * seam needs strings its own `enabled: false` makes unreachable.
 */
export function daemonDocumentLabels(canvas: { workspaceId: string; path: string } | null): {
  documentKey: string
  scopeKey: string | null
  overlayTitle: string
  exportFilenameBase: string
  registryKey: string | null
  workspaceId: string
  path: string
  commandCanvas: DocumentPageModel['commands']['canvas']
} {
  if (canvas === null) {
    return {
      documentKey: 'no-canvas',
      scopeKey: null,
      overlayTitle: 'Untitled',
      exportFilenameBase: 'canvas',
      registryKey: null,
      workspaceId: '',
      path: '',
      commandCanvas: null,
    }
  }
  return {
    documentKey: `${canvas.workspaceId}/${canvas.path}`,
    scopeKey: `${canvas.workspaceId}:${canvas.path}`,
    overlayTitle: canvas.path,
    exportFilenameBase: canvas.path,
    // Identity key = workspaceId+path, matching this page's own canvas.
    registryKey: `${canvas.workspaceId}/${canvas.path}`,
    workspaceId: canvas.workspaceId,
    path: canvas.path,
    // The daemon's command surface addresses a document by path (the row it
    // answers with carries path/updatedAt) — the path doubles as `name`
    // until that changes.
    commandCanvas: { workspaceId: canvas.workspaceId, documentId: canvas.path, name: canvas.path },
  }
}

/**
 * The History column's seam. A daemon save is one POST, and the two
 * announcements after it are not redundant: the server's manual
 * `POST /versions` route does NOT broadcast `version_created` over the
 * websocket — that only fires for auto-saves and other peers' saves — so
 * this save dispatches the same identity-scoped event `useDocumentSync`
 * fires on a broadcast, or nothing listening for the save (the version
 * list, the tab) learns it happened.
 *
 * `enabled: false` is what makes the `canvas === null` throw unreachable
 * rather than a case a caller can drive.
 */
export function daemonVersionsSlot({
  canvas,
  labels,
  daemonFetch,
  daemonBaseUrl,
  log,
  onVersionCreated,
}: {
  canvas: { workspaceId: string; path: string } | null
  labels: ReturnType<typeof daemonDocumentLabels>
  daemonFetch: typeof globalThis.fetch
  daemonBaseUrl: string
  log: { error: (message: string, data?: unknown) => void }
  onVersionCreated: () => void
}): DocumentPageModel['versions'] {
  return {
    enabled: canvas !== null,
    workspaceId: labels.workspaceId,
    path: labels.path,
    save: async (label) => {
      if (canvas === null) throw new Error('saveVersion: no canvas')
      const res = await daemonFetch(
        `${daemonBaseUrl}${documentsApiUrl(canvas.workspaceId, canvas.path, 'versions')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label }),
        },
      )
      if (!res.ok) throw new Error(`save failed: ${res.status}`)
      const parsed = saveVersionResponseSchema.safeParse(await res.json().catch(() => null))
      if (!parsed.success) {
        log.error('POST /versions response did not match saveVersionResponseSchema:', parsed.error)
        throw new Error('save response did not match schema')
      }
      return {
        workspaceId: canvas.workspaceId,
        path: canvas.path,
        versionId: parsed.data.version.id,
      }
    },
    announceRefresh: onVersionCreated,
    announceOnce: () => dispatchIdentityEvent('whiteboard:wb_version_saved', canvas ?? undefined),
  }
}

/**
 * The merged row's daemon half, or `null` before a canvas exists — the row
 * addresses a document, so there is nothing for it to name until one does.
 */
export function daemonTopBarSlot(
  canvas: { workspaceId: string; path: string } | null,
  branchRefreshSignal: number,
  setBranchRefreshSignal: (next: (n: number) => number) => void,
  onNavigateBack: (() => void) | undefined,
): DocumentPageModel['topBar'] {
  if (canvas === null) return null
  return {
    workspaceId: canvas.workspaceId,
    path: canvas.path,
    branchRefreshSignal,
    onBranchesChanged: () => setBranchRefreshSignal((n) => n + 1),
    ...(onNavigateBack === undefined ? {} : { onNavigateBack }),
  }
}

/**
 * The Connections panel, spread-or-nothing: without a canvas there is no
 * document to ask what points at it, and the panel's opener must not appear
 * over an empty workspace.
 *
 * `null` backlinks and absent mentions both mean "not loaded yet" rather
 * than "none", which is why they are threaded rather than defaulted — a
 * panel that said "no backlinks" before the read returned would be wrong in
 * the one way a reader cannot tell from right.
 *
 * A failed linkify is swallowed on purpose: the panel keeps showing the
 * mention, and the next open retries.
 */
export function daemonConnectionsSlot({
  canvas,
  connections,
  workspaceId,
  currentDocumentId,
  switchDocument,
  daemonFetch,
  daemonBaseUrl,
  refreshConnections,
}: {
  canvas: { workspaceId: string; path: string } | null
  connections: DaemonConnections | null
  workspaceId: string | null
  currentDocumentId: string | undefined
  switchDocument: (path: string) => void
  daemonFetch: typeof globalThis.fetch
  daemonBaseUrl: string
  refreshConnections: () => void
}): Pick<DocumentPageModel, 'connections'> | Record<string, never> {
  if (canvas === null) return {}
  return {
    connections: {
      backlinks: connections === null ? null : connections.backlinks,
      ...(connections === null ? {} : { mentions: connections.unlinkedMentions }),
      onOpen: (entry) => switchDocument(entry.path),
      onLinkify: (mention) => {
        if (workspaceId === null || currentDocumentId === undefined) return
        void linkifyDocumentMentions(
          daemonFetch,
          daemonBaseUrl,
          workspaceId,
          mention.documentId,
          currentDocumentId,
        )
          .then(() => refreshConnections())
          .catch(() => {})
      },
    },
  }
}
