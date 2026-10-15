import { describe, expect, it } from 'vitest'
import { judgeLockHolder, sameLockFile, UNWRITTEN_LOCK_GRACE_MS } from './stale-lock.js'

const WRITTEN_AT = Date.parse('2026-01-01T00:00:10.000Z')
const HERE = 'this-host'
const seams = (startMs: number | null, alive = true) => ({
  host: HERE,
  isAlive: () => alive,
  startMs: () => startMs,
})

describe('judgeLockHolder', () => {
  it('waits on an unwritten lock within the grace, and calls it gone after', () => {
    const at = (nowMs: number) => judgeLockHolder('unwritten', WRITTEN_AT, { nowMs }).kind
    expect(at(WRITTEN_AT + UNWRITTEN_LOCK_GRACE_MS - 1)).toBe('held')
    expect(at(WRITTEN_AT + UNWRITTEN_LOCK_GRACE_MS + 1)).toBe('gone')
  })

  it('calls a lock naming no usable pid gone', () => {
    expect(judgeLockHolder({ pid: null }, WRITTEN_AT, seams(null)).kind).toBe('gone')
    expect(judgeLockHolder({ pid: -3 }, WRITTEN_AT, seams(null)).kind).toBe('gone')
  })

  it('calls a dead holder gone', () => {
    expect(judgeLockHolder({ pid: 7 }, WRITTEN_AT, seams(null, false))).toMatchObject({
      kind: 'gone',
      reason: 'holder exited',
    })
  })

  it('calls a live pid that started after the lock was written a reuse', () => {
    expect(judgeLockHolder({ pid: 7 }, WRITTEN_AT, seams(WRITTEN_AT + 60_000))).toMatchObject({
      kind: 'gone',
      reason: 'holder pid reused by a later process',
    })
  })

  it('keeps a live holder that started before it wrote the lock, or whose start is unknown', () => {
    expect(judgeLockHolder({ pid: 7 }, WRITTEN_AT, seams(WRITTEN_AT - 1_000)).kind).toBe('held')
    expect(judgeLockHolder({ pid: 7 }, WRITTEN_AT, seams(null)).kind).toBe('held')
  })

  // Another container's pid is in another namespace: dead or reused here
  // says nothing about it.
  it('never judges a holder on another host by its pid', () => {
    for (const s of [seams(null, false), seams(WRITTEN_AT + 60_000)]) {
      expect(judgeLockHolder({ pid: 1, host: 'elsewhere' }, WRITTEN_AT, s)).toEqual({
        kind: 'held',
        holderPid: 1,
        host: 'elsewhere',
      })
    }
    expect(judgeLockHolder({ pid: 1, host: HERE }, WRITTEN_AT, seams(null, false)).kind).toBe(
      'gone',
    )
  })
})

describe('sameLockFile', () => {
  const judged = { dev: 1, ino: 2, mtimeMs: 3 }
  it('tells a successor on the reused inode by its mtime', () => {
    expect(sameLockFile({ ...judged }, judged)).toBe(true)
    expect(sameLockFile({ ...judged, mtimeMs: 4 }, judged)).toBe(false)
    expect(sameLockFile({ ...judged, ino: 5 }, judged)).toBe(false)
  })
})
