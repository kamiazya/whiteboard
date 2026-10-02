/**
 * Settings > Connections' "This workspace" section: move the workspace this
 * browser keeps to a daemon, whole — documents, their edit history, and the
 * images they reference — with identity preserved (links keep resolving).
 *
 * Discoverable-but-disabled until a daemon is connected, per DESIGN.md's
 * "Status reports; Settings manages": the chip popover only nudges here.
 *
 * The result is a standing report, never a toast: the outcome persists in
 * user settings (migration.promotion) and renders in this section, so it
 * survives navigating away and a full reload. After a success the section
 * offers a narrated reload — mid-session backend swap is out (ADR-0004:
 * backend mode is decided once at page load), so continuing from the daemon
 * is a reload the user takes knowingly, never a navigation done to them.
 *
 * promote-workspace.js (and the loro machinery behind it) loads on demand:
 * this section renders on a settings page that must not pay for the CRDT
 * bundle until the user actually reaches for promotion.
 */

import type { ReplicaTier } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { getAppLogger } from '../../lib/app-logger.js'
import { createDaemonFetch, listWorkspaces } from '../../lib/daemon-api-client.js'
import type { ConnectedDaemon } from '../../lib/daemon-auth-fetch.js'
import type { PromoteWorkspaceResult } from '../../lib/promote-workspace.js'
import { REPLICA_TIER_COPY } from '../../lib/replica-tier-copy.js'
import type { PromotionResultRecord, UserSettings } from '../../lib/user-settings-store.js'
import { type WorkspaceIdentity, workspaceLabel } from '../../lib/workspace-handle.js'

const log = getAppLogger('promote-workspace-section')

function daemonFetch(daemon: ConnectedDaemon, baseFetch?: typeof globalThis.fetch) {
  return createDaemonFetch(
    daemon.baseUrl,
    daemon.token ?? undefined,
    baseFetch ?? globalThis.fetch.bind(globalThis),
  )
}

export interface PromoteWorkspaceSectionProps {
  daemon?: ConnectedDaemon
  settingsStore: {
    load: () => UserSettings
    update: (fn: (current: UserSettings) => UserSettings) => void
  }
  /**
   * The reload the success surface narrates. Injectable because jsdom and
   * browser-mode tests cannot survive a real navigation mid-test.
   */
  reload?: () => void
  /** Test seam for the daemon HTTP surface; production uses window.fetch. */
  baseFetch?: typeof globalThis.fetch
  /**
   * The daemon-kept workspace in view. The line about what this device
   * keeps of it is hidden without one — a cold load with a daemon merely
   * detected names no workspace yet.
   */
  workspaceId?: string
}

type PromoteFlow =
  | { step: 'idle' }
  | {
      step: 'confirm'
      documentCount: number
      targets: WorkspaceIdentity[]
      targetId: string
    }
  | { step: 'running'; phase: 'record' | 'blobs' }
  | { step: 'unavailable'; reason: string }

/** What a move could not carry, counted. Each is retryable and says so. */
function carryNotes(result: PromotionResultRecord & { ok: true }): string[] {
  const notes: string[] = []
  if (result.shadowedPaths.length > 0) {
    notes.push(
      `${result.shadowedPaths.length} path${result.shadowedPaths.length === 1 ? '' : 's'} already existed there — both versions are kept, the earlier one marked shadowed: ${result.shadowedPaths.join(', ')}`,
    )
  }
  if (result.blobsMissing.length > 0) {
    notes.push(
      `${result.blobsMissing.length} referenced image${result.blobsMissing.length === 1 ? ' was' : 's were'} already missing from this browser and could not be moved`,
    )
  }
  if (result.blobsFailed.length > 0) {
    const count = `${result.blobsFailed.length} image${result.blobsFailed.length === 1 ? '' : 's'}`
    const reasons = result.blobFailureReasons ?? []
    notes.push(
      reasons.length === 0
        ? `${count} could not be moved — moving again retries them safely`
        : `${count} could not be moved: ${reasons.join(' ')}`,
    )
  }
  return notes
}

/**
 * The demote pull (ADR-0023 decision 2): cache the daemon's merged record
 * back into this browser's planes, and delete the source record only once
 * that cache is proven to carry everything.
 *
 * Best-effort throughout — the move itself already landed, so a failed pull
 * costs only the cache line on the report, never the promotion.
 *
 * The demote gate is deliberately strict. `missing` gates alongside `failed`
 * because the file store folds read errors into "missing", so those
 * references may be retryable and the source record is the retry vehicle.
 * And the read-back has its OWN try/catch rather than the caller's:
 * `replicaCarriesAll` reads through the sealed store and can throw
 * `ReplicaKeyWithheldError` if the session key lapses between the cache
 * write and this read — letting that escape would report an
 * already-successful move as a failed one. The decision is simply deferred
 * (the browser copy stays, as in any other unverified-replica case) and a
 * later visit re-asks.
 */
async function cacheAndMaybeDemote({
  fetchImpl,
  daemonBaseUrl,
  workspaceId,
  target,
  outcome,
  settingsStore,
}: {
  fetchImpl: typeof globalThis.fetch
  daemonBaseUrl: string
  workspaceId: string
  target: WorkspaceIdentity | undefined
  outcome: Extract<PromoteWorkspaceResult, { kind: 'ok' }>
  settingsStore: PromoteWorkspaceSectionProps['settingsStore']
}): Promise<{ replicaSyncedAt: string | undefined; localCopyRemoved: boolean }> {
  const { BrowserWorkspaceDocs } = await import('../../lib/browser-workspace-docs.js')
  const { cacheDaemonWorkspace } = await import('../../lib/replica-cache.js')
  const cache = await cacheDaemonWorkspace({
    fetch: fetchImpl,
    daemonBaseUrl,
    workspaceId,
    workspaceDocs: new BrowserWorkspaceDocs(),
  })
  if (cache.kind === 'withheld') {
    log.warn('replica cache after promote withheld: reconnect and try again')
    return { replicaSyncedAt: undefined, localCopyRemoved: false }
  }
  if (cache.kind !== 'ok') {
    log.warn('replica cache after promote failed', cache.reason)
    return { replicaSyncedAt: undefined, localCopyRemoved: false }
  }

  // Register the replica NOW: findReplicaForHandle and the shell notice read
  // the registry, and an entry that only appears on some later visit leaves
  // the fresh cache invisible offline.
  const { withReplicaEntry } = await import('../../lib/replicas.js')
  settingsStore.update((current) =>
    withReplicaEntry(current, workspaceId, {
      daemonBaseUrl,
      syncedAt: cache.syncedAt,
      syncedFrontier: cache.syncedFrontier,
      ...(target?.segment === undefined ? {} : { segment: target.segment }),
      ...(target?.displayName === undefined ? {} : { displayName: target.displayName }),
    }),
  )

  if (outcome.blobs.failed.length > 0 || outcome.blobs.missing.length > 0) {
    return { replicaSyncedAt: cache.syncedAt, localCopyRemoved: false }
  }

  try {
    const { demoteBrowserWorkspace, replicaCarriesAll } = await import(
      '../../lib/demote-browser-workspace.js'
    )
    const carried = await replicaCarriesAll(
      new BrowserWorkspaceDocs(),
      workspaceId,
      outcome.promotedDocumentIds,
    )
    if (!carried) return { replicaSyncedAt: cache.syncedAt, localCopyRemoved: false }
    await demoteBrowserWorkspace(outcome.sourceWorkspaceId)
    return { replicaSyncedAt: cache.syncedAt, localCopyRemoved: true }
  } catch (err) {
    // The move stands either way; a withheld session key or a failed
    // deletion only means the old copy lingers, which the report says
    // plainly.
    log.warn('demote after promote failed', err)
    return { replicaSyncedAt: cache.syncedAt, localCopyRemoved: false }
  }
}

/**
 * What is left in THIS browser afterwards. The two are independent: a
 * replica can be cached whether or not the original was removed, and the
 * removal is what a reader most needs told.
 */
function browserCopyNotes(result: PromotionResultRecord & { ok: true }): string[] {
  const notes: string[] = []
  if (result.replicaSyncedAt !== undefined) {
    notes.push('The daemon workspace is now cached in this browser')
  }
  notes.push(
    result.localCopyRemoved === true
      ? 'The browser copy was removed — the cached replica serves offline reads'
      : 'The original copy is kept in this browser',
  )
  return notes
}

/** The failed uploads as the record keeps them: the files, and each distinct reason once. */
function failedBlobFields(failed: ReadonlyArray<{ fileId: string; reason: string }>) {
  return {
    blobsFailed: failed.map((failure) => failure.fileId),
    blobFailureReasons: [...new Set(failed.map((failure) => failure.reason))],
  }
}

function describeResult(result: PromotionResultRecord): string {
  if (!result.ok) {
    return `Move to daemon workspace "${result.workspaceId}" failed: ${result.reason}`
  }
  const parts = [
    `Moved ${result.promotedCount} document${result.promotedCount === 1 ? '' : 's'} to daemon workspace "${result.workspaceId}"`,
    ...carryNotes(result),
    ...browserCopyNotes(result),
  ]
  return `${parts.join('. ')}.`
}

export function PromoteWorkspaceSection({
  daemon,
  settingsStore,
  reload,
  baseFetch,
  workspaceId,
}: PromoteWorkspaceSectionProps) {
  const targetSelectId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [flow, setFlow] = useState<PromoteFlow>({ step: 'idle' })
  const [tier, setTier] = useState<ReplicaTier>()

  // What this device keeps of the workspace in view (ADR-0042's read plane).
  // Reads the summary this section otherwise never fetches for itself — the
  // Move flow's own listWorkspaces call answers move TARGETS, not the
  // current workspace's own row.
  useEffect(() => {
    if (!daemon || workspaceId === undefined) {
      setTier(undefined)
      return
    }
    // Clear the OLD workspace's line immediately: without this, switching
    // workspaceId while mounted leaves the stale sentence on screen until
    // the new fetch resolves.
    setTier(undefined)
    let cancelled = false
    listWorkspaces(daemonFetch(daemon, baseFetch), daemon.baseUrl)
      .then((response) => {
        if (cancelled) return
        const row = response.workspaces.find((ws) => ws.workspaceId === workspaceId)
        setTier(row?.tier)
      })
      .catch(() => {
        if (!cancelled) setTier(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [daemon?.baseUrl, daemon?.token, baseFetch, workspaceId])
  const [lastResult, setLastResult] = useState<PromotionResultRecord | undefined>(
    () => settingsStore.load().migration.promotion,
  )

  // Re-read on daemon change so a reconnect shows the result recorded under it.
  useEffect(() => {
    setLastResult(settingsStore.load().migration.promotion)
  }, [settingsStore])

  const openConfirmation = useCallback(async () => {
    if (!daemon) return
    const fetchImpl = daemonFetch(daemon, baseFetch)
    try {
      const [
        { countBrowserWorkspaceDocuments },
        { BrowserWorkspaceDocs },
        { foldWorkspaceDocuments },
        workspaces,
      ] = await Promise.all([
        import('../../lib/promote-workspace.js'),
        import('../../lib/browser-workspace-docs.js'),
        import('../../lib/fold-workspace.js'),
        listWorkspaces(fetchImpl, daemon.baseUrl),
      ])
      // Settings can be a session's first surface (deep-link/reload), so the
      // startup fold may not have run yet — and this count reads the
      // workspace record, which without the fold silently omits an older
      // build's per-document records. Non-fatal, and its OWN catch: a fold
      // failure degrades to the pre-fold view (undercounted but open) and is
      // a storage-side problem, so it must not read as the outer catch's
      // "could not reach the daemon".
      try {
        await foldWorkspaceDocuments()
      } catch (err) {
        log.warn('startup fold failed; continuing without it', err)
      }
      const documentCount = await countBrowserWorkspaceDocuments(new BrowserWorkspaceDocs())
      const targets: WorkspaceIdentity[] = workspaces.workspaces.map((ws) => ({
        workspaceId: ws.workspaceId,
        ...(ws.segment === undefined ? {} : { segment: ws.segment }),
        ...(ws.displayName === undefined ? {} : { displayName: ws.displayName }),
      }))
      if (documentCount === 0) {
        setFlow({ step: 'unavailable', reason: 'This browser keeps no documents to move.' })
        return
      }
      if (targets.length === 0) {
        setFlow({
          step: 'unavailable',
          reason: 'The daemon has no workspace to move into yet. Open one on the daemon first.',
        })
        return
      }
      setFlow({
        step: 'confirm',
        documentCount,
        targets,
        targetId: (targets[0] as { workspaceId: string }).workspaceId,
      })
    } catch {
      setFlow({ step: 'unavailable', reason: 'Could not reach the daemon to prepare the move.' })
    }
  }, [daemon, baseFetch])

  const runPromotion = useCallback(
    async (targetId: string, target?: WorkspaceIdentity) => {
      if (!daemon) return
      setFlow({ step: 'running', phase: 'record' })
      let record: PromotionResultRecord
      try {
        const fetchImpl = daemonFetch(daemon, baseFetch)
        const [{ promoteWorkspace }, { BrowserWorkspaceDocs }] = await Promise.all([
          import('../../lib/promote-workspace.js'),
          import('../../lib/browser-workspace-docs.js'),
        ])
        const outcome = await promoteWorkspace({
          fetch: fetchImpl,
          keeperBaseUrl: daemon.baseUrl, // the new KEEPER; today, this daemon
          workspaceId: targetId,
          workspaceDocs: new BrowserWorkspaceDocs(),
          onProgress: (phase) => setFlow({ step: 'running', phase }),
        })
        const after =
          outcome.kind === 'ok'
            ? await cacheAndMaybeDemote({
                fetchImpl,
                daemonBaseUrl: daemon.baseUrl,
                workspaceId: targetId,
                target,
                outcome,
                settingsStore,
              })
            : { replicaSyncedAt: undefined, localCopyRemoved: false }
        const { replicaSyncedAt, localCopyRemoved } = after

        record =
          outcome.kind === 'ok'
            ? {
                at: new Date().toISOString(),
                daemonBaseUrl: daemon.baseUrl,
                workspaceId: targetId,
                sourceWorkspaceId: outcome.sourceWorkspaceId,
                ...(replicaSyncedAt === undefined ? {} : { replicaSyncedAt }),
                localCopyRemoved,
                ok: true,
                promotedCount: outcome.promotedDocumentIds.length,
                shadowedPaths: outcome.shadowedPaths,
                blobsMissing: outcome.blobs.missing,
                ...failedBlobFields(outcome.blobs.failed),
              }
            : {
                at: new Date().toISOString(),
                daemonBaseUrl: daemon.baseUrl,
                workspaceId: targetId,
                ok: false,
                reason: outcome.reason,
              }
      } catch {
        // promoteWorkspace itself never throws — this net is for the dynamic
        // imports (an offline chunk load). Without it the flow would stay
        // 'running' forever, dialog open, trigger disabled, with no way out.
        record = {
          at: new Date().toISOString(),
          daemonBaseUrl: daemon.baseUrl,
          workspaceId: targetId,
          ok: false,
          reason: 'Part of the app failed to load. Reload the page and try again.',
        }
      }
      settingsStore.update((current) => ({
        ...current,
        migration: { ...current.migration, promotion: record },
      }))
      setLastResult(record)
      setFlow({ step: 'idle' })
    },
    [daemon, baseFetch, settingsStore],
  )

  return (
    <section aria-label="This workspace" className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">This workspace</p>
      {daemon ? (
        <p className="text-xs text-muted-foreground">
          Move everything this browser keeps — documents, their edit history, and referenced images
          — to the daemon. Documents keep their identity, so links between them keep working. Your
          documents also stay in this browser.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Connect a daemon to move the documents this browser keeps onto it, with their edit history
          and images.
        </p>
      )}
      {tier !== undefined && (
        <p data-testid="replica-tier-line" className="text-xs text-muted-foreground">
          {REPLICA_TIER_COPY[tier]}
        </p>
      )}
      <Button
        type="button"
        ref={triggerRef}
        variant="outline"
        size="sm"
        className="self-start"
        data-testid="promote-workspace-open"
        disabled={!daemon || flow.step === 'running'}
        onClick={() => void openConfirmation()}
      >
        Move to daemon…
      </Button>

      {/* Mounted whenever there is anything to report, so the outcome reads
          here on every later visit — the persistent surface, not a toast.
          Bound to the daemon it happened against: a result recorded under
          daemon A (and its reload offer) must not read as actionable while
          connected to daemon B. */}
      {flow.step === 'unavailable' && (
        <p data-testid="promote-unavailable" className="text-xs text-muted-foreground">
          {flow.reason}
        </p>
      )}
      {lastResult !== undefined &&
        lastResult.daemonBaseUrl === daemon?.baseUrl &&
        flow.step !== 'running' && (
          <div data-testid="promote-last-result" className="rounded-md border px-3 py-2 text-xs">
            <p>{describeResult(lastResult)}</p>
            {lastResult.ok && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                data-testid="promote-reload"
                onClick={() => (reload ?? (() => window.location.assign('/')))()}
              >
                Reload and continue from the daemon
              </Button>
            )}
          </div>
        )}

      <Dialog
        open={flow.step === 'confirm' || flow.step === 'running'}
        onOpenChange={(open) => {
          // No mid-transfer cancel: the merge is atomic on the daemon side and
          // aborting the dialog would only hide, not stop, the request.
          if (!open && flow.step === 'confirm') setFlow({ step: 'idle' })
        }}
      >
        <DialogContent
          data-testid="promote-dialog"
          showCloseButton={flow.step === 'confirm'}
          // The dialog opens from a plain controlled button (no Radix
          // trigger), so closing must hand focus back to it explicitly.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
        >
          {flow.step === 'confirm' && (
            <>
              <DialogHeader>
                <DialogTitle>Move this workspace to the daemon</DialogTitle>
                <DialogDescription>
                  All {flow.documentCount} document{flow.documentCount === 1 ? '' : 's'} move to the
                  daemon workspace you choose, with their full edit history and referenced images.
                  If a path already exists there, both versions are kept and the existing one is
                  marked shadowed — nothing is renamed or overwritten. Once every document and image
                  is confirmed on the daemon, the old copy here is removed; this browser keeps a
                  cached replica that opens read-only when the daemon cannot be reached.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                {/* Names are chrome, ids are the address (DESIGN.md): an
                    option shows the display name and falls back to the
                    identifier only when the workspace is unnamed — and a
                    single choice renders as plain text, not a selector. */}
                {flow.targets.length === 1 ? (
                  <p className="text-xs">
                    <span className="font-medium">Daemon workspace: </span>
                    <span data-testid="promote-target-single">
                      {flow.targets[0] ? workspaceLabel(flow.targets[0]) : null}
                    </span>
                  </p>
                ) : (
                  <>
                    <label htmlFor={targetSelectId} className="text-xs font-medium">
                      Daemon workspace
                    </label>
                    <select
                      id={targetSelectId}
                      data-testid="promote-target"
                      value={flow.targetId}
                      onChange={(event) => setFlow({ ...flow, targetId: event.target.value })}
                      className="rounded-md border bg-background px-2 py-1.5 text-sm"
                    >
                      {flow.targets.map((target) => (
                        <option key={target.workspaceId} value={target.workspaceId}>
                          {workspaceLabel(target)}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setFlow({ step: 'idle' })}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  data-testid="promote-confirm"
                  onClick={() =>
                    void runPromotion(
                      flow.targetId,
                      flow.targets.find((ws) => ws.workspaceId === flow.targetId),
                    )
                  }
                >
                  Move workspace
                </Button>
              </DialogFooter>
            </>
          )}
          {flow.step === 'running' && (
            <>
              <DialogHeader>
                <DialogTitle>Moving this workspace</DialogTitle>
                <DialogDescription>
                  This can take a moment. Keep this page open until it finishes.
                </DialogDescription>
              </DialogHeader>
              {/* Indeterminate and narrated from the transfer's real phases —
                  no fake progress bar. Polite live region so the change is
                  announced without stealing focus. */}
              <p
                role="status"
                aria-live="polite"
                data-testid="promote-progress"
                className="text-sm"
              >
                {flow.phase === 'record'
                  ? 'Moving documents and their history…'
                  : 'Moving referenced images…'}
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
