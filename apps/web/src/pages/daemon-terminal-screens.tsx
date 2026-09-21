import type { ReactNode } from 'react'
import { MembershipGateView } from '../components/document-editor/MembershipGateView.js'
import { PASSKEY_NEEDED_COPY } from '../lib/membership-refusal.js'
import type { MembershipRefusedState } from './daemon-page-state.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

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
