import type { ReactNode } from 'react'
import type { MembershipRefusedState } from './daemon-page-state.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

/**
 * One `role="status"` region for the `loading` span, so a screen reader
 * tracks one DOM node rather than a fresh one that arrives already carrying
 * its message (polite-live-region.test.ts). Empty during `loading` — the
 * skeleton announces that state through its own `role="status"`.
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
 * The terminal render for a `membership-refused` page state: the removed
 * surface. No backend is ever built for it (the page's `canvas`/document
 * memos stay unresolved, so no SSE subscribe is attempted either).
 */
export function membershipRefusedScreen(
  state: MembershipRefusedState,
  daemonBaseUrl: string,
  retry: () => void,
): ReactNode {
  return (
    <ReplicaReadPage
      workspaceId={state.workspaceId}
      daemonBaseUrl={daemonBaseUrl}
      withheld={state.code}
      onReconnect={retry}
    />
  )
}
