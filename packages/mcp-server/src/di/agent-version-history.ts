import type { VersionHistory } from '@kamiazya/whiteboard-server-core'
import { DAEMON_PEER_ID } from '../server/daemon-peer.js'
import type { VersionStore } from '../server/store/version-store.js'

/**
 * The daemon's version store as the `VersionHistory` seam, with one thing
 * added: a save that names no operator is recorded as this daemon acting as
 * an agent. Every caller of the seam is an operation or a tool — the HTTP
 * route, where a person saves, writes to the store directly and names the
 * person — so "unnamed" here always means "the agent", and stamping it in
 * the composition root keeps server-core from having to know who the
 * daemon's peer is.
 */
export function agentVersionHistory(store: VersionStore): VersionHistory {
  return {
    save: (workspaceId, path, doc, options) =>
      store.save(workspaceId, path, doc, {
        ...options,
        operator: options.operator ?? { kind: 'ai', peerId: DAEMON_PEER_ID },
      }),
    load: (workspaceId, id) => store.load(workspaceId, id),
    loadWorkspaceAt: (workspaceId, id) => store.loadWorkspaceAt(workspaceId, id),
    list: (workspaceId, path) => store.list(workspaceId, path),
  }
}
