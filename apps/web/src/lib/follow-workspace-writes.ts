import {
  routingTransitions,
  type SseStreamSource,
  workspaceDocKey,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { readWorkspaceNodes } from '@kamiazya/whiteboard-loro-adapter'
import { listenToWorkspace } from './workspace-broadcast.js'

/**
 * One agent batch lands as several update frames in a row, and the daemon's
 * own writes echo back too. Reading the list once per burst, not once per
 * frame, is what keeps a busy agent from turning the index into a polling loop.
 * A document page's record takes the same frames as imports, so it follows
 * them on the same window.
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
 * The first routing calls it too: the list was read before the stream carried
 * the workspace, and a write in between reaches no frame. So does a stream
 * that dropped and came back: frames sent while it was away are not replayed,
 * so "nothing arrived" says nothing about the list.
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
  const unsubscribe = source.subscribe(workspaceDocKey(workspaceId), {
    onUpdate: soon,
    onMessage: () => {},
    onConnectionChange: routingTransitions({ first: soon, resumed: soon }),
  })
  return () => {
    cancel()
    unsubscribe()
  }
}

/**
 * The browser keeper's twin: calls `onMoved` after another end of this
 * workspace's channel — another tab, or a write this tab's index announced —
 * says the record changed. Any write counts, because every one of them is a
 * write the list may show: a saved edit moves a row's clock, an index write
 * moves a row.
 *
 * Except the workspace leaving this browser, which is `onRemoved`'s, at once:
 * a read under the removed id meets the registry's refusal, and a list has to
 * move somewhere else rather than re-read where it is. Answers the
 * unsubscribe, which also cancels a pending call.
 */
export function followBrowserWorkspaceWrites(
  workspaceId: string,
  { onMoved, onRemoved }: { onMoved: () => void; onRemoved: () => void },
  listen: typeof listenToWorkspace = listenToWorkspace,
): () => void {
  const { soon, cancel } = inBursts(onMoved)
  const end = listen(workspaceId, (message) => {
    if (message.type !== 'workspace-removed') return soon()
    cancel()
    onRemoved()
  })
  return () => {
    cancel()
    end.close()
  }
}

/** The workspace record, named through the adapter so pages never import the CRDT. */
export type WorkspaceRecord = Parameters<typeof readWorkspaceNodes>[0]

/** What a list shows of each document the record holds, as one comparable value. */
function listedShapeOf(record: WorkspaceRecord): string {
  const rows = readWorkspaceNodes(record).flatMap((node) =>
    node.type === 'document'
      ? [[node.meta.documentId, node.path, node.meta.kind, node.meta.name, node.meta.updatedAt]]
      : [],
  )
  return JSON.stringify(rows)
}

/**
 * The twin for a page that already syncs the workspace record itself: calls
 * `onMoved` after an import changes what a list SHOWS of it — a document
 * created, renamed, moved, deleted or edited elsewhere — and not for one that
 * changes only content. Compared once a burst has gone quiet, so a burst
 * costs one walk and at most one read.
 *
 * `seen` is the shape a previous record last showed, so a record that
 * replaced it (a reconnect's snapshot) is compared against it rather than
 * taken as the baseline; `null` means none was seen, and the first look then
 * calls `onMoved` too, since the list was read before the record was bound
 * and a document gained in between would otherwise never be listed.
 *
 * Answers the shape seen last, for the record that replaces this one, and
 * the unsubscribe, which also cancels a compare still waiting out the burst.
 */
export function followRecordWrites(
  record: WorkspaceRecord,
  seen: string | null,
  onMoved: () => void,
): { readonly seen: () => string | null; readonly stop: () => void } {
  let last = seen
  const compare = () => {
    const shape = listedShapeOf(record)
    const moved = shape !== last
    last = shape
    if (moved) onMoved()
  }
  const { soon, cancel } = inBursts(compare)
  if (last === null) compare()
  else soon()
  const unsubscribe = record.subscribe((event) => {
    if (event.by === 'import') soon()
  })
  return {
    seen: () => last,
    stop() {
      cancel()
      unsubscribe()
    },
  }
}
