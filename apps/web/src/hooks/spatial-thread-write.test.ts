/**
 * A thread write on a SPATIAL document has to hand `onChange` the canvas the
 * command PRODUCES, not the one it was given.
 *
 * Both document pages built the four writes by hand and both passed the
 * unchanged canvas, so a status written from the rail reached storage and
 * never reached the picture: resolving left the bubble drawn until a
 * reload, and reopening did not bring it back at all — the canvas stayed on
 * whatever the last reducer-run command had left. Measured in a real
 * browser before this existed.
 *
 * The reducer is the only thing that knows a thread status projects onto a
 * flat comment's `resolved`, and that a new thread projects a pin. So the
 * door runs every command through it, in one place both pages call — the
 * duplication was what let the two drift into the same bug twice.
 */
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../lib/spatial/commands.js'
import { spatialThreadWrite } from './spatial-thread-write.js'

const THREAD: CommentThread = {
  id: 'thread-1',
  anchor: { kind: 'spatial', x: 600, y: 450 },
  status: 'open',
  messages: [{ id: 'm1', body: 'Does this hold?' }],
}

const OPEN: SpatialCanvas = {
  nodes: [],
  edges: [],
  'x-whiteboard': { comments: [{ id: 'thread-1', x: 600, y: 450, text: 'Does this hold?' }] },
}

function door(canvas: SpatialCanvas) {
  const onChange = vi.fn<(next: SpatialCanvas, command: EditorCommand) => void>()
  return { onChange, write: spatialThreadWrite(() => canvas, onChange) }
}

const commentsOf = (canvas: SpatialCanvas) => canvas['x-whiteboard']?.comments ?? []

describe('the spatial document’s thread write door', () => {
  it('resolves onto the canvas it hands back, so the bubble stops being drawn at once', () => {
    const { onChange, write } = door(OPEN)
    write.setThreadStatus('thread-1', 'resolved')
    const [next, command] = onChange.mock.calls[0] ?? []
    expect(command).toEqual({ kind: 'set-thread-status', threadId: 'thread-1', status: 'resolved' })
    expect(commentsOf(next as SpatialCanvas)[0]?.resolved).toBe(true)
  })

  it('reopens onto it too — the direction that left a live conversation invisible', () => {
    const resolved: SpatialCanvas = {
      ...OPEN,
      'x-whiteboard': { comments: [{ ...commentsOf(OPEN)[0], resolved: true }] },
    } as SpatialCanvas
    const { onChange, write } = door(resolved)
    write.setThreadStatus('thread-1', 'open')
    expect(commentsOf(onChange.mock.calls[0]?.[0] as SpatialCanvas)[0]?.resolved).toBe(false)
  })

  it('projects a new thread onto the canvas, so its pin appears without a reload', () => {
    const empty: SpatialCanvas = { nodes: [], edges: [] }
    const { onChange, write } = door(empty)
    write.createThread(THREAD)
    const next = onChange.mock.calls[0]?.[0] as SpatialCanvas
    expect(commentsOf(next).map((one) => one.id)).toEqual(['thread-1'])
  })

  it('reads the canvas at press time, never one captured when the door was built', () => {
    let current: SpatialCanvas = { nodes: [], edges: [] }
    const onChange = vi.fn<(next: SpatialCanvas, command: EditorCommand) => void>()
    const write = spatialThreadWrite(() => current, onChange)
    current = OPEN
    write.setThreadStatus('thread-1', 'resolved')
    expect(commentsOf(onChange.mock.calls[0]?.[0] as SpatialCanvas)[0]?.resolved).toBe(true)
  })

  it('carries a reply and an edit through as their own commands', () => {
    const { onChange, write } = door(OPEN)
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
    // The opening message is the flat comment's text, so an edit shows in
    // the picture as well as in the rail.
    expect(commentsOf(onChange.mock.calls[1]?.[0] as SpatialCanvas)[0]?.text).toBe('Rewritten.')
  })
})

/**
 * Both pages built these four by hand and both got them wrong the same way,
 * so the door being shared is the fix and this is what keeps it shared: a
 * page that constructs a thread command inline is back to having its own
 * copy of the rule that it goes through the reducer.
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
