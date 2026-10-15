import { describe, expect, it } from 'vitest'
import { connectionsStamp } from './use-connections.js'

const OPEN = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

const list = (openAt: string, otherAt: string, otherPath = 'plan') => [
  { documentId: OPEN, path: 'main', name: 'Main', updatedAt: openAt },
  { documentId: OTHER, path: otherPath, name: 'Plan', updatedAt: otherAt },
]

describe('connectionsStamp', () => {
  it('stays put when only the open document is edited', () => {
    expect(connectionsStamp(list('1', '1'), OPEN)).toBe(connectionsStamp(list('2', '1'), OPEN))
  })

  it('moves when another document is edited or moved', () => {
    const before = connectionsStamp(list('1', '1'), OPEN)
    expect(connectionsStamp(list('1', '2'), OPEN)).not.toBe(before)
    expect(connectionsStamp(list('1', '1', 'notes/plan'), OPEN)).not.toBe(before)
  })
})
