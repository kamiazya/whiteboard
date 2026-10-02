import {
  type SseStreamSource,
  workspaceDocKey,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'

/**
 * One agent batch lands as several update frames in a row, and the daemon's
 * own writes echo back too. Reading the list once per burst, not once per
 * frame, is what keeps a busy agent from turning the index into a polling loop.
 */
const BURST_MS = 100

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
  let timer: ReturnType<typeof setTimeout> | null = null
  const soon = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onMoved()
    }, BURST_MS)
  }
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
    if (timer !== null) clearTimeout(timer)
    unsubscribe()
  }
}
