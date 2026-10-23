/**
 * Typing that never pauses long enough for the quiet-period debounce to fire
 * still has to be written. A write that waits for a pause the person does not
 * take leaves every keystroke of a long burst unsaved — which the shell then
 * judges stuck (`STUCK_AFTER_MS`) while nothing is actually failing.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushMicrotasks,
  openTestSession,
  snapshotOf,
} from '../test-utils/document-sync-session.js'
import { COMMIT_DEBOUNCE_MS, COMMIT_MAX_WAIT_MS } from './document-sync-session.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'
import { STUCK_AFTER_MS, storageHealthOf } from './storage-health.js'

const A = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' })
const canvas: SpatialCanvas = { nodes: [A], edges: [] }

afterEach(() => {
  vi.useRealTimers()
})

/** Edits arrive faster than the debounce, so the quiet period never comes. */
const KEYSTROKE_GAP_MS = COMMIT_DEBOUNCE_MS / 3

describe('a burst of edits with no pause', () => {
  it('is written within the max wait, not only after the burst ends', async () => {
    vi.useFakeTimers()
    const pushes: Uint8Array[] = []
    const { session } = openTestSession({
      snapshot: snapshotOf(canvas),
      push: (bytes) => {
        pushes.push(bytes)
        return Promise.resolve()
      },
    })

    let current = session.getCanvas()
    for (
      let elapsed = 0;
      elapsed < COMMIT_MAX_WAIT_MS + COMMIT_DEBOUNCE_MS;
      elapsed += KEYSTROKE_GAP_MS
    ) {
      const move: EditorCommand = { kind: 'move-node', id: 'a', x: elapsed, y: 0 }
      current = applyCommand(current, move)
      session.onChange(current, move)
      await vi.advanceTimersByTimeAsync(KEYSTROKE_GAP_MS)
    }
    await flushMicrotasks()

    expect(pushes.length).toBeGreaterThan(0)
    session.dispose()
  })

  it('is never judged stuck while its writes keep landing', async () => {
    vi.useFakeTimers()
    const { session, persistenceStates } = openTestSession({ snapshot: snapshotOf(canvas) })

    let current = session.getCanvas()
    let unsavedSince: number | null = null
    const burstMs = STUCK_AFTER_MS * 2
    const verdicts = new Set<string>()
    for (let elapsed = 0; elapsed < burstMs; elapsed += KEYSTROKE_GAP_MS) {
      const move: EditorCommand = { kind: 'move-node', id: 'a', x: elapsed, y: 0 }
      current = applyCommand(current, move)
      session.onChange(current, move)
      await vi.advanceTimersByTimeAsync(KEYSTROKE_GAP_MS)
      await flushMicrotasks()
      const state = persistenceStates.at(-1)
      if (state === undefined) continue
      if (state.kind === 'saved') unsavedSince = null
      else unsavedSince ??= Date.now()
      verdicts.add(storageHealthOf(state, unsavedSince, Date.now()))
    }

    expect([...verdicts]).toEqual(['ok'])
    session.dispose()
  })
})
