import type { ReactNode } from 'react'
import { PASSKEY_NEEDED_COPY } from '../../lib/membership-refusal.js'
import type { MembershipRefusedState } from '../../pages/daemon-page-state.js'
import { ReplicaReadPage } from '../../pages/ReplicaReadPage.js'
import { Button } from '../ui/button.js'

/**
 * The full-page render of `daemon-page-state.ts`'s `membership-refused`
 * kind for a `requires_person_session` refusal (ADR-0041/0042 S8 slice 3):
 * the session simply has not bound its passkey yet, so the page asks once
 * rather than showing an error. A `not_a_member` refusal is a different
 * page entirely — S5's removed surface (`ReplicaReadPage` with `withheld`)
 * — because it is a stated ban, not a retryable condition.
 *
 * This view carries no `role="status"` of its own: it is only ever mounted
 * once the loading skeleton it replaces unmounts, so a status region born
 * here would arrive already carrying its message (polite-live-region.test.ts)
 * — DaemonDocumentPage's persistent status paragraph announces it instead.
 */
function MembershipGateView({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{PASSKEY_NEEDED_COPY.body}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {PASSKEY_NEEDED_COPY.action}
      </Button>
    </div>
  )
}

/**
 * One `role="status"` region, mounted for the whole `loading` ->
 * `membership-refused` (requires_person_session) span, so the DOM node a
 * screen reader is already tracking just gets new text rather than being
 * replaced by a fresh one that arrives already carrying its message
 * (polite-live-region.test.ts). Empty during `loading` — the skeleton
 * announces that state through its own `role="status"` — and only speaks
 * once `MembershipGateView`'s copy is the thing to announce. Reused across
 * renders because it is the SAME component reference at both call sites:
 * that is what keeps React from tearing the paragraph down when the visible
 * child underneath it swaps from the skeleton to the gate view.
 */
export function DaemonTerminalScreen({
  status,
  children,
}: {
  status: string
  children: ReactNode
}) {
  return (
    <>
      <p role="status" aria-live="polite" data-testid="daemon-live-status" className="sr-only">
        {status}
      </p>
      {children}
    </>
  )
}

/**
 * The terminal render for a `membership-refused` page state. No backend is
 * ever built for it (the page's `canvas`/document memos stay unresolved, so no
 * WS/SSE subscribe is attempted either). `not_a_member` lands on the removed
 * surface; `requires_person_session` offers the one retry the controller's
 * own once-only bind guard did not spend.
 */
export function membershipRefusedScreen(
  state: MembershipRefusedState,
  daemonBaseUrl: string,
  retry: () => void,
): ReactNode {
  if (state.code === 'not_a_member') {
    return (
      <ReplicaReadPage
        workspaceId={state.workspaceId}
        daemonBaseUrl={daemonBaseUrl}
        renewal="unreachable"
        withheld="not_a_member"
        onReconnect={retry}
      />
    )
  }
  return (
    <DaemonTerminalScreen status={PASSKEY_NEEDED_COPY.body}>
      <MembershipGateView onRetry={retry} />
    </DaemonTerminalScreen>
  )
}
