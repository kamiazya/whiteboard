/**
 * The control flow every maintenance button in `StorageReportCard` shares,
 * and the one reader of the storage report it shows.
 *
 * Four of them were the same forty lines with different nouns: set busy,
 * announce, list the workspaces, POST once per workspace, accumulate, say
 * what happened, refresh, clear the status. The differences are the endpoint
 * and how a response adds to a total, which is what these take as arguments.
 */

import {
  listWorkspacesResponseSchema,
  type StorageReportPayload,
  storageReportApiUrl,
  storageReportPayloadSchema,
  workspacesApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { messageOf } from '@kamiazya/whiteboard-model'
import type { RefObject } from 'react'
import { useCallback } from 'react'
import type { z } from 'zod'
import { readDaemonJson } from '../lib/daemon-contract-error.js'

/**
 * The storage report, or the reason it could not be read — the one reader of
 * that route, for the card that shows it and the page that quotes its total.
 */
export async function readStorageReport(
  fetchApi: typeof globalThis.fetch,
): Promise<{ report: StorageReportPayload } | { error: string }> {
  try {
    const res = await fetchApi(storageReportApiUrl())
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return { report: await readDaemonJson(storageReportApiUrl(), res, storageReportPayloadSchema) }
  } catch (err) {
    return { error: messageOf(err, String(err)) }
  }
}

/** What a sweep produced, plus how many workspaces refused it. */
export interface SweepResult<T> {
  total: T
  failedWorkspaces: number
}

/**
 * Run one POST against EVERY workspace, accumulating whatever each answer
 * contributes. `null` means the workspace LIST itself could not be read, so
 * nothing was attempted.
 *
 * A per-workspace failure does not abort the loop — the others may still
 * succeed — so the count comes back with the total and the caller's summary
 * says so explicitly. Reporting "Saved" or "Already optimal" on a partial
 * failure would tell the user everything succeeded when it did not.
 *
 * Every answer is read through `schema`, so a response the page cannot read is
 * reported with its route like any other daemon contract mismatch.
 */
export async function sweepWorkspaces<T, R>(
  fetchApi: typeof globalThis.fetch,
  pathFor: (workspaceId: string) => string,
  schema: z.ZodType<R>,
  accumulate: (total: T, answer: R) => T,
  seed: T,
): Promise<SweepResult<T> | null> {
  const listed = await fetchApi(workspacesApiUrl())
  if (!listed.ok) return null
  const { workspaces } = await readDaemonJson(
    workspacesApiUrl(),
    listed,
    listWorkspacesResponseSchema,
  )

  let total = seed
  let failedWorkspaces = 0
  // Sequential on purpose: the doc-cache eviction inside each compact stays
  // coherent only if one workspace finishes before the next begins.
  for (const { workspaceId } of workspaces) {
    const url = pathFor(workspaceId)
    const res = await fetchApi(url, { method: 'POST' })
    if (!res.ok) {
      failedWorkspaces += 1
      continue
    }
    total = accumulate(total, await readDaemonJson(url, res, schema))
  }
  return { total, failedWorkspaces }
}

/** One maintenance button's wiring, minus what it actually does. */
export interface MaintenanceAction {
  setBusy: (busy: boolean) => void
  setStatus: (status: string | null) => void
  /** Shown while it runs. */
  running: string
  /** Shown when `run` answers `null` or throws. */
  failed: string
  /** The summary line, or `null` for the failure text above. */
  run: () => Promise<string | null>
}

/**
 * A runner for one maintenance action, holding the two things every one of
 * them has to respect.
 *
 * `mountedRef` guards every post-await `setState`: these handlers resume
 * after an await, and a resumed call can outlive the component. A live jsdom
 * `window` makes an unmounted-root setState harmless, but if the environment
 * itself is torn down before the callback resumes, the same call throws.
 *
 * `scheduleStatusClear` retires the transient line afterwards, whether the
 * action succeeded or not.
 */
export function useMaintenanceRunner(
  mountedRef: RefObject<boolean>,
  scheduleStatusClear: (clear: () => void) => void,
  refresh: () => Promise<void>,
) {
  return useCallback(
    async (action: MaintenanceAction): Promise<void> => {
      action.setBusy(true)
      action.setStatus(action.running)
      try {
        const summary = await action.run()
        if (!mountedRef.current) return
        action.setStatus(summary ?? action.failed)
        // Only a run that got somewhere is worth re-reading the report for.
        if (summary !== null) void refresh()
      } catch {
        if (mountedRef.current) action.setStatus(action.failed)
      } finally {
        if (mountedRef.current) {
          action.setBusy(false)
          scheduleStatusClear(() => action.setStatus(null))
        }
      }
    },
    [mountedRef, scheduleStatusClear, refresh],
  )
}
