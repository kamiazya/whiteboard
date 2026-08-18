import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import type {
  AgentActivity,
  CanvasClientNotifier,
  ViewportRequest,
} from '@kamiazya/whiteboard-server-core'
import { nanoid } from 'nanoid'
import { getLogger } from './log.js'
import { getReadyClientCount, sendAgentActivity, sendViewportRequest } from './routes/ws.js'

const log = getLogger('canvas-client-notifier')

/**
 * The daemon's identity as an editing peer, minted once per process.
 *
 * server-core deliberately does not supply this — it has no idea who the
 * daemon's peer is, and inventing one there would put a second source of
 * truth beside `operatorInfoSchema`. Stable for the daemon's lifetime so a
 * browser can tell "the same agent again" from "a second agent".
 */
const DAEMON_PEER_ID = `daemon-${nanoid(10)}`

/**
 * Bridges server-core's `CanvasClientNotifier` port onto the daemon's
 * WebSocket routes.
 *
 * Two things it owns that server-core cannot:
 *
 * - **documentId -> path.** The WS routes are keyed by workspace and document
 *   PATH, which is placement, and placement lives in the index rather than
 *   in a tool's arguments.
 * - **Operator identity.** `kind: 'ai'` plus the peer id above.
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
