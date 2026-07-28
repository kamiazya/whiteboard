import { afterEach, describe, expect, test } from 'vitest'
import { getLogger, setLogSink } from './log.js'

const LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const

afterEach(() => {
  // `sink` is module-level state shared by every test file that imports
  // log.ts in the same worker; always restore the no-op default so a
  // sink installed here never leaks into another file's assertions.
  setLogSink(() => {})
})

describe('getLogger', () => {
  test('drops records silently when no sink has been installed', () => {
    const log = getLogger('some-scope')

    expect(() => log.warning('nobody is listening')).not.toThrow()
  })

  test.each(
    LOG_LEVELS,
  )('forwards a %s-level call to the installed sink with the right shape', (level) => {
    const records: unknown[] = []
    setLogSink((record) => records.push(record))
    const log = getLogger('my-scope')

    log[level]('something happened', { foo: 'bar' })

    expect(records).toEqual([
      { scope: 'my-scope', level, msg: 'something happened', data: { foo: 'bar' } },
    ])
  })

  test('omits `data` when the call site provides no structured payload', () => {
    const records: unknown[] = []
    setLogSink((record) => records.push(record))
    const log = getLogger('my-scope')

    log.info('no payload here')

    expect(records).toEqual([{ scope: 'my-scope', level: 'info', msg: 'no payload here' }])
  })

  test('tags records from different scopes with their own scope, sharing the one installed sink', () => {
    const records: unknown[] = []
    setLogSink((record) => records.push(record))
    const logA = getLogger('scope-a')
    const logB = getLogger('scope-b')

    logA.debug('from a')
    logB.debug('from b')

    expect(records).toEqual([
      { scope: 'scope-a', level: 'debug', msg: 'from a' },
      { scope: 'scope-b', level: 'debug', msg: 'from b' },
    ])
  })
})
