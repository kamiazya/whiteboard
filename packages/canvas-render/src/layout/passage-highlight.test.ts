import {
  NODE_TEXT_MAX_CHARS,
  resolveTextAnchor,
  TEXT_ANCHOR_CONTEXT_MAX_CHARS,
  type TextQuoteSelector,
} from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { typesetMdastBlocks } from './nodes/mdast-blocks.js'
import { composePassageHighlights, type NodePassage, passageBoxes } from './passage-highlight.js'

const options = { measure: createFakeMeasure(), maxWidth: 2000, fontFamily: 'sans-serif' }

/** One paragraph laid out the way a text node's body is: wrapped into runs. */
function runsOf(text: string): TextRunNode[] {
  return typesetMdastBlocks(
    {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    } as MdastRoot,
    options,
  ).nodes.flatMap((node) => ('runs' in node ? [...(node.runs ?? [])] : []))
}

/**
 * One paragraph laid out as one run, so a box's offset inside it is the
 * passage's character offset times the fake measure's advance per character.
 */
function runOf(text: string) {
  const runs = runsOf(text)
  expect(runs).toHaveLength(1)
  return runs
}

/** The character offset the highlight starts at, or null when there is none. */
function startOf(text: string, quote: TextQuoteSelector): number | null {
  const runs = runOf(text)
  const boxes = passageBoxes(runs, quote, options.measure)
  if (boxes.length === 0) return null
  expect(boxes).toHaveLength(1)
  const [box] = boxes
  const perChar = box.w / quote.exact.length
  return Math.round((box.x - runs[0].bbox.x) / perChar)
}

describe('a passage highlight picks the occurrence whose surroundings match best', () => {
  const rendered = 'alpha foo omega beta foo gamma'
  const first = rendered.indexOf('foo')
  const last = rendered.lastIndexOf('foo')

  it('uses the prefix to choose between two identical quotes', () => {
    expect(startOf(rendered, { exact: 'foo', prefix: 'beta ' })).toBe(last)
  })

  it('uses the suffix when there is no prefix', () => {
    expect(startOf(rendered, { exact: 'foo', suffix: ' omega' })).toBe(first)
    expect(startOf(rendered, { exact: 'foo', suffix: ' gamma' })).toBe(last)
  })

  it('keeps the best of three occurrences against a later weaker one', () => {
    const text = 'x foo y. a foo b. foo'
    expect(startOf(text, { exact: 'foo', prefix: 'a ', suffix: ' b' })).toBe(
      text.indexOf('a foo') + 2,
    )
  })

  // The context is compared with every run of whitespace read as one space,
  // on both sides: the rendered text and the remembered prefix.
  it('reads a run of spaces before an occurrence as one space', () => {
    // Prose collapses its spaces; inline code keeps them, so the rendered
    // text reads `zeta foo. beta  foo.` with two before the second `foo`.
    const runs = typesetMdastBlocks(
      {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', value: 'zeta foo. ' },
              { type: 'inlineCode', value: 'beta  ' },
              { type: 'text', value: 'foo.' },
            ],
          },
        ],
      } as MdastRoot,
      options,
    ).nodes.flatMap((node) => ('runs' in node ? [...(node.runs ?? [])] : []))
    expect(runs.map((run) => run.text)).toEqual(['zeta foo.', 'beta  ', 'foo.'])
    const boxes = passageBoxes(runs, { exact: 'foo', prefix: 'beta ' }, options.measure)
    expect(boxes.map((box) => box.x)).toEqual([runs[2]?.bbox.x])
  })

  it('reads a run of spaces in the remembered prefix as one space', () => {
    const text = 'zeta foo. beta foo.'
    expect(startOf(text, { exact: 'foo', prefix: 'beta  ' })).toBe(text.lastIndexOf('foo'))
  })

  it('draws nothing for a blank or absent quote', () => {
    expect(startOf(rendered, { exact: '  ' })).toBeNull()
    expect(startOf(rendered, { exact: 'missing' })).toBeNull()
  })
})

describe('a passage highlight is the occurrence the model resolves in the source', () => {
  const sentence = 'Ship it, then follow up today. '
  const text = sentence.repeat(4).trim()
  const third = text.indexOf('follow up', 2 * sentence.length)
  // Sixteen characters either side, as the editor writes a selection's context:
  // every occurrence but the last shares them, so only the offsets tell.
  const anchor = {
    kind: 'text' as const,
    quote: {
      exact: 'follow up',
      prefix: text.slice(third - 16, third),
      suffix: text.slice(third + 9, third + 25),
    },
    start: third,
    end: third + 9,
  }

  function drawnAt(source: string, rendered: string): number | null {
    const runs = runOf(rendered)
    const boxes = passageBoxes(runs, anchor.quote, options.measure, {
      text: source,
      start: anchor.start,
      end: anchor.end,
    })
    if (boxes.length === 0) return null
    const [box] = boxes
    return Math.round((box.x - runs[0].bbox.x) / (box.w / anchor.quote.exact.length))
  }

  it('highlights the third of four identical sentences when the anchor names the third', () => {
    expect(resolveTextAnchor(text, anchor)).toEqual({
      kind: 'placed',
      start: third,
      end: third + 9,
    })
    expect(drawnAt(text, text)).toBe(third)
  })

  it('scores the rendered occurrences when rendering dropped one of the source ones', () => {
    // One more occurrence in the source than on the canvas: the numbering no
    // longer lines up, so the context decides — and the second and third
    // occurrence share all of it, so the tie goes to the earlier one.
    expect(drawnAt(`<!-- follow up -->\n${text}`, text)).toBe(
      text.indexOf('follow up', sentence.length),
    )
  })

  // The highlight starts at the quote's first word, while the anchor's
  // offsets include the whitespace the selection began with.
  it('highlights the anchored occurrence of a quote that starts with whitespace', () => {
    const quote = {
      exact: ' follow up',
      prefix: text.slice(third - 17, third - 1),
      suffix: anchor.quote.suffix,
    }
    const runs = runOf(text)
    const boxes = passageBoxes(runs, quote, options.measure, {
      text,
      start: third - 1,
      end: third + 9,
    })
    expect(boxes).toHaveLength(1)
    const perChar = (runs[0]?.bbox.w ?? 0) / text.length
    expect(Math.round(((boxes[0]?.x ?? 0) - (runs[0]?.bbox.x ?? 0)) / perChar)).toBe(third)
  })

  it('draws nothing for a passage the source no longer holds', () => {
    expect(drawnAt(text.replaceAll('follow up', 'chase'), text)).toBeNull()
  })
})

describe('a passage highlight weighs only the context nearest the quote', () => {
  // Longer than the window, so two occurrences that share it are told apart
  // only by characters the model's resolver no longer reads.
  const shared = 'and this shared stretch of context outruns the window'
  const rendered = `left ${shared} foo one. right ${shared} foo two.`

  it('chooses the occurrence the model resolver chooses', () => {
    expect(shared.length).toBeGreaterThan(TEXT_ANCHOR_CONTEXT_MAX_CHARS)
    const quote = { exact: 'foo', prefix: `right ${shared} ` }
    const model = resolveTextAnchor(rendered, { kind: 'text', quote, start: 0, end: 0 })
    expect(model).toEqual({
      kind: 'placed',
      start: rendered.indexOf('foo'),
      end: rendered.indexOf('foo') + 3,
    })
    expect(startOf(rendered, quote)).toBe(rendered.indexOf('foo'))
  })
})

describe('a passage highlight costs a bounded comparison per occurrence', () => {
  /** Prose at the node bound, laid out as runs the way a text node's body is. */
  function proseRuns() {
    const words =
      'the quick brown fox jumps over the lazy dog and then the cat sat on the mat while '
    const text = words
      .repeat(Math.ceil(NODE_TEXT_MAX_CHARS / words.length))
      .slice(0, NODE_TEXT_MAX_CHARS)
    return { text, runs: runsOf(text) }
  }

  // Comparing each occurrence's context against everything before and after
  // it made the cost occurrences x text. Measured on a shared 4-core machine:
  // sixteen threads quoting a common word in 8 Ki of prose took 1.5 s per
  // layout, and one thread quoting the only character of an 8 Ki node 0.7-1.0
  // s; comparing outward over at most the context window, 2-27 ms and 2-11 ms
  // under a load average near 40. The ceiling sits between the two with a wide
  // margin either way, and the fastest of three attempts is what is judged, so
  // a load spike on one cannot fail it.
  function fastestOfThree(draw: () => number): number {
    let fastest = Number.POSITIVE_INFINITY
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now()
      const drawn = draw()
      fastest = Math.min(fastest, performance.now() - started)
      expect(drawn).toBeGreaterThan(0)
    }
    return fastest
  }

  it('lays sixteen common-word threads over an 8 Ki node quickly', () => {
    const { text, runs } = proseRuns()
    const quote = { exact: 'the', prefix: 'jumps over ', suffix: ' lazy dog' }
    // Stale offsets, so every thread is resolved by searching the source
    // rather than by the stored-offset shortcut.
    const passages: NodePassage[] = Array.from({ length: 16 }, (_, index) => ({
      threadId: `t${index}`,
      nodeId: 'n',
      anchor: { kind: 'text', quote, start: 1, end: 4 },
      resolved: false,
    }))
    const draw = () => composePassageHighlights(passages, runs, options.measure, {}, text).length
    expect(fastestOfThree(draw)).toBeLessThan(250)
  })

  it('scores a one-character quote over an 8 Ki node of that character quickly', () => {
    const text = 'a '.repeat(NODE_TEXT_MAX_CHARS / 2).trim()
    const runs = runsOf(text)
    // No source, so every occurrence is scored by its context.
    const quote = { exact: 'a', prefix: 'a a a a a a a a ', suffix: ' a a a a a a a a' }
    const draw = () => passageBoxes(runs, quote, options.measure).length
    expect(fastestOfThree(draw)).toBeLessThan(250)
  })
})
