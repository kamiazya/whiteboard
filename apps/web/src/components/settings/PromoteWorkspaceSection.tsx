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
import {
  attestPromotion,
  getRegisteredPasskey,
  type PasskeyCredentials,
  passkeySupported,
  registerPasskey,
} from '../../lib/passkey-attestation.js'
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
   * Test seam for WebAuthn: the page's own `navigator.credentials` when
   * omitted, `null` to stand in for a browser without passkeys.
   */
  passkeyCredentials?: PasskeyCredentials | null
  /**
   * The daemon-kept workspace in view. The line about what this device
   * keeps of it is hidden without one — a cold load with a daemon merely
   * detected names no workspace yet.
   */
  workspaceId?: string
}

/**
 * The passkey a promotion is confirmed with (ADR-0039 decision 4: asked at
 * the trust boundary, and nowhere else). `none` BLOCKS the move now (user
 * decision, 2026-09-22): the destination generalised from the daemon on
 * this machine to a keeper the user does not own, so an unconfirmed
 * crossing is no longer a thing to record and say so about. `unsupported`
 * blocks it for the same reason and is the sharper cost — a browser without
 * WebAuthn cannot transfer at all.
 */
type PasskeyState =
  | { kind: 'unsupported' }
  | { kind: 'none' }
  | { kind: 'registering' }
  | { kind: 'registered' }
  | { kind: 'error'; detail: string }

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

function describeResult(result: PromotionResultRecord): string {
  if (!result.ok) {
    return `Move to daemon workspace "${result.workspaceId}" failed: ${result.reason}`
  }
  const parts = [
    `Moved ${result.promotedCount} document${result.promotedCount === 1 ? '' : 's'} to daemon workspace "${result.workspaceId}"`,
  ]
  if (result.attested === true) parts.push('Your passkey confirmed this move')
  // `false` is the DESTINATION reporting it did not verify what this side
  // signed — not an unconfirmed move, which is refused before the POST.
  else if (result.attested === false) parts.push('The destination did not record a confirmation')
  if (result.shadowedPaths.length > 0) {
    parts.push(
      `${result.shadowedPaths.length} path${result.shadowedPaths.length === 1 ? '' : 's'} already existed there — both versions are kept, the earlier one marked shadowed: ${result.shadowedPaths.join(', ')}`,
    )
  }
  if (result.blobsMissing.length > 0) {
    parts.push(
      `${result.blobsMissing.length} referenced image${result.blobsMissing.length === 1 ? ' was' : 's were'} already missing from this browser and could not be moved`,
    )
  }
  if (result.blobsFailed.length > 0) {
    parts.push(
      `${result.blobsFailed.length} image upload${result.blobsFailed.length === 1 ? '' : 's'} failed — moving again retries them safely`,
    )
  }
  if (result.replicaSyncedAt !== undefined) {
    parts.push('The daemon workspace is now cached in this browser')
  }
  if (result.localCopyRemoved === true) {
    parts.push('The browser copy was removed — the cached replica serves offline reads')
  } else {
    parts.push('The original copy is kept in this browser')
  }
  return `${parts.join('. ')}.`
}

export function PromoteWorkspaceSection({
  daemon,
  settingsStore,
  reload,
  baseFetch,
  passkeyCredentials,
  workspaceId,
}: PromoteWorkspaceSectionProps) {
  const targetSelectId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [flow, setFlow] = useState<PromoteFlow>({ step: 'idle' })
  const [passkey, setPasskey] = useState<PasskeyState>({ kind: 'none' })
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
  // Resolved per call rather than once: a test seam is fixed, but the page's
  // own API is read when it is needed.
  const credentialsOf = useCallback((): PasskeyCredentials | undefined => {
    if (passkeyCredentials === null) return undefined
    if (passkeyCredentials !== undefined) return passkeyCredentials
    return passkeySupported() ? globalThis.navigator.credentials : undefined
  }, [passkeyCredentials])
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
      setPasskey(
        credentialsOf() === undefined
          ? { kind: 'unsupported' }
          : getRegisteredPasskey(daemon.baseUrl) === null
            ? { kind: 'none' }
            : { kind: 'registered' },
      )
      setFlow({
        step: 'confirm',
        documentCount,
        targets,
        targetId: (targets[0] as { workspaceId: string }).workspaceId,
      })
    } catch {
      setFlow({ step: 'unavailable', reason: 'Could not reach the daemon to prepare the move.' })
    }
  }, [daemon, baseFetch, credentialsOf])

  const registerHere = useCallback(async () => {
    const credentials = credentialsOf()
    if (!daemon || credentials === undefined) return
    setPasskey({ kind: 'registering' })
    const result = await registerPasskey({
      daemonBaseUrl: daemon.baseUrl,
      fetch: daemonFetch(daemon, baseFetch),
      credentials,
    })
    if (result.ok) setPasskey({ kind: 'registered' })
    else if (result.reason === 'cancelled') setPasskey({ kind: 'none' })
    else if (result.reason === 'unsupported') setPasskey({ kind: 'unsupported' })
    else setPasskey({ kind: 'error', detail: result.detail ?? result.reason })
  }, [daemon, baseFetch, credentialsOf])

  const runPromotion = useCallback(
    async (targetId: string, target?: WorkspaceIdentity) => {
      // The button is disabled in every other passkey state, and this is
      // the same rule written where the move actually happens: a transfer
      // to another keeper is confirmed with a passkey, so one that is
      // absent, unsupported, failed or still being registered is not a
      // move to be attempted.
      if (!daemon || passkey.kind !== 'registered') return
      setFlow({ step: 'running', phase: 'record' })
      let record: PromotionResultRecord
      try {
        const fetchImpl = daemonFetch(daemon, baseFetch)
        const [{ promoteWorkspace }, { BrowserWorkspaceDocs }] = await Promise.all([
          import('../../lib/promote-workspace.js'),
          import('../../lib/browser-workspace-docs.js'),
        ])
        const credentials = credentialsOf()
        const outcome = await promoteWorkspace({
          fetch: fetchImpl,
          keeperBaseUrl: daemon.baseUrl, // the new KEEPER; today, this daemon
          workspaceId: targetId,
          workspaceDocs: new BrowserWorkspaceDocs(),
          onProgress: (phase) => setFlow({ step: 'running', phase }),
          // ALWAYS asked, and answering `null` refuses the move — a
          // credential registered then forgotten, or a browser that cannot
          // hold one, is exactly the case a keeper the user does not own
          // must not accept unconfirmed. The button is disabled without a
          // passkey, so this arm is the race rather than the normal path.
          attest: (snapshot: Uint8Array) =>
            credentials === undefined
              ? Promise.resolve(null)
              : attestPromotion({
                  daemonBaseUrl: daemon.baseUrl,
                  workspaceId: targetId,
                  snapshot,
                  credentials,
                }),
        })
        // The demote pull (ADR-0023 decision 2): cache the daemon's merged
        // record back into this browser's planes. Best-effort — the move
        // itself already landed, so a failed pull costs only the cache line
        // on the report, never the promotion.
        let replicaSyncedAt: string | undefined
        let localCopyRemoved = false
        if (outcome.kind === 'ok') {
          const { cacheDaemonWorkspace } = await import('../../lib/replica-cache.js')
          const cache = await cacheDaemonWorkspace({
            fetch: fetchImpl,
            daemonBaseUrl: daemon.baseUrl,
            workspaceId: targetId,
            workspaceDocs: new BrowserWorkspaceDocs(),
          })
          if (cache.kind === 'ok') {
            replicaSyncedAt = cache.syncedAt
            // Register the replica NOW: findReplicaForHandle and the shell
            // notice read the registry, and an entry that only appears on
            // some later visit leaves the fresh cache invisible offline.
            const { withReplicaEntry } = await import('../../lib/replicas.js')
            settingsStore.update((current) =>
              withReplicaEntry(current, targetId, {
                daemonBaseUrl: daemon.baseUrl,
                syncedAt: cache.syncedAt,
                syncedFrontier: cache.syncedFrontier,
                ...(target?.segment === undefined ? {} : { segment: target.segment }),
                ...(target?.displayName === undefined ? {} : { displayName: target.displayName }),
              }),
            )
            // The demote gate (ADR-0023 decision 2): delete the source
            // record only when every image made it across AND the replica
            // read back from this browser holds every promoted document.
            // `missing` gates too: the file store folds read errors into
            // "missing", so those references may be retryable — and the
            // record is the retry vehicle.
            if (outcome.blobs.failed.length === 0 && outcome.blobs.missing.length === 0) {
              // Scoped to its own try/catch, deliberately NOT the outer
              // one below: `replicaCarriesAll` reads through the sealed
              // store and can throw `ReplicaKeyWithheldError` if the
              // session key lapses between the cache write above and this
              // read-back. The promotion itself already landed — letting
              // that escape to the outer catch would report an already-
              // successful move as a failed one. The demote decision is
              // simply deferred (the browser copy stays, same as any
              // other unverified-replica case); a later visit re-asks.
              try {
                const { demoteBrowserWorkspace, replicaCarriesAll } = await import(
                  '../../lib/demote-browser-workspace.js'
                )
                const carried = await replicaCarriesAll(
                  new BrowserWorkspaceDocs(),
                  targetId,
                  outcome.promotedDocumentIds,
                )
                if (carried) {
                  await demoteBrowserWorkspace(outcome.sourceWorkspaceId)
                  localCopyRemoved = true
                }
              } catch (err) {
                // The move stands either way; a withheld session key or a
                // failed deletion only means the old copy lingers, which
                // the report says plainly.
                log.warn('demote after promote failed', err)
              }
            }
          } else if (cache.kind === 'withheld') {
            log.warn('replica cache after promote withheld: reconnect and try again')
          } else log.warn('replica cache after promote failed', cache.reason)
        }
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
                attested: outcome.attested,
                promotedCount: outcome.promotedDocumentIds.length,
                shadowedPaths: outcome.shadowedPaths,
                blobsMissing: outcome.blobs.missing,
                blobsFailed: outcome.blobs.failed,
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
    [daemon, baseFetch, settingsStore, credentialsOf, passkey.kind],
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
              {/* The passkey block: what the move will be confirmed with,
                  and the one place a passkey is registered (ADR-0039).
                  Anything but `registered` BLOCKS the move (user decision,
                  2026-09-22) — the destination is a keeper the user may not
                  own, so there is no unconfirmed crossing to record. The
                  block says which state it is in, because a disabled button
                  with no reason beside it is the same as a broken one. */}
              <div
                data-testid="promote-passkey"
                className="flex flex-col gap-1.5 rounded-md border px-3 py-2 text-xs"
              >
                {passkey.kind === 'registered' && (
                  <p>
                    A passkey is registered for this daemon. You will be asked to confirm the move
                    with it.
                  </p>
                )}
                {passkey.kind === 'none' && (
                  <>
                    <p>
                      No passkey for this daemon yet. Register one to move the workspace — a move
                      to another keeper is confirmed with a passkey.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      data-testid="promote-register-passkey"
                      onClick={() => void registerHere()}
                    >
                      Register a passkey
                    </Button>
                  </>
                )}
                {/* Mounted before it speaks (polite-live-region.test.ts):
                    a status region that arrives with its message is
                    announced inconsistently, so this one is always in the
                    tree and only its text changes. */}
                <p
                  role="status"
                  aria-live="polite"
                  data-testid="promote-passkey-status"
                  className={passkey.kind === 'registering' ? undefined : 'sr-only'}
                >
                  {passkey.kind === 'registering' ? 'Waiting for your passkey…' : ''}
                </p>
                {passkey.kind === 'error' && (
                  <>
                    <p>Registering the passkey failed: {passkey.detail}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      data-testid="promote-register-passkey"
                      onClick={() => void registerHere()}
                    >
                      Try again
                    </Button>
                  </>
                )}
                {passkey.kind === 'unsupported' && (
                  <p>
                    This browser cannot use passkeys, so it cannot move the workspace. Open this
                    page in a browser that can, or export the documents you need.
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setFlow({ step: 'idle' })}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  data-testid="promote-confirm"
                  disabled={passkey.kind !== 'registered'}
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
