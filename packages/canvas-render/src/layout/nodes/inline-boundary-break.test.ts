/**
 * Kinsoku holds ACROSS an inline boundary, not only inside one run.
 *
 * The wrapper decides breaks one `emit` call at a time and every inline node
 * is its own call, so a closing character that begins a text node could open
 * a line however firmly UAX #14 forbids it — `**強調**。` and `` `code`. ``
 * alike. `ja-kinsoku` in the wrapping corpus proves the same rule already
 * holds inside a single run, which is what made this a seam defect rather
 * than a line-breaking one.
 */
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createCorpusMeasure } from '../../test-utils/text-wrapping-corpus.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

function lineOpeners(children: unknown[], maxWidth: number): string[] {
  const scene = layoutMdastBlocks(
    { type: 'root', children: [{ type: 'paragraph', children }] } as MdastRoot,
    { measure: createCorpusMeasure().measure, maxWidth, fontFamily: 'Roboto' },
  )
  const runs = scene.nodes.flatMap((n) => ('runs' in n ? (n.runs ?? []) : []))
  const leftmost = new Map<number, { x: number; text: string }>()
  for (const run of runs) {
    const current = leftmost.get(run.bbox.y)
    if (current === undefined || run.bbox.x < current.x)
      leftmost.set(run.bbox.y, { x: run.bbox.x, text: run.text })
  }
  return [...leftmost.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => [...entry.text][0] ?? '')
}

const JA = 'これは日本語です'
const code = (value: string) => ({ type: 'inlineCode', value })
const text = (value: string) => ({ type: 'text', value })
const strong = (value: string) => ({ type: 'strong', children: [text(value)] })

describe('a closing character never opens a line, whatever precedes it', () => {
  it('keeps 。 off the line start after inline code', () => {
    for (const width of [120, 200]) {
      expect(
        lineOpeners([text(JA), code('layout'), text('。つづきの文があります。')], width),
      ).not.toContain('。')
    }
  })

  it('keeps 。 off the line start after emphasis', () => {
    expect(
      lineOpeners([text(JA), strong('強調'), text('。つづきの文があります。')], 120),
    ).not.toContain('。')
  })

  it('keeps a full stop off the line start after inline code', () => {
    expect(
      lineOpeners([text('Run the '), code('fit'), text('. Then it continues.')], 120),
    ).not.toContain('.')
  })

  /**
   * An icon is DRAWN, so its run carries an EM SPACE as its placeholder and
   * asking UAX #14 about that text would answer "a space, break freely" —
   * which is how the original report was written up: a full stop landing
   * alone on the line under an icon. The junction reads U+FFFC for a run
   * that paints, so the pair holds.
   */
  it('keeps 。 off the line start after an icon', () => {
    // Swept, because a single width proves nothing here: at 120 the `。`
    // fits beside the icon whatever the junction says, and the case reads
    // green over an unfixed wrapper.
    for (const width of [100, 140, 160]) {
      expect(lineOpeners([text(`${JA}:icon-star:。つづきの文があります。`)], width)).not.toContain(
        '。',
      )
    }
  })

  /**
   * The other direction, so the fix cannot be "never break after an inline
   * element": a SPACE between them is a break opportunity and must stay one.
   */
  it('still breaks where the source offers a space', () => {
    const openers = lineOpeners(
      [text('Run the '), code('fit'), text(' and then it continues.')],
      120,
    )
    expect(openers.length).toBeGreaterThan(1)
    expect(openers).not.toContain('.')
  })
})
