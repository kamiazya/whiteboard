/**
 * Direct unit tests for the junction, which `inline-boundary-break.test.ts`
 * reaches only through `layoutMdastBlocks`.
 *
 * The reason is Stryker's, not a reader's: the lane picks a mutant's tests by
 * relatedness, and on this module's first report 16 of 20 survivors came back
 * `judged by 0 tests` while three of the same decisions were killed by hand.
 * A module whose report is known weak is one the lane's own rule says to
 * distrust (`seed.ts`), and the cheaper answer than excluding it is to give
 * it tests that name it. They are worth having on their own terms too — the
 * head/tail pair is pure, and asserting `` `。` `` may not open a line after
 * `t` reads as the rule, where the same fact taken off a laid-out scene reads
 * as an x coordinate.
 */
import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createInlineJunction, headCharacter, tailCharacter } from './inline-junction.js'

const OBJECT_REPLACEMENT = '￼'

const runAt = (x: number, y: number, text: string): TextRunNode => ({
  kind: 'textRun',
  bbox: { x, y, w: 10, h: 20 },
  baseline: 16,
  text,
})

describe('the character a break decision is taken against', () => {
  it('is the first or last code point of ordinary text', () => {
    expect(headCharacter('layout', undefined)).toBe('l')
    expect(tailCharacter('layout', undefined)).toBe('t')
  })

  it('is a whole astral code point, not half a surrogate pair', () => {
    expect(headCharacter('𝟙x', undefined)).toBe('𝟙')
    expect(tailCharacter('x𝟙', undefined)).toBe('𝟙')
  })

  it("answers '' for whitespace, because a break there is already allowed", () => {
    expect(headCharacter(' x', undefined)).toBe('')
    expect(tailCharacter('x ', undefined)).toBe('')
    expect(headCharacter('', undefined)).toBe('')
  })

  it('answers U+FFFC for a run that paints rather than spells', () => {
    // Its placeholder is an EM SPACE, so the whitespace branch above would
    // otherwise claim a picture is a space.
    expect(headCharacter(' ', { kind: 'icon', name: 'star' })).toBe(OBJECT_REPLACEMENT)
    expect(tailCharacter(' ', { kind: 'icon', name: 'star' })).toBe(OBJECT_REPLACEMENT)
  })
})

describe('breakableBefore', () => {
  const junctionAfter = (text: string, paints?: TextRunNode['paints']) => {
    const runs: TextRunNode[] = []
    const junction = createInlineJunction(runs, { x: 0, index: 0 }, 20)
    junction.placed(text, paints)
    return junction
  }

  it('forbids a break UAX #14 forbids', () => {
    expect(junctionAfter('layout').breakableBefore('。')).toBe(false)
    expect(junctionAfter('fit').breakableBefore('.')).toBe(false)
    expect(junctionAfter('強調').breakableBefore('。')).toBe(false)
  })

  it('allows one it allows', () => {
    expect(junctionAfter('です').breakableBefore('l')).toBe(true)
    expect(junctionAfter('。').breakableBefore('あ')).toBe(true)
  })

  it('reads a painting run as an object, not as its EM SPACE', () => {
    const icon = { kind: 'icon', name: 'star' } as const
    expect(junctionAfter(' ', icon).breakableBefore('。')).toBe(false)
    expect(junctionAfter(' ', icon).breakableBefore('あ')).toBe(true)
  })

  it('allows a break at the start of a line and after whitespace', () => {
    const runs: TextRunNode[] = []
    const fresh = createInlineJunction(runs, { x: 0, index: 0 }, 20)
    expect(fresh.breakableBefore('。')).toBe(true)
    expect(junctionAfter('the ').breakableBefore('。')).toBe(true)
  })
})

describe('relocateCluster', () => {
  it('moves the cluster down a line and back to the left margin', () => {
    // `allowBreakHere` reads `runs.length` and `line.x` as they stand, so the
    // cluster has to be opened before the run that joins it is pushed.
    const runs = [runAt(0, 0, 'これは')]
    const line = { x: 48, index: 0 }
    const junction = createInlineJunction(runs, line, 20)
    junction.allowBreakHere()
    runs.push(runAt(48, 0, 'fit'))
    line.x = 90
    expect(junction.relocateCluster()).toBe(true)
    expect(runs[1]?.bbox).toMatchObject({ x: 0, y: 20 })
    expect(runs[0]?.bbox).toMatchObject({ x: 0, y: 0 })
    expect(line).toEqual({ x: 42, index: 1 })
  })

  it('declines when the cluster is the whole line, so the caller can break', () => {
    const runs = [runAt(0, 0, 'これは')]
    const line = { x: 48, index: 0 }
    const junction = createInlineJunction(runs, line, 20)
    expect(junction.relocateCluster()).toBe(false)
    expect(runs[0]?.bbox).toMatchObject({ x: 0, y: 0 })
    expect(line).toEqual({ x: 48, index: 0 })
  })

  it('declines twice in a row, which is what stops the caller looping', () => {
    const runs = [runAt(0, 0, 'a')]
    const line = { x: 48, index: 0 }
    const junction = createInlineJunction(runs, line, 20)
    junction.allowBreakHere()
    runs.push(runAt(48, 0, 'b'))
    line.x = 90
    expect(junction.relocateCluster()).toBe(true)
    expect(junction.relocateCluster()).toBe(false)
  })

  it('moves every run of the cluster, not only its first', () => {
    const runs = [runAt(0, 0, 'a')]
    const line = { x: 20, index: 0 }
    const junction = createInlineJunction(runs, line, 20)
    junction.allowBreakHere()
    runs.push(runAt(20, 0, 'b'), runAt(40, 0, 'c'))
    line.x = 60
    expect(junction.relocateCluster()).toBe(true)
    expect(runs.map((run) => run.bbox.x)).toEqual([0, 0, 20])
    expect(runs.map((run) => run.bbox.y)).toEqual([0, 20, 20])
  })
})

describe('startLine', () => {
  it('resets the cursor and leaves nothing on the line to relocate', () => {
    const runs = [runAt(0, 0, 'a')]
    const line = { x: 48, index: 0 }
    const junction = createInlineJunction(runs, line, 20)
    junction.allowBreakHere()
    runs.push(runAt(48, 0, 'b'))
    line.x = 90
    junction.startLine()
    expect(line).toEqual({ x: 0, index: 1 })
    expect(junction.breakableBefore('。')).toBe(true)
    expect(junction.relocateCluster()).toBe(false)
  })
})
