// The pages a document is open in, and the text events the daemon sends them.
//
// Every page is reached over its SSE sync stream (sync-streams.ts holds the
// streams): the WebSocket that used to carry the same traffic is retired
// (ADR-0050 decision 1). This module is the document-level vocabulary the
// rest of the daemon speaks — "announce a version", "ask the open pages to
// move their viewport", "how many pages have this document open" — so a
// caller names what it means and never which transport carries it.
import type { VersionEntry } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type {
  AgentActivityMessage,
  ServerTextMessage,
  ViewportRequestParams,
} from '@kamiazya/whiteboard-daemon-client/sync-frames'
import {
  sseBroadcastText,
  sseBroadcastTextToReady,
  sseClientCount,
  sseSubscribedWorkspaceIds,
} from './sync-streams.js'
import { cacheViewportRequest } from './viewport-requests.js'

/**
 * The workspaces with a live audience on THIS instance — an SSE stream
 * subscribed to the workspace record.
 *
 * Read by the workspace tail so it follows only records somebody is watching.
 */
export function subscribedWorkspaceIds(): string[] {
  return sseSubscribedWorkspaceIds()
}

function omitUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o) as Array<[keyof T, T[keyof T]]>) {
    if (v !== undefined) out[k] = v
  }
  return out
}

function broadcastTextMessage(workspaceId: string, path: string, message: ServerTextMessage): void {
  sseBroadcastText(workspaceId, path, JSON.stringify(message))
}

export function sendVersionCreated(workspaceId: string, path: string, version: VersionEntry): void {
  broadcastTextMessage(workspaceId, path, { type: 'version_created', version })
}

// Soft lock for restore: clients block pointer events while started is active to
// reduce races with other peers during the typically short restore window (<1s).
export function sendRestoreEvent(
  workspaceId: string,
  path: string,
  phase: 'started' | 'complete',
  label?: string,
): void {
  const message: ServerTextMessage =
    phase === 'started'
      ? { type: 'restore_started', ...omitUndefined({ label }) }
      : { type: 'restore_complete' }
  broadcastTextMessage(workspaceId, path, message)
}

/**
 * Announce what an agent just did. Sent to every open page, not just ready
 * ones, and never cached: a page that opens later already has the edit itself
 * through the snapshot, so replaying the announcement would highlight a change
 * it has always had.
 */
export function sendAgentActivity(
  workspaceId: string,
  path: string,
  payload: Omit<AgentActivityMessage, 'type'>,
): void {
  broadcastTextMessage(workspaceId, path, { type: 'agent_activity', ...payload })
}

export function sendViewportRequest(
  workspaceId: string,
  path: string,
  requestId: string,
  params: ViewportRequestParams = {},
): void {
  const raw = JSON.stringify({
    type: 'viewport_request',
    requestId,
    ...omitUndefined(params),
  } satisfies ServerTextMessage)
  cacheViewportRequest(`${workspaceId}/${path}`, raw)
  // Only to ready pages: a pre-ready page cannot apply the viewport yet and
  // is sent the cached request when it signals `client_ready`, so sending it
  // now as well would deliver it twice.
  sseBroadcastTextToReady(workspaceId, path, raw)
}

/** The pages a document is open in. */
export function getClientCount(workspaceId: string, path: string): number {
  return sseClientCount(workspaceId, path, false)
}

/** The pages a document is open in that have signalled `client_ready`. */
export function getReadyClientCount(workspaceId: string, path: string): number {
  return sseClientCount(workspaceId, path, true)
}
