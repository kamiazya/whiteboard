import { describe, expect, it } from 'vitest'
import { afterAllFloor, type FloorSuite, floorIsFed } from './reachability-floor.js'

type State = 'pass' | 'fail' | 'skip' | 'todo' | undefined

const test = (name: string, state: State) => ({
  type: 'test' as const,
  name,
  result: state === undefined ? undefined : { state },
})
const suite = (name: string, tasks: FloorSuite['tasks']) => ({
  type: 'suite' as const,
  name,
  tasks,
})

describe('floorIsFed', () => {
  it('holds a floor whose named feeders all ran, passing or failing', () => {
    const file = { tasks: [test('feeds', 'pass'), test('also feeds', 'fail')] }
    expect(floorIsFed(file, ['feeds', 'also feeds'])).toBe(true)
  })

  it('silences a floor when a name filter left one of its feeders unrun', () => {
    const file = { tasks: [test('feeds', 'skip'), test('unrelated', 'pass')] }
    expect(floorIsFed(file, ['feeds'])).toBe(false)
  })

  it('does not let a skipped test that feeds nothing silence the floor', () => {
    const file = { tasks: [test('feeds', 'pass'), test('quarantined', 'skip')] }
    expect(floorIsFed(file, ['feeds'])).toBe(true)
  })

  it('names a property by the title it was written with, whatever seed it drew', () => {
    const file = { tasks: [test('never cuts a character (with seed=-1234)', 'pass')] }
    expect(floorIsFed(file, ['never cuts a character'])).toBe(true)
    expect(() => floorIsFed(file, ['never cuts'])).toThrow(/never cuts/)
  })

  it('finds feeders inside nested suites, and matches a pattern against every title', () => {
    const file = {
      tasks: [
        suite('outer', [test('keeps emoji whole', 'pass'), test('keeps flags whole', 'pass')]),
        test('unrelated', 'skip'),
      ],
    }
    expect(floorIsFed(file, [/^keeps .* whole$/])).toBe(true)
    const halfRun = {
      tasks: [
        suite('outer', [test('keeps emoji whole', 'pass'), test('keeps flags whole', 'skip')]),
      ],
    }
    expect(floorIsFed(halfRun, [/^keeps .* whole$/])).toBe(false)
  })

  it('reads every test in the suite as a feeder when asked to', () => {
    expect(floorIsFed({ tasks: [test('a', 'pass'), test('b', 'pass')] }, 'every test')).toBe(true)
    expect(floorIsFed({ tasks: [test('a', 'pass'), test('b', 'skip')] }, 'every test')).toBe(false)
  })

  it('refuses a feeder name the suite does not hold, so a rename cannot silence a floor for good', () => {
    const file = { tasks: [test('feeds', 'pass')] }
    expect(() => floorIsFed(file, ['renamed away'])).toThrow(/renamed away/)
    expect(() => floorIsFed({ tasks: [] }, 'every test')).toThrow(/no test/)
  })
})

// The hook itself, through the real runner: a floor whose feeder never ran
// must not fail the file. If it ran, the throw below would. The feeder skips
// itself at run time, which leaves it in the state a name filter leaves it in.
describe('a floor whose feeder is skipped', () => {
  it('feeds', ({ skip }) => {
    expect(skip).toBeTypeOf('function')
    skip()
  })
  it('runs beside it', () => {
    expect(true).toBe(true)
  })
  afterAllFloor(['feeds'], () => {
    throw new Error('this floor ran although its feeder did not')
  })
})

// The positive half, through the real runner: a floor whose feeder ran must
// run. A met floor passes whether or not it ran, so only a later suite can
// see that it did — describe blocks run in order within a file.
const floorsRun: string[] = []

describe('a floor whose feeder ran', () => {
  it('feeds', () => {
    expect(floorsRun).toEqual([])
  })
  afterAllFloor(['feeds'], () => {
    floorsRun.push('fed')
  })
})

describe('after a fed floor', () => {
  it('sees that the floor ran once its suite was done', () => {
    expect(floorsRun).toEqual(['fed'])
  })
})
