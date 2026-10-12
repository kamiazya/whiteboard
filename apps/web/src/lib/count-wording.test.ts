// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { countOf, planeCounts } from './count-wording.js'

describe('countOf', () => {
  it('takes the singular noun for exactly one', () => {
    expect(countOf(1, 'box', 'boxes')).toBe('1 box')
  })

  it('takes the plural noun for zero and for more than one', () => {
    expect(countOf(0, 'box', 'boxes')).toBe('0 boxes')
    expect(countOf(2, 'box', 'boxes')).toBe('2 boxes')
  })
})

describe('planeCounts', () => {
  it('says nothing of a plane that carried nothing', () => {
    expect(planeCounts({ trash: 0, versions: 0 })).toEqual([])
  })

  it('names one of each in the singular, trash first', () => {
    expect(planeCounts({ trash: 1, versions: 1 })).toEqual([
      '1 trashed document',
      '1 saved version',
    ])
  })

  it('names several of each in the plural', () => {
    expect(planeCounts({ trash: 2, versions: 2 })).toEqual([
      '2 trashed documents',
      '2 saved versions',
    ])
  })

  it('names only the plane that carried something', () => {
    expect(planeCounts({ trash: 0, versions: 3 })).toEqual(['3 saved versions'])
    expect(planeCounts({ trash: 3, versions: 0 })).toEqual(['3 trashed documents'])
  })
})
