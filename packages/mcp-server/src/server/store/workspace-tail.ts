import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { WorkspaceDocCursor, WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import type { LoroDoc } from 'loro-crdt'
import { getLogger } from '../log.js'
import { parseWorkspaceTailMs } from './storage-env.js'

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
 * Off unless something arms it. `resolveWorkspaceTailIntervalMs` reads the
 * operator's setting and nothing else, so server mode leaves it to them; the
 * local daemon's entry points arm it themselves (`armLocalDaemonTail`),
 * because there the second writer is not an operator's second instance but the
 * stdio entry the agent runs beside it, over the same data directory — which
 * is the headline flow, not a deployment choice.
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
   *  uses, so a remote update reaches every connected client by one path
   *  rather than one per transport. */
  emit: (workspaceId: string, update: Uint8Array) => void
  intervalMs: number
}

export const WORKSPACE_TAIL_INTERVAL_ENV = 'WHITEBOARD_WORKSPACE_TAIL_MS'

/**
 * How often to follow, or `null` for "do not".
 *
 * Unset means OFF, not a default interval: this answers what the OPERATOR
 * said, and an embedded or hosted root with no second writer would pay for
 * polling it never needs. An operator running more than one instance against
 * one data directory turns it on, which is also the moment they can pick a
 * latency they are willing to pay for. The local daemon is the one root that
 * arms it for them.
 *
 * Parsing is strict — a bare non-negative base-10 integer — so a mistyped
 * value is OFF rather than an interval nobody intended. `0` is an explicit
 * off, spelled the same way `WHITEBOARD_FILE_GC_INTERVAL_MS` spells it.
 */
export function resolveWorkspaceTailIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  // One definition of the rule, in storage-env.ts, which startup also uses to
  // refuse a value it cannot understand. Falling back to OFF here is the safe
  // direction and is unreachable in a started server.
  const parsed = parseWorkspaceTailMs(env)
  return parsed.ok ? parsed.value : null
}

/**
 * How often the LOCAL daemon follows the record when its operator set nothing.
 *
 * Half a second is the latency a person watching an agent draw can read as
 * live (an edit reaches an open browser within it, 250ms on average), and what
 * it costs was measured rather than argued, in
 * `scripts/measure/workspace-follow-cost.mjs`: a pass over a workspace nothing
 * wrote to is one frontier read, 0.5ms for the usual single subscribed
 * workspace, 2-3ms for ten and 12-20ms for fifty — 0.1%, 0.5% and 2.4-4% of a core
 * at this interval. Only workspaces a browser is subscribed to are followed,
 * so a daemon with no page open pays nothing. A pass that catches an edit up
 * pays that workspace's import, which `LOOP_COSTS['workspace-tail']` bounds.
 */
export const LOCAL_DAEMON_TAIL_INTERVAL_MS = 500

/**
 * Arm the tail for the local daemon unless the operator already said
 * something, including `0` for off — a set value is never overwritten, and an
 * unparseable one is left for the startup check that refuses it.
 *
 * Written to the environment because the shared workers read the operator's
 * setting from there: it is the one seam both HTTP roots resolve it through,
 * and the config-file layer already feeds it the same way.
 */
export function armLocalDaemonTail(env: NodeJS.ProcessEnv = process.env): void {
  env[WORKSPACE_TAIL_INTERVAL_ENV] ??= String(LOCAL_DAEMON_TAIL_INTERVAL_MS)
}

/** "Where this document stands is not known" — `catchUp` re-reads the record. */
const COLD_CURSOR: WorkspaceDocCursor = { generation: null, afterSeq: null }

async function follow(
  options: WorkspaceTailOptions,
  cursors: Map<string, WorkspaceDocCursor>,
  workspaceId: string,
): Promise<void> {
  const cursor = cursors.get(workspaceId)
  const doc = await options.liveDoc(workspaceId)
  if (cursor === undefined) {
    // First sight. A client is sent the live document when it subscribes,
    // and that document can be OLDER than the record — loaded before another
    // instance wrote. Baselining at the record's cursor would skip that gap
    // for good, so the live document is reconciled from the record (a cold
    // cursor, which `catchUp` answers by re-reading it) and only what it
    // GAINED goes out: the client already holds the rest. One instance's own
    // cache is level with the record, so this sends nothing there.
    const before = doc.version()
    const reconciled = await options.docs.catchUp(workspaceId, doc, COLD_CURSOR)
    cursors.set(workspaceId, reconciled.cursor)
    if (doc.version().compare(before) !== 0) {
      options.emit(workspaceId, doc.export({ mode: 'update', from: before }))
    }
    return
  }
  const caughtUp = await options.docs.catchUp(workspaceId, doc, cursor)
  cursors.set(workspaceId, caughtUp.cursor)
  for (const update of caughtUp.updates) options.emit(workspaceId, update)
}

export function createWorkspaceTail(options: WorkspaceTailOptions): WorkspaceTail {
  // Where this instance has followed each workspace to. Absent means "not
  // baselined yet", which is a different thing from "at the start of the log"
  // and the reason this is a Map rather than a default cursor.
  const cursors = new Map<string, WorkspaceDocCursor>()
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let inFlight: Promise<void> | undefined

  async function pollOnce(): Promise<void> {
    const subscribed = [...options.subscribedWorkspaces()]
    // A workspace nobody is watching is forgotten, so its next subscription
    // baselines again rather than replaying everything written meanwhile.
    for (const known of [...cursors.keys()]) {
      if (!subscribed.includes(known)) cursors.delete(known)
    }
    for (const workspaceId of subscribed) {
      // One yield per workspace. `catchUp` imports the record's new updates
      // into the live document, which is a synchronous WASM call, and the
      // `await`s around it never reach the timer phase — so without this a
      // pass is one unbroken stall for as long as every subscribed workspace
      // takes together. Measured over 10 workspaces against a file-backed
      // libSQL store: 2927ms elapsed, 2927ms blocked, and the 5ms sampler
      // landed ZERO times, at 300 commits of history with a 50-commit gain.
      //
      // Yielding costs nothing here (a pass is a timer callback, not a
      // request) and caps what a request arriving mid-pass waits at one
      // workspace instead of all of them — 283ms on that fixture. That is
      // also the FLOOR: an import is a single call and cannot be subdivided,
      // so anything lower means batching what `catchUp` imports. Same
      // reasoning as file-gc.ts's collectReferencedFileIds, and the same
      // trap: the blocking is invisible in the source.
      await yieldToLoop()
      try {
        await follow(options, cursors, workspaceId)
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
