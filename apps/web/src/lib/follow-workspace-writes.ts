import {
  type SseStreamSource,
  workspaceDocKey,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { listenToWorkspace } from './workspace-broadcast.js'

/**
 * One agent batch lands as several update frames in a row, and the daemon's
 * own writes echo back too. Reading the list once per burst, not once per
 * frame, is what keeps a busy agent from turning the index into a polling loop.
 */
const BURST_MS = 100

/** `onMoved` once a burst has gone quiet; `cancel` drops a call still waiting. */
function inBursts(onMoved: () => void): { soon: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    soon() {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        onMoved()
      }, BURST_MS)
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}

/**
 * Calls `onMoved` after the workspace record changes, wherever the change came
 * from — an agent over MCP, the CLI, another tab. The daemon pushes the
 * record's update frame to any stream following `workspace:<id>`, with no
 * document open, which is all a list that is not showing one document needs.
 *
 * A stream that dropped and came back also calls it: frames sent while it was
 * away are not replayed, so "nothing arrived" says nothing about the list.
 *
 * Answers the unsubscribe, which also cancels a call still waiting out the
 * burst.
 */
export function followWorkspaceWrites(
  source: SseStreamSource,
  workspaceId: string,
  onMoved: () => void,
): () => void {
  const { soon, cancel } = inBursts(onMoved)
  let everConnected = false
  let dropped = false
  const unsubscribe = source.subscribe(workspaceDocKey(workspaceId), {
    onUpdate: soon,
    onMessage: () => {},
    onConnectionChange(connected) {
      if (!connected) {
        dropped = everConnected
        return
      }
      if (dropped) soon()
      everConnected = true
      dropped = false
    },
  })
  return () => {
    cancel()
    unsubscribe()
  }
}

/**
 * The browser keeper's twin: calls `onMoved` after another end of this
 * workspace's channel — another tab, or a write this tab's index announced —
 * says the record changed. Any message counts, because every one of them is a
 * write the list may show: a saved edit moves a row's clock, an index write
 * moves a row. Answers the unsubscribe, which also cancels a pending call.
 */
export function followBrowserWorkspaceWrites(
  workspaceId: string,
  onMoved: () => void,
  listen: typeof listenToWorkspace = listenToWorkspace,
): () => void {
  const { soon, cancel } = inBursts(onMoved)
  const end = listen(workspaceId, soon)
  return () => {
    cancel()
    end.close()
  }
}
