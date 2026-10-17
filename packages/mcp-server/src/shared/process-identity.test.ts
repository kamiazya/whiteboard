import { describe, expect, it } from 'vitest'
import { recordedProcess } from './process-identity.js'

const alive = { isAlive: () => true }

describe('recordedProcess', () => {
  // Calling a live writer foreign is the unsafe direction: a stop would drop
  // its record and a lock would be reclaimed under its holder.
  it('reads a written time that cannot be parsed as the writer', () => {
    const startedLater = { ...alive, startMs: () => Date.now() }
    expect(recordedProcess(4242, Number.NaN, startedLater)).toBe('writer')
    expect(recordedProcess(4242, Date.parse('not a date'), startedLater)).toBe('writer')
  })

  it('reads a process that started after its record as foreign', () => {
    expect(recordedProcess(4242, 0, { ...alive, startMs: () => 60_000 })).toBe('foreign')
  })

  // Windows and macOS have no /proc: a live pid there says nothing about who
  // holds it, and a caller about to hand over a token must be able to tell.
  it('reads a live pid whose start time cannot be read as unknown, never the writer', () => {
    const noStartTime = { ...alive, startMs: () => null }
    expect(recordedProcess(4242, Date.now(), noStartTime)).toBe('unknown')
    expect(recordedProcess(4242, Number.NaN, noStartTime)).toBe('unknown')
  })
})
