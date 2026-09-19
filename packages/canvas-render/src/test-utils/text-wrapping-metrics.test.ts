/**
 * Calibration for the wrapping oracle's newest column, against scenes built
 * by hand rather than by the wrapper.
 *
 * Written because this repo has already trusted an instrument for three
 * declarations before calibrating it, and found it reporting 0.3ms for a
 * 200ms stall. A column whose whole job is to read zero is exactly the shape
 * that passes while measuring nothing.
 */
import type { Scene, TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { wrappingMetrics } from './text-wrapping-metrics.js'

const run = (text: string, x: number, y: number): TextRunNode => ({
  kind: 'textRun',
  bbox: { x, y, w: 10, h: 16 },
  text,
})

const paragraph = (runs: readonly TextRunNode[]): Scene => ({
  nodes: [{ kind: 'paragraph', bbox: { x: 0, y: 0, w: 100, h: 64 }, runs }],
})

const badStarts = (scene: Scene) => wrappingMetrics(scene, 100, 0).forbiddenLineStarts

describe('lines opened by a character UAX #14 forbids there', () => {
  it('counts one, in either script', () => {
    expect(badStarts(paragraph([run('これは', 0, 0), run('。つづき', 0, 16)]))).toBe(1)
    expect(badStarts(paragraph([run('Call it', 0, 0), run('. Then', 0, 16)]))).toBe(1)
  })

  it('counts none when the line opens with an ordinary character', () => {
    expect(badStarts(paragraph([run('これは', 0, 0), run('つづき。', 0, 16)]))).toBe(0)
  })

  /**
   * The exemption that keeps the column honest: nothing was broken before a
   * block's first line, so a paragraph the author began with a full stop is
   * their text rather than a wrapping defect.
   */
  it('exempts the first line of a block', () => {
    expect(badStarts(paragraph([run('。はじめ', 0, 0), run('つづき', 0, 16)]))).toBe(0)
  })

  /** Two blocks, so one block's first line is not read as a break in another. */
  it('exempts each block separately', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'paragraph', bbox: { x: 0, y: 0, w: 100, h: 16 }, runs: [run('ひとつめ', 0, 0)] },
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 32, w: 100, h: 16 },
          runs: [run('。ふたつめ', 0, 32)],
        },
      ],
    }
    expect(badStarts(scene)).toBe(0)
  })

  /** The OPENER is the leftmost run, not whichever the walk reached first. */
  it('reads the leftmost run on the line, not the first walked', () => {
    expect(
      badStarts(paragraph([run('これは', 0, 0), run('あと', 40, 16), run('。まえ', 0, 16)])),
    ).toBe(1)
  })
})
