/**
 * How a debounce window of canvas commands is written and how it undoes: one
 * update per DISTINCT target the window touched, announced once each, but one
 * undo step per window — the steps are cut by the session's wall-clock merge
 * window, never by the number of targets. A change to how a window is
 * committed (one batch for all targets, one write per target) has to keep the
 * undo steps, and says so if it changes the update counts.
 *
 * Fake timers drive the merge window as well as the debounce: Loro reads the
 * clock through `Date.now`.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushMicrotasks,
  openTestSession,
  snapshotOf,
} from '../test-utils/document-sync-session.js'
import { COMMIT_DEBOUNCE_MS } from './document-sync-session.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'

const BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'n-b', x: 200, y: 0, width: 100, height: 50, text: 'b' }),
  ],
  edges: [],
}

const move = (id: string, x: number, y: number): EditorCommand => ({
  kind: 'move-node',
  id,
  x,
  y,
})
const create = (id: string, x: number): EditorCommand => ({
  kind: 'create-node',
  node: textNode({ id, x, y: 100, width: 100, height: 50, text: id }),
})

const place = (canvas: SpatialCanvas) =>
  canvas.nodes.map((node) => `${node.id}@${node.x},${node.y}`).sort()

function openedSession() {
  const pushed: Uint8Array[] = []
  const events: string[] = []
  const s = openTestSession({
    snapshot: snapshotOf(BOARD),
    push: (update) => {
      pushed.push(update)
      return Promise.resolve()
    },
    deps: { dispatchIdentityEvent: (name) => events.push(name) },
  })
  let held = BOARD
  /** Makes `commands` one after another, then lets the window close. Returns the updates and events it caused. */
  async function window(commands: readonly EditorCommand[], afterMs: number) {
    await vi.advanceTimersByTimeAsync(afterMs)
    const pushesBefore = pushed.length
    const eventsBefore = events.length
    for (const command of commands) {
      held = applyCommand(held, command)
      s.session.onChange(held, command)
    }
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
    await flushMicrotasks()
    return { updates: pushed.length - pushesBefore, events: events.length - eventsBefore }
  }
  return { session: s.session, window }
}

describe('a window of canvas commands', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes one update and announces once per distinct target, whatever the command count', async () => {
    const s = openedSession()

    const { updates, events } = await s.window(
      [create('n-x', 0), create('n-y', 300), move('n-x', 50, 150)],
      0,
    )

    // n-x's create and move share a target and collapse; n-y is the second.
    expect(updates).toBe(2)
    expect(events).toBe(2)
    expect(place(s.session.getCanvas())).toEqual([
      'n-a@0,0',
      'n-b@200,0',
      'n-x@50,150',
      'n-y@300,100',
    ])
  })

  it('writes one update per moved node when a window moves two nodes, one of them twice', async () => {
    const s = openedSession()

    const { updates, events } = await s.window(
      [move('n-a', 10, 20), move('n-b', 30, 40), move('n-a', 5, 5)],
      0,
    )

    expect(updates).toBe(2)
    expect(events).toBe(2)
  })

  it('writes one update for several commands on the same target', async () => {
    const s = openedSession()

    const { updates, events } = await s.window([move('n-a', 10, 20), move('n-a', 30, 40)], 0)

    expect(updates).toBe(1)
    expect(events).toBe(1)
    expect(place(s.session.getCanvas())).toEqual(['n-a@30,40', 'n-b@200,0'])
  })

  it('undoes a window that touched several targets in one step', async () => {
    const s = openedSession()
    await s.window([move('n-a', 10, 20), move('n-b', 30, 40), move('n-a', 5, 5)], 0)
    expect(place(s.session.getCanvas())).toEqual(['n-a@5,5', 'n-b@30,40'])

    expect(s.session.undo()).toBe(true)

    expect(place(s.session.getCanvas())).toEqual(place(BOARD))
    expect(s.session.canUndo()).toBe(false)
    expect(s.session.canRedo()).toBe(true)
  })

  it('undoes a window of creates and a move on the first target in one step', async () => {
    const s = openedSession()
    await s.window([create('n-x', 0), create('n-y', 300), move('n-x', 50, 150)], 0)

    expect(s.session.undo()).toBe(true)

    expect(place(s.session.getCanvas())).toEqual(place(BOARD))
    expect(s.session.canUndo()).toBe(false)
  })

  it('undoes a second window past the merge interval separately, each step restoring its whole window', async () => {
    const s = openedSession()
    await s.window([create('n-x', 0), create('n-y', 300), move('n-x', 50, 150)], 0)
    await s.window([move('n-b', 9, 9)], 600)

    expect(s.session.undo()).toBe(true)
    expect(place(s.session.getCanvas())).toEqual([
      'n-a@0,0',
      'n-b@200,0',
      'n-x@50,150',
      'n-y@300,100',
    ])
    expect(s.session.canUndo()).toBe(true)

    expect(s.session.undo()).toBe(true)
    expect(place(s.session.getCanvas())).toEqual(place(BOARD))
    expect(s.session.canUndo()).toBe(false)
  })

  it('undoes a second window inside the merge interval together with the first', async () => {
    const s = openedSession()
    await s.window([create('n-x', 0), create('n-y', 300), move('n-x', 50, 150)], 0)
    await s.window([move('n-b', 9, 9)], 100)

    expect(s.session.undo()).toBe(true)

    expect(place(s.session.getCanvas())).toEqual(place(BOARD))
    expect(s.session.canUndo()).toBe(false)
  })
})
