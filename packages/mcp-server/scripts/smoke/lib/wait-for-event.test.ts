import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { waitForEventWithTimeout } from './wait-for-event.mjs'

describe('waitForEventWithTimeout', () => {
  it('resolves with the event payload when the event fires before the deadline', async () => {
    const emitter = new EventEmitter()
    const pending = waitForEventWithTimeout(emitter, 'message', 1000, 'timed out')

    emitter.emit('message', new Uint8Array([1, 2, 3]))

    await expect(pending).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects with the given message when the event never fires', async () => {
    const emitter = new EventEmitter()

    await expect(
      waitForEventWithTimeout(emitter, 'message', 20, 'daemon never sent it'),
    ).rejects.toThrow('daemon never sent it')
  })

  it('removes its listener once the deadline passes, so a late emit is a no-op', async () => {
    const emitter = new EventEmitter()

    await expect(waitForEventWithTimeout(emitter, 'message', 20, 'timed out')).rejects.toThrow()

    expect(emitter.listenerCount('message')).toBe(0)
  })
})
