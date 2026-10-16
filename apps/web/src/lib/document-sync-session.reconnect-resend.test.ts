/**
 * A transport that pushes directly — no worker retrying on its behalf — has
 * one recovery for writes lost while it was down: on reconnect the session
 * re-sends the whole document. That send landing is the moment the lost
 * writes land, so it has to settle a failure the way any other landed push
 * does. Otherwise a person who stops typing during an outage reads "Changes
 * not saved yet" for the rest of the session, over a document the keeper
 * holds in full.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import {
  flushMicrotasks,
  openTestSession,
  snapshotOf,
} from '../test-utils/document-sync-session.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
  edges: [],
}

afterEach(() => {
  vi.useRealTimers()
})

it('a failed write is settled by the full re-send a reconnect makes', async () => {
  vi.useFakeTimers()
  let daemonUp = true
  const { session, handlers, persistence } = openTestSession({
    push: () => (daemonUp ? Promise.resolve() : Promise.reject(new Error('daemon unreachable'))),
    snapshot: snapshotOf(canvas),
  })

  daemonUp = false
  handlers().onDisconnected?.()
  const edit: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
  session.onChange(applyCommand(canvas, edit), edit)
  await vi.advanceTimersByTimeAsync(300)
  await flushMicrotasks()
  expect(persistence).toEqual(['pending', 'degraded'])

  daemonUp = true
  handlers().onConnected()
  await flushMicrotasks()
  expect(persistence).toEqual(['pending', 'degraded', 'saved'])
  session.dispose()
})
