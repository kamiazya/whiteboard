import type { CommentThread } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { sameAnnotations, sameThreadMarks } from './annotations-equal.js'

const thread = (over: Partial<CommentThread> = {}): CommentThread => ({
  id: 't1',
  anchor: { kind: 'spatial', x: 0, y: 0 },
  status: 'open',
  messages: [{ id: 'm1', body: 'first' }],
  ...over,
})

describe('sameAnnotations', () => {
  it('holds for two equal reads', () => {
    expect(sameAnnotations([thread()], [thread()])).toBe(true)
  })

  it('tells an edited message body apart', () => {
    const edited = thread({ messages: [{ id: 'm1', body: 'edited' }] })
    expect(sameAnnotations([thread()], [edited])).toBe(false)
  })

  it('tells a resolved thread apart', () => {
    expect(sameAnnotations([thread()], [thread({ status: 'resolved' })])).toBe(false)
  })

  it('tells a moved anchor apart', () => {
    const moved = thread({ anchor: { kind: 'spatial', x: 9, y: 0 } })
    expect(sameAnnotations([thread()], [moved])).toBe(false)
  })

  it('tells an added reply apart', () => {
    const replied = thread({
      messages: [
        { id: 'm1', body: 'first' },
        { id: 'm2', body: 'reply' },
      ],
    })
    expect(sameAnnotations([thread()], [replied])).toBe(false)
  })
})

describe('sameThreadMarks', () => {
  const marks = (start: number, end: number) => new Map([['t1', { start, end }]])

  it('holds for a passage in the same place', () => {
    expect(sameThreadMarks(marks(0, 4), marks(0, 4))).toBe(true)
  })

  it('tells a passage whose start alone moved apart', () => {
    expect(sameThreadMarks(marks(0, 4), marks(2, 4))).toBe(false)
  })

  it('tells a passage whose end alone moved apart', () => {
    expect(sameThreadMarks(marks(0, 4), marks(0, 6))).toBe(false)
  })

  it('tells a passage now on another thread apart', () => {
    expect(sameThreadMarks(marks(0, 4), new Map([['t2', { start: 0, end: 4 }]]))).toBe(false)
  })
})
