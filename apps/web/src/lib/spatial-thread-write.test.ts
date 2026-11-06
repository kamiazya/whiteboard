/**
 * A thread write on a SPATIAL document goes through the same `onChange` a
 * canvas edit does, with the canvas the command PRODUCES and the command
 * itself — which is where the sync session publishes the conversations the
 * command leaves (`threadsAfterCommand`), so a status written from the rail
 * reaches the picture at once rather than after a reload.
 *
 * Both document pages built the four writes by hand once and both passed the
 * unchanged canvas: resolving left the bubble drawn until a reload. The door
 * is one place both pages call — the duplication was what let the two drift
 * into the same bug twice.
 */
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from './spatial/commands.js'
import { threadsAfterCommand } from './spatial/thread-commands.js'
import { spatialThreadWrite } from './spatial-thread-write.js'

const THREAD: CommentThread = {
  id: 'thread-1',
  anchor: { kind: 'spatial', x: 600, y: 450 },
  status: 'open',
  messages: [{ id: 'm1', body: 'Does this hold?' }],
}

const BOARD: SpatialCanvas = { nodes: [], edges: [] }

function door(canvas: SpatialCanvas) {
  const onChange = vi.fn<(next: SpatialCanvas, command: EditorCommand) => void>()
  return { onChange, write: spatialThreadWrite(() => canvas, onChange) }
}

describe('the spatial document’s thread write door', () => {
  it('hands on a status command the conversations follow, so the bubble stops being drawn', () => {
    const { onChange, write } = door(BOARD)
    write.setThreadStatus('thread-1', 'resolved')
    const [next, command] = onChange.mock.calls[0] ?? []
    expect(next).toBe(BOARD)
    expect(command).toEqual({ kind: 'set-thread-status', threadId: 'thread-1', status: 'resolved' })
    expect(threadsAfterCommand([THREAD], command as EditorCommand)[0]?.status).toBe('resolved')
  })

  it('hands on a new thread, so its pin appears without a reload', () => {
    const { onChange, write } = door(BOARD)
    write.createThread(THREAD)
    const command = onChange.mock.calls[0]?.[1] as EditorCommand
    expect(threadsAfterCommand([], command).map((one) => one.id)).toEqual(['thread-1'])
  })

  it('reads the canvas at press time, never one captured when the door was built', () => {
    let current: SpatialCanvas = { nodes: [], edges: [] }
    const onChange = vi.fn<(next: SpatialCanvas, command: EditorCommand) => void>()
    const write = spatialThreadWrite(() => current, onChange)
    current = { nodes: [], edges: [], tags: ['now'] }
    write.setThreadStatus('thread-1', 'resolved')
    expect(onChange.mock.calls[0]?.[0]).toBe(current)
  })

  it('carries a reply and an edit through as their own commands', () => {
    const { onChange, write } = door(BOARD)
    const message = { id: 'm2', body: 'Still true.' }
    write.replyToThread('thread-1', message)
    write.editMessage('thread-1', { id: 'm1', body: 'Rewritten.' }, true)
    expect(onChange.mock.calls.map(([, command]) => command)).toEqual([
      { kind: 'reply-to-thread', threadId: 'thread-1', message },
      {
        kind: 'edit-thread-message',
        threadId: 'thread-1',
        message: { id: 'm1', body: 'Rewritten.' },
        opening: true,
      },
    ])
  })
})

/**
 * Both pages built these four by hand and both got them wrong the same way,
 * so the door being shared is the fix and this is what keeps it shared: a
 * page that constructs a thread command inline is back to having its own
 * copy of the rule that it goes through the editor's own `onChange`.
 *
 * `?raw`, never `node:fs` — apps/web is browser-only and
 * `web-app-boundary.test.ts` enforces it.
 */
const pageSources = import.meta.glob('../pages/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const THREAD_COMMAND_KINDS = [
  'create-thread',
  'reply-to-thread',
  'set-thread-status',
  'edit-thread-message',
] as const

describe('the door is the only place a page builds one', () => {
  it('scans a real population of pages, so an empty result is not an empty glob', () => {
    expect(Object.keys(pageSources).length).toBeGreaterThan(3)
  })

  it('finds no page constructing a thread command of its own', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(pageSources)) {
      for (const kind of THREAD_COMMAND_KINDS) {
        if (source.includes(`kind: '${kind}'`)) offenders.push(`${path}: ${kind}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
