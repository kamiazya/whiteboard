// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseSseEvent } from './sse-frames.js'

describe('parseSseEvent', () => {
  it('reads the event name and joins every data line', () => {
    expect(parseSseEvent('event: update\ndata: one\ndata: two')).toEqual({
      event: 'update',
      data: 'one\ntwo',
    })
  })

  it('defaults the event name to message', () => {
    expect(parseSseEvent('data: hi')).toEqual({ event: 'message', data: 'hi' })
  })

  it('answers nothing for a frame with no data line', () => {
    // A comment and a bare keep-alive: something arrived, and there is
    // nothing to deliver. An empty event is not an event.
    expect(parseSseEvent(': keep-alive')).toBeNull()
    expect(parseSseEvent('event: ready')).toBeNull()
    expect(parseSseEvent('')).toBeNull()
  })
})
