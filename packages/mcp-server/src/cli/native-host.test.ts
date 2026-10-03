/**
 * The host's process-level guard: a rejection nothing awaited is logged and
 * survived, since the host serves every request the browser has in flight.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../server/log.js'
import { keepHostAliveOnUnhandledRejection } from './native-host.js'

let capture: ReturnType<typeof captureLogsForTests> | undefined
afterEach(() => capture?.restore())

describe('keepHostAliveOnUnhandledRejection', () => {
  it('logs an unhandled rejection with its error and stops listening once released', () => {
    capture = captureLogsForTests('error')
    const before = process.listenerCount('unhandledRejection')
    const release = keepHostAliveOnUnhandledRejection()
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1)

    process.emit('unhandledRejection', new Error('boom'), Promise.resolve())

    expect(capture.records).toEqual([
      expect.objectContaining({
        level: 'error',
        scope: 'native-host',
        msg: 'unhandled rejection in the native host',
      }),
    ])
    expect(JSON.stringify(capture.records[0])).toContain('boom')
    release()
    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })
})
