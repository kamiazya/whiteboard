// What a node's passage highlights cost one layout, counted as work rather
// than wall time so a loaded machine cannot fail or pass it.
//
// The worst case a writer can build: the open-thread cap of threads on one
// node at the text bound, each quoting one character of a periodic body whose
// source and rendered occurrence counts differ — so every passage falls to
// scoring the rendered occurrences by their context.

import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import {
  DOCUMENT_MAX_OPEN_THREADS,
  NODE_TEXT_MAX_CHARS,
  TEXT_ANCHOR_CONTEXT_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { typesetMdastBlocks } from './nodes/mdast-blocks.js'
import { collectTextRuns, composePassageHighlights, type NodePassage } from './passage-highlight.js'

const contextReads = vi.hoisted(() => ({ count: 0 }))

vi.mock('@kamiazya/whiteboard-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-model')>()
  return {
    ...actual,
    sharedContext: (
      context: string,
      side: 'before' | 'after',
      read: (k: number) => string | undefined,
    ) =>
      actual.sharedContext(context, side, (k) => {
        contextReads.count += 1
        return read(k)
      }),
  }
})

const options = { measure: createFakeMeasure(), maxWidth: 400, fontFamily: 'sans-serif' }

/** `a a a … [a](a)`: the link's target is a source occurrence the canvas never draws. */
function periodicNode(): { source: string; runs: TextRunNode[] } {
  const tail = '[a](a)'
  const source = `${'a '.repeat(Math.floor((NODE_TEXT_MAX_CHARS - tail.length) / 2))}${tail}`
  expect(source.length).toBeLessThanOrEqual(NODE_TEXT_MAX_CHARS)
  const runs = collectTextRuns(typesetMdastBlocks(parseMarkdownBody(source), options).nodes)
  return { source, runs }
}

/** Each run behind a proxy counting reads of its `text`. */
function countingRuns(runs: readonly TextRunNode[]): { runs: TextRunNode[]; reads: () => number } {
  let reads = 0
  const proxied = runs.map(
    (run) =>
      new Proxy(run, {
        get(target, key, receiver) {
          if (key === 'text') reads += 1
          return Reflect.get(target, key, receiver)
        },
      }),
  )
  return { runs: proxied, reads: () => reads }
}

// What the canvas reads around every occurrence, so no comparison stops early.
const context = ' a'.repeat(TEXT_ANCHOR_CONTEXT_MAX_CHARS)

function passages(source: string): NodePassage[] {
  return Array.from({ length: DOCUMENT_MAX_OPEN_THREADS }, (_, index) => {
    // Spread over the body, each on an occurrence of its own.
    const start = 2 * Math.floor((index * (source.length - 8)) / (2 * DOCUMENT_MAX_OPEN_THREADS))
    return {
      threadId: `t${index}`,
      nodeId: 'n',
      anchor: {
        kind: 'text',
        quote: { exact: 'a', prefix: context.slice(-32), suffix: context.slice(0, 32) },
        start,
        end: start + 1,
      },
      resolved: false,
    }
  })
}

describe('passage highlight cost on a periodic node at the open-thread cap', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    contextReads.count = 0
  })

  it('reads a bounded amount of context per passage', () => {
    const { source, runs } = periodicNode()
    const drawn = composePassageHighlights(passages(source), runs, options.measure, {}, source)
    expect(drawn.length).toBeGreaterThan(0)
    // Two contexts of the window each, over at most the nearest 1024
    // occurrences per passage.
    expect(contextReads.count).toBeLessThanOrEqual(
      DOCUMENT_MAX_OPEN_THREADS * 1024 * 2 * (TEXT_ANCHOR_CONTEXT_MAX_CHARS + 1),
    )
  })

  it('reads each run a bounded number of times', () => {
    const { source, runs } = periodicNode()
    const counted = countingRuns(runs)
    composePassageHighlights(passages(source), counted.runs, options.measure, {}, source)
    expect(counted.reads()).toBeGreaterThan(0)
    // The rendered text once per node, plus a few runs per passage drawn.
    expect(counted.reads()).toBeLessThanOrEqual(2 * runs.length + 16 * DOCUMENT_MAX_OPEN_THREADS)
  })

  it('hands a regex a bounded number of characters per run', () => {
    const { source, runs } = periodicNode()
    let tested = 0
    const original = RegExp.prototype.test
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, input: string) {
      tested += String(input).length
      return original.call(this, input)
    })
    // One passage quoting no context, so what is counted is the per-run work
    // of building the rendered text, not the per-occurrence reads the first
    // case bounds. Searching the rendered text and the source tests each of
    // their characters once.
    const [passage] = passages(source)
    if (passage === undefined) throw new Error('no passage')
    const bare = { ...passage, anchor: { ...passage.anchor, quote: { exact: 'a' } } }
    composePassageHighlights([bare], runs, options.measure, {}, source)
    vi.restoreAllMocks()
    expect(tested).toBeGreaterThan(0)
    expect(tested).toBeLessThanOrEqual(8 * source.length)
  })
})
