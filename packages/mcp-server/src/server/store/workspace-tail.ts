import type { WorkspaceDocCursor, WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import type { LoroDoc } from 'loro-crdt'
import { getLogger } from '../log.js'

const log = getLogger('workspace-tail')

/**
 * Follows the stored record for every workspace that has an audience, so a
 * client attached to THIS instance learns what ANOTHER instance wrote.
 *
 * `onWorkspaceDocUpdated` is the funnel every local write already goes
 * through, and it sees only local writes — the listeners are a module-level
 * Set in one process. That is exactly right for one daemon and answers
 * nothing for two: a browser connected to instance A watches instance B's
 * edits vanish into storage and never arrive. This is the piece that puts
 * them back on the wire, by catching the live document up and pushing what
 * it gained through the same funnel.
 *
 * POLLING, deliberately. ADR-0020 puts the data plane outside coordination,
 * so propagation may be late without being wrong — a subscriber that misses a
 * round converges on the next one. A push channel (Redis, LISTEN/NOTIFY)
 * lowers the latency and nothing else, so it is worth adding when the latency
 * is measured to matter rather than before.
 *
 * Off unless an operator turns it on. One daemon needs none of this, and
 * polling the database for every subscribed workspace on a fixed interval is
 * pure waste there — the same empty-by-default shape the hosted-origin
 * allowlist uses.
 */
export interface WorkspaceTail {
  /** One pass over every subscribed workspace. The unit under test; `start`
   *  is a timer around it. */
  pollOnce(): Promise<void>
  start(): void
  stop(): Promise<void>
}

export interface WorkspaceTailOptions {
  /** The workspaces with an audience right now. Read on every pass rather
   *  than captured, so a workspace that gains or loses its last client is
   *  picked up without this module knowing what a client is. */
  subscribedWorkspaces: () => Iterable<string>
  docs: WorkspaceDocs
  /** The document the fan-out's audience is reading, which is what has to be
   *  brought up to date — not a fresh copy nobody holds. */
  liveDoc: (workspaceId: string) => Promise<LoroDoc>
  /** Where a caught-up update goes. Wired to the same funnel a local write
   *  uses, so a remote update reaches websockets and SSE by one path rather
   *  than two. */
  emit: (workspaceId: string, update: Uint8Array) => void
  intervalMs: number
}

export const WORKSPACE_TAIL_INTERVAL_ENV = 'WHITEBOARD_WORKSPACE_TAIL_MS'

/**
 * How often to follow, or `null` for "do not".
 *
 * Unset means OFF, not a default interval. One daemon is the ordinary
 * deployment and needs none of this; polling the database for every
 * subscribed workspace on a timer would be pure cost there. An operator
 * running more than one instance against one data directory turns it on,
 * which is also the moment they can pick a latency they are willing to pay
 * for.
 *
 * Parsing is strict — a bare non-negative base-10 integer — so a mistyped
 * value is OFF rather than an interval nobody intended. `0` is an explicit
 * off, spelled the same way `WHITEBOARD_FILE_GC_INTERVAL_MS` spells it.
 */
export function resolveWorkspaceTailIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[WORKSPACE_TAIL_INTERVAL_ENV]?.trim()
  if (raw === undefined || raw === '') return null
  if (!/^[0-9]+$/.test(raw)) return null
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

export function createWorkspaceTail(options: WorkspaceTailOptions): WorkspaceTail {
  // Where this instance has followed each workspace to. Absent means "not
  // baselined yet", which is a different thing from "at the start of the log"
  // and the reason this is a Map rather than a default cursor.
  const cursors = new Map<string, WorkspaceDocCursor>()
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let inFlight: Promise<void> | undefined

  async function follow(workspaceId: string): Promise<void> {
    const cursor = cursors.get(workspaceId)
    if (cursor === undefined) {
      // First sight. Every socket is sent the workspace snapshot when it
      // connects, so the record as it stands has already been delivered;
      // emitting the log here would re-send all of it.
      cursors.set(workspaceId, await options.docs.readCursor(workspaceId))
      return
    }
    const doc = await options.liveDoc(workspaceId)
    const caughtUp = await options.docs.catchUp(workspaceId, doc, cursor)
    cursors.set(workspaceId, caughtUp.cursor)
    for (const update of caughtUp.updates) options.emit(workspaceId, update)
  }

  async function pollOnce(): Promise<void> {
    const subscribed = [...options.subscribedWorkspaces()]
    // A workspace nobody is watching is forgotten, so its next subscription
    // baselines again rather than replaying everything written meanwhile.
    for (const known of [...cursors.keys()]) {
      if (!subscribed.includes(known)) cursors.delete(known)
    }
    for (const workspaceId of subscribed) {
      try {
        await follow(workspaceId)
      } catch (err) {
        // One unreachable workspace must not stop the others: they are
        // independent records and a failure here is transient by nature
        // (a fold mid-read, a busy database). The next pass retries.
        log.warning({ workspaceId, err }, 'workspace tail pass failed')
      }
    }
  }

  return {
    pollOnce,
    start() {
      if (timer !== undefined || stopped) return
      const schedule = (): void => {
        // A completion-rescheduled one-shot, unref'd — never setInterval.
        // Passes must not overlap (two catch-ups on one live doc would race
        // the cursor), and an interval timer would also hold the event loop
        // open for the process lifetime even with nothing subscribed.
        timer = setTimeout(() => {
          inFlight = pollOnce().finally(() => {
            inFlight = undefined
            if (!stopped) schedule()
          })
        }, options.intervalMs)
        timer.unref?.()
      }
      schedule()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // Wait out a pass already running, so a caller tearing the daemon down
      // does not race a catch-up that is mid-import.
      await inFlight
    },
  }
}
