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
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { createDaemonFetch, listWorkspaces } from '@/lib/daemon-api-client'
import type { PromotionResultRecord, UserSettings } from '@/lib/user-settings-store'

export interface PromoteWorkspaceSectionProps {
  daemon?: { baseUrl: string; token: string | null }
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
}

type PromoteFlow =
  | { step: 'idle' }
  | { step: 'confirm'; documentCount: number; workspaceIds: string[]; targetId: string }
  | { step: 'running'; phase: 'record' | 'blobs' }
  | { step: 'unavailable'; reason: string }

function describeResult(result: PromotionResultRecord): string {
  if (!result.ok) {
    return `Move to daemon workspace "${result.workspaceId}" failed: ${result.reason ?? 'unknown error'}`
  }
  const parts = [
    `Moved ${result.promotedCount ?? 0} document${(result.promotedCount ?? 0) === 1 ? '' : 's'} to daemon workspace "${result.workspaceId}"`,
  ]
  if ((result.shadowedPaths?.length ?? 0) > 0) {
    parts.push(
      `${result.shadowedPaths?.length} path${result.shadowedPaths?.length === 1 ? '' : 's'} already existed there — both versions are kept, the earlier one marked shadowed: ${result.shadowedPaths?.join(', ')}`,
    )
  }
  if ((result.blobsMissing?.length ?? 0) > 0) {
    parts.push(
      `${result.blobsMissing?.length} referenced image${result.blobsMissing?.length === 1 ? ' was' : 's were'} already missing from this browser and could not be moved`,
    )
  }
  if ((result.blobsFailed?.length ?? 0) > 0) {
    parts.push(
      `${result.blobsFailed?.length} image upload${result.blobsFailed?.length === 1 ? '' : 's'} failed — moving again retries them safely`,
    )
  }
  return `${parts.join('. ')}.`
}

export function PromoteWorkspaceSection({
  daemon,
  settingsStore,
  reload,
  baseFetch,
}: PromoteWorkspaceSectionProps) {
  const targetSelectId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [flow, setFlow] = useState<PromoteFlow>({ step: 'idle' })
  const [lastResult, setLastResult] = useState<PromotionResultRecord | undefined>(
    () => settingsStore.load().migration.promotion,
  )

  // Re-read on daemon change so a reconnect shows the result recorded under it.
  useEffect(() => {
    setLastResult(settingsStore.load().migration.promotion)
  }, [settingsStore])

  const openConfirmation = useCallback(async () => {
    if (!daemon) return
    const fetchImpl = createDaemonFetch(
      daemon.baseUrl,
      daemon.token ?? undefined,
      baseFetch ?? globalThis.fetch.bind(globalThis),
    )
    try {
      const [{ countBrowserWorkspaceDocuments }, { BrowserWorkspaceDocs }, workspaces] =
        await Promise.all([
          import('../../lib/promote-workspace.js'),
          import('../../lib/browser-workspace-docs.js'),
          listWorkspaces(fetchImpl, daemon.baseUrl),
        ])
      const documentCount = await countBrowserWorkspaceDocuments(new BrowserWorkspaceDocs())
      const workspaceIds = workspaces.workspaces.map((ws) => ws.workspaceId)
      if (documentCount === 0) {
        setFlow({ step: 'unavailable', reason: 'This browser keeps no documents to move.' })
        return
      }
      if (workspaceIds.length === 0) {
        setFlow({
          step: 'unavailable',
          reason: 'The daemon has no workspace to move into yet. Open one on the daemon first.',
        })
        return
      }
      setFlow({
        step: 'confirm',
        documentCount,
        workspaceIds,
        targetId: workspaceIds[0] as string,
      })
    } catch {
      setFlow({ step: 'unavailable', reason: 'Could not reach the daemon to prepare the move.' })
    }
  }, [daemon, baseFetch])

  const runPromotion = useCallback(
    async (targetId: string) => {
      if (!daemon) return
      setFlow({ step: 'running', phase: 'record' })
      let record: PromotionResultRecord
      try {
        const fetchImpl = createDaemonFetch(
          daemon.baseUrl,
          daemon.token ?? undefined,
          baseFetch ?? globalThis.fetch.bind(globalThis),
        )
        const [{ promoteWorkspace }, { BrowserWorkspaceDocs }] = await Promise.all([
          import('../../lib/promote-workspace.js'),
          import('../../lib/browser-workspace-docs.js'),
        ])
        const outcome = await promoteWorkspace({
          fetch: fetchImpl,
          daemonBaseUrl: daemon.baseUrl,
          workspaceId: targetId,
          workspaceDocs: new BrowserWorkspaceDocs(),
          onProgress: (phase) => setFlow({ step: 'running', phase }),
        })
        record =
          outcome.kind === 'ok'
            ? {
                at: new Date().toISOString(),
                daemonBaseUrl: daemon.baseUrl,
                workspaceId: targetId,
                ok: true,
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
                  marked shadowed — nothing is renamed or overwritten. Your documents also stay in
                  this browser.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
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
                  {flow.workspaceIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setFlow({ step: 'idle' })}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  data-testid="promote-confirm"
                  onClick={() => void runPromotion(flow.targetId)}
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
