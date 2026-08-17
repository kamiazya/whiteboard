// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchMergeCommitted,
  MERGE_COMMITTED_EVENT,
  type MergeCommittedDetail,
  mergeCommittedDetailSchema,
  parseMergeCommittedEvent,
} from './merge-committed-event.js'

const validDetail: MergeCommittedDetail = {
  workspaceId: 'w1',
  path: 'c1',
  sourceName: 'feature',
  targetName: 'main',
  newCount: 2,
  changedCount: 1,
  conflictCount: 0,
  preMergeVersionId: 'v-pre',
  newElementIds: ['a', 'b'],
  conflictElementIds: [],
  switchedHead: { from: 'feature', to: 'main' },
  deletedSource: 'feature',
}

describe('mergeCommittedDetailSchema', () => {
  it('accepts the exact shape MergeDialog dispatches', () => {
    expect(mergeCommittedDetailSchema.safeParse(validDetail).success).toBe(true)
  })

  it('accepts optional fields being absent', () => {
    const { preMergeVersionId, switchedHead, deletedSource, ...rest } = validDetail
    expect(mergeCommittedDetailSchema.safeParse(rest).success).toBe(true)
  })

  it('strips unknown extra fields instead of rejecting', () => {
    const result = mergeCommittedDetailSchema.safeParse({ ...validDetail, extra: 'ignored' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('extra')
    }
  })

  it('rejects malformed details: newCount as string', () => {
    expect(mergeCommittedDetailSchema.safeParse({ ...validDetail, newCount: '2' }).success).toBe(
      false,
    )
  })

  it('rejects malformed details: missing workspaceId', () => {
    const { workspaceId, ...rest } = validDetail
    expect(mergeCommittedDetailSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects malformed details: newElementIds containing non-strings', () => {
    expect(
      mergeCommittedDetailSchema.safeParse({ ...validDetail, newElementIds: [1, 2] }).success,
    ).toBe(false)
  })
})

describe('parseMergeCommittedEvent', () => {
  beforeEach(() => {
    vi.stubGlobal('import.meta', { env: { DEV: true } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns the parsed detail for a valid event', () => {
    const event = new CustomEvent(MERGE_COMMITTED_EVENT, { detail: validDetail })
    expect(parseMergeCommittedEvent(event)).toEqual(validDetail)
  })

  it('returns null and warns for a null detail', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = new CustomEvent(MERGE_COMMITTED_EVENT, { detail: null })
    expect(parseMergeCommittedEvent(event)).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('returns null and warns for a malformed detail', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = new CustomEvent(MERGE_COMMITTED_EVENT, {
      detail: { ...validDetail, newCount: 'nope' },
    })
    expect(parseMergeCommittedEvent(event)).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('returns null for a non-CustomEvent Event without throwing', () => {
    const event = new Event(MERGE_COMMITTED_EVENT)
    expect(() => parseMergeCommittedEvent(event)).not.toThrow()
    expect(parseMergeCommittedEvent(event)).toBeNull()
  })
})

describe('dispatchMergeCommitted', () => {
  it('dispatches a CustomEvent on window whose detail parses with the schema', () => {
    const received: MergeCommittedDetail[] = []
    const handler = (event: Event) => {
      const parsed = parseMergeCommittedEvent(event)
      if (parsed) received.push(parsed)
    }
    window.addEventListener(MERGE_COMMITTED_EVENT, handler)
    try {
      dispatchMergeCommitted(validDetail)
      expect(received).toEqual([validDetail])
    } finally {
      window.removeEventListener(MERGE_COMMITTED_EVENT, handler)
    }
  })
})
