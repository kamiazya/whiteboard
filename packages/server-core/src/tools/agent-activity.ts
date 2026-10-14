import { messageOf } from '@kamiazya/whiteboard-model'
import { getLogger } from '../log.js'
import type { AgentActivity, ServerDeps } from '../server-deps.js'

const log = getLogger('agent-activity')

type Touched = AgentActivity['touched']

/** Which document a notification is about, plus what it touched there; an omitted kind touched nothing. */
type AnnouncedWrite = {
  readonly workspaceId: string
  readonly documentId: string
} & Partial<Touched>

/**
 * Tell a person watching a board that an agent just changed it — the
 * "Agent editing" chip and the outline over what was touched (ADR-0010).
 *
 * Every tool that writes to a board calls this, after its save: an edit a
 * human is shown must be one that landed, and a writer that skips it changes
 * the board with no sign of who did. Wrapped because the write is already
 * committed when anyone is told, so a broken socket surfacing as a tool error
 * would report a failure for an edit that SUCCEEDED; the notifier is expected
 * to handle its own transport errors, so what reaches here is logged.
 */
export function announceAgentActivity(
  deps: ServerDeps,
  write: AnnouncedWrite,
  summary: string,
): void {
  const notifier = deps.clientNotifier
  if (notifier === undefined) return
  const { workspaceId, documentId } = write
  try {
    notifier.agentActivity({
      workspaceId,
      documentId,
      touched: {
        nodes: write.nodes ?? [],
        edges: write.edges ?? [],
        lines: write.lines ?? [],
        comments: write.comments ?? [],
      },
      summary,
    })
  } catch (err) {
    notificationFailed(write, 'agentActivity', err)
  }
}

/**
 * The words a watching person reads for a write to a document's threads, in
 * the order a summary lists them. Both `wb_canvas_edit` and `wb_thread_edit`
 * write the same thread plane (ADR-0026), so they share one vocabulary: the
 * same act must read the same whichever tool the agent reached for.
 */
export const COMMENT_SUMMARY_WORDS = ['commented', 'replied', 'resolved', 'reopened'] as const

/** A resolve op closes unless it says `resolved: false`, which reopens. */
export function resolveSummaryWord(resolved: boolean | undefined): 'resolved' | 'reopened' {
  return resolved === false ? 'reopened' : 'resolved'
}

export function notificationFailed(
  write: { readonly workspaceId: string; readonly documentId: string },
  notification: 'agentActivity' | 'requestViewport',
  err: unknown,
): void {
  log.warning('a client notification failed after the edit landed', {
    workspaceId: write.workspaceId,
    documentId: write.documentId,
    notification,
    err: messageOf(err),
  })
}
