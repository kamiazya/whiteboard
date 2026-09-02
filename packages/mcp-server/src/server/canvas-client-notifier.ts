import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import type {
  AgentActivity,
  CanvasClientNotifier,
  RestoreProgressEvent,
  VersionCreated,
  ViewportRequest,
} from '@kamiazya/whiteboard-server-core'
import { nanoid } from 'nanoid'
import { DAEMON_PEER_ID } from './daemon-peer.js'
import { getLogger } from './log.js'
import {
  getReadyClientCount,
  sendAgentActivity,
  sendRestoreEvent,
  sendVersionCreated,
  sendViewportRequest,
} from './routes/ws.js'

const log = getLogger('canvas-client-notifier')

/**
 * Bridges server-core's `CanvasClientNotifier` port onto the daemon's
 * WebSocket routes.
 *
 * Two things it owns that server-core cannot:
 *
 * - **documentId -> path.** The WS routes are keyed by workspace and document
 *   PATH, which is placement, and placement lives in the index rather than
 *   in a tool's arguments.
 * - **Operator identity.** `kind: 'ai'` plus `DAEMON_PEER_ID`.
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
            operator: { kind: 'ai', peerId: DAEMON_PEER_ID },
            touched: {
              nodes: [...activity.touched.nodes],
              edges: [...activity.touched.edges],
            },
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
        // Only READY clients can apply a viewport, and `sendViewportRequest`
        // caches the last one for replay on `client_ready` — so a pre-ready
        // tab still gets it, and reporting `false` here would be a lie about
        // a message that will land. Report on ready clients, which is what
        // "someone is watching right now" means.
        if (getReadyClientCount(request.workspaceId, path) === 0) return false
        sendViewportRequest(request.workspaceId, path, nanoid(), {
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          ...(request.elementIds === undefined ? {} : { elementIds: [...request.elementIds] }),
          ...(request.animate === undefined ? {} : { animate: request.animate }),
          ...(request.scrollX === undefined ? {} : { scrollX: request.scrollX }),
          ...(request.scrollY === undefined ? {} : { scrollY: request.scrollY }),
          ...(request.zoom === undefined ? {} : { zoom: request.zoom }),
        })
        return true
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
