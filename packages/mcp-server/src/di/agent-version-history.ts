import type { VersionHistory } from '@kamiazya/whiteboard-server-core'
import type { VersionStore } from '../server/store/version-store.js'

/**
 * The daemon's version store as the `VersionHistory` seam, with one thing
 * added: a save that names no operator is recorded as this daemon acting as
 * an agent. Every caller of the seam is an operation or a tool — the HTTP
 * route, where a person saves, writes to the store directly and names the
 * person — so "unnamed" here always means "the agent", and stamping it in
 * the composition root keeps server-core from having to know who the
 * daemon is.
 *
 * `daemonActor` is the DEVICE, not the process (ADR-0035 decision 2): a row
 * this daemon saved before a restart and one it saved after must name the
 * same agent, which is what `daemonDeviceActor` answers and what the
 * per-process `DAEMON_AGENT_ACTOR` — correct for the live socket — cannot.
 */
export function agentVersionHistory(store: VersionStore, daemonActor?: string): VersionHistory {
  return {
    save: (workspaceId, path, doc, options) =>
      store.save(workspaceId, path, doc, {
        ...options,
        operator: options.operator ?? {
          kind: 'ai',
          // Absent when the composition named no device. The row then says
          // an agent saved it and declines to say which daemon, which is
          // true; a stand-in here would be a value nobody could resolve.
          ...(daemonActor === undefined ? {} : { actor: daemonActor }),
        },
      }),
    load: (workspaceId, id) => store.load(workspaceId, id),
    loadWorkspaceAt: (workspaceId, id) => store.loadWorkspaceAt(workspaceId, id),
    list: (workspaceId, path) => store.list(workspaceId, path),
  }
}
