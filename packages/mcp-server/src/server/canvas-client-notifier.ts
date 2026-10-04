import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import type {
  AgentActivity,
  CanvasClientNotifier,
  RestoreProgressEvent,
  ServerDeps,
  VersionCreated,
  ViewportRequest,
  ViewportRequestParams,
} from '@kamiazya/whiteboard-server-core'
import { nanoid } from 'nanoid'
import { DAEMON_AGENT_ACTOR } from './daemon-actor.js'
import { getLogger } from './log.js'
import {
  getReadyClientCount,
  sendAgentActivity,
  sendRestoreEvent,
  sendVersionCreated,
  sendViewportRequest,
} from './sync-audience.js'

const log = getLogger('canvas-client-notifier')

/**
 * The request minus its routing keys, typed as the wire's params rather than
 * a `Record<string, unknown>` the compiler could not compare — the shape a
 * field dropped on the way to the browser used to hide in. `sendViewportRequest`
 * strips any `undefined` a direct caller of the port left in.
 */
function viewportPayload(request: ViewportRequest): ViewportRequestParams {
  const { workspaceId: _workspaceId, documentId: _documentId, ...params } = request
  return params
}

// The frame's arrays are mutable and the port's are readonly, so each is copied.
function touchedForFrame(touched: AgentActivity['touched']) {
  return {
    nodes: [...touched.nodes],
    edges: [...touched.edges],
    lines: [...touched.lines],
    comments: [...touched.comments],
  }
}

/**
 * Bridges server-core's `CanvasClientNotifier` port onto the SSE sync
 * streams a page holds open.
 *
 * Two things it owns that server-core cannot:
 *
 * - **documentId -> path.** The audience is keyed by workspace and document
 *   PATH, which is placement, and placement lives in the index rather than
 *   in a tool's arguments.
 * - **Operator identity.** `kind: 'ai'` plus `DAEMON_AGENT_ACTOR`.
 *
 * Every method swallows its own failures. The port's contract is that a tool
 * may call it AFTER its write is committed, so a transport error here must
 * never become the tool's error — that would report a failure for an edit
 * already on disk.
 */
export function createCanvasClientNotifier(documentIndex: DocumentIndex): CanvasClientNotifier {
  async function pathOf(workspaceId: string, documentId: string): Promise<string | null> {
    const entry = await documentIndex.resolveDocumentById({ workspaceId, documentId })
    return entry?.path ?? null
  }

  return {
    agentActivity(activity: AgentActivity): void {
      // Fire-and-forget: the port is synchronous because no caller can act
      // on the outcome, and the path lookup is the only async part.
      void (async () => {
        try {
          const path = await pathOf(activity.workspaceId, activity.documentId)
          if (path === null) return
          sendAgentActivity(activity.workspaceId, path, {
            operator: { kind: 'ai', actor: DAEMON_AGENT_ACTOR },
            touched: touchedForFrame(activity.touched),
            summary: activity.summary,
          })
        } catch (err) {
          log.warning(
            { workspaceId: activity.workspaceId, documentId: activity.documentId, err },
            'failed to announce agent activity',
          )
        }
      })()
    },

    versionCreated(event: VersionCreated): void {
      void (async () => {
        try {
          const path = await pathOf(event.workspaceId, event.documentId)
          if (path === null) return
          sendVersionCreated(event.workspaceId, path, event.version)
        } catch (err) {
          log.warning(
            { workspaceId: event.workspaceId, documentId: event.documentId, err },
            'failed to announce a saved version',
          )
        }
      })()
    },

    restoreProgress(event: RestoreProgressEvent): void {
      // Already path-addressed: the operation resolved the document before
      // it started, so there is no lookup here that could fail.
      try {
        sendRestoreEvent(event.workspaceId, event.path, event.phase, event.label)
      } catch (err) {
        log.warning(
          { workspaceId: event.workspaceId, path: event.path, phase: event.phase, err },
          'failed to announce restore progress',
        )
      }
    },

    async requestViewport(request: ViewportRequest): Promise<boolean> {
      try {
        const path = await pathOf(request.workspaceId, request.documentId)
        if (path === null) return false
        // `sendViewportRequest` records the request for replay on `client_ready`
        // and sends it only to pages that already are ready, so it runs even
        // with none: the first page to open inherits the request. What is
        // REPORTED is narrower — only a READY client can apply a viewport, and
        // "someone is watching right now" is what `delivered` means.
        const watching = getReadyClientCount(request.workspaceId, path) > 0
        sendViewportRequest(request.workspaceId, path, nanoid(), viewportPayload(request))
        return watching
      } catch (err) {
        log.warning(
          { workspaceId: request.workspaceId, documentId: request.documentId, err },
          'failed to move a watching viewport',
        )
        return false
      }
    },
  }
}

/**
 * `deps` with the live audience attached: what an agent does through a tool
 * (agent activity, a saved version, restore progress, a viewport request)
 * reaches the pages streaming from this process.
 *
 * Both HTTP roots call it, so a root cannot serve the audience routes
 * (`createApp` mounts the sync SSE router in every mode) and leave the tools
 * announcing to nobody. It is attached here rather than inside
 * `resolveServerDeps` because the di graph must not import the routes layer.
 *
 * The audience is the streams held by THIS instance, in memory. Behind
 * several instances (ADR-0020 adds no cross-instance channel, and none is
 * needed for correctness) an agent whose `/mcp` request lands elsewhere than
 * the browser's stream gets `delivered: false` and no highlight — advisory
 * feedback missing, never a lost write: the workspace tail carries the
 * record itself between instances. A stream is pinned to its instance for
 * the same reason (`sync-sse.ts` warns on a load balancer without sticky
 * sessions).
 */
export function attachLiveAudience(deps: ServerDeps): ServerDeps {
  return { ...deps, clientNotifier: createCanvasClientNotifier(deps.documentIndex) }
}
