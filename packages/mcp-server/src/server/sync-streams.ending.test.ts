/**
 * Which open streams losing access ends (ADR-0042, ADR-0049 decision 4):
 * removal from one workspace ends the streams that follow THAT workspace,
 * while deactivation ends every stream the user holds.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  endSyncStreamsOf,
  registerSyncStream,
  resetSyncStreamsForTests,
  type SyncStream,
} from './sync-streams.js'

afterEach(() => resetSyncStreamsForTests())

/** A registered stream of `userId` subscribed to `keys`, recording whether it was ended. */
function streamOf(streamId: string, userId: string, keys: readonly string[]) {
  const state = { ended: false }
  const stream: SyncStream = {
    docs: new Map(keys.map((key) => [key, { ready: true, key }] as const)),
    send: () => {},
    userId,
    end: () => {
      state.ended = true
    },
  }
  registerSyncStream(streamId, stream)
  return state
}

describe('ending a user’s sync streams', () => {
  it('ends only the streams following the workspace they were removed from', () => {
    const whole = streamOf('s-whole', 'u-bob', ['workspace:ws-1'])
    const document = streamOf('s-doc', 'u-bob', ['ws-1/notes.md'])
    const both = streamOf('s-both', 'u-bob', ['workspace:ws-2', 'workspace:ws-1'])
    const elsewhere = streamOf('s-elsewhere', 'u-bob', ['workspace:ws-2', 'ws-2/a.md'])
    const someoneElse = streamOf('s-ada', 'u-ada', ['workspace:ws-1'])

    endSyncStreamsOf('u-bob', 'ws-1')

    expect([whole.ended, document.ended, both.ended]).toEqual([true, true, true])
    expect([elsewhere.ended, someoneElse.ended]).toEqual([false, false])
  })

  it('ends every stream the user holds when no workspace is named', () => {
    const one = streamOf('s-1', 'u-bob', ['workspace:ws-1'])
    const two = streamOf('s-2', 'u-bob', ['workspace:ws-2'])
    const idle = streamOf('s-idle', 'u-bob', [])
    const someoneElse = streamOf('s-ada', 'u-ada', ['workspace:ws-1'])

    endSyncStreamsOf('u-bob')

    expect([one.ended, two.ended, idle.ended, someoneElse.ended]).toEqual([true, true, true, false])
  })
})
