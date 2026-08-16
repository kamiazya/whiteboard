import { z } from 'zod'
import { getAppLogger } from './app-logger.js'

// Single source of truth for the `excalidraw:merge_committed` window CustomEvent
// contract. MergeDialog dispatches; MergeToast subscribes. A schema here
// instead of independently hand-written detail shapes on each side avoids the
// drift pattern flagged in AGENTS.md's Zod Schema Discipline section.
export const MERGE_COMMITTED_EVENT = 'excalidraw:merge_committed'

// Non-strict: unknown fields are stripped rather than rejected so the
// dispatcher can grow the detail shape without a lockstep parser change.
export const mergeCommittedDetailSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  sourceName: z.string(),
  targetName: z.string(),
  newCount: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  preMergeVersionId: z.string().optional(),
  newElementIds: z.array(z.string()),
  conflictElementIds: z.array(z.string()),
  switchedHead: z.object({ from: z.string(), to: z.string() }).optional(),
  deletedSource: z.string().optional(),
})

export type MergeCommittedDetail = z.infer<typeof mergeCommittedDetailSchema>

const log = getAppLogger('merge-committed-event')

export function dispatchMergeCommitted(detail: MergeCommittedDetail): void {
  window.dispatchEvent(new CustomEvent(MERGE_COMMITTED_EVENT, { detail }))
}

// Subscribers call this instead of reading event.detail directly so a
// malformed payload is safely ignored (logged, never thrown) rather than
// crashing the toast/highlight overlay.
export function parseMergeCommittedEvent(event: Event): MergeCommittedDetail | null {
  const detail = (event as CustomEvent<unknown>).detail
  const result = mergeCommittedDetailSchema.safeParse(detail)
  if (!result.success) {
    log.warn('ignoring invalid merge_committed event detail', result.error.issues)
    return null
  }
  return result.data
}
