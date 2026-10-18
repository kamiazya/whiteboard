import type { Construct, Extension, TokenizeContext } from 'micromark-util-types'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { type Processor, unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { closingRunsExtension } from './closing-runs.js'
import { delimiterBudgetExtension } from './delimiter-budget.js'

/**
 * Work the inline tokenizer and its resolvers do per character of a body,
 * counted rather than timed. Every walk they make — a code span opener
 * scanning ahead for its closer, an emphasis closer or a label end walking
 * back for its opener — reads or writes the inline run's event list, so the
 * instrument wraps that list in a proxy counting element accesses.
 *
 * A timing ratio cannot hold these shapes: a k-length family of distinct
 * code span openers grows as n^1.5, the very ceiling parse-cost.test.ts
 * splits linear from superlinear at, and an unmatched closer after a run of
 * escapes costs a fixed delimiter count times the run, linear in n with a
 * thousandfold constant.
 */
type Counter = { steps: number }

function countingEvents(counter: Counter) {
  const counted = new WeakSet<object>()
  const count = (key: string | symbol) => {
    // An index, not a method or `length`: the cheap test, since a proxy
    // trap runs on every access the parser makes.
    if (typeof key === 'string' && key.charCodeAt(0) >= 48 && key.charCodeAt(0) <= 57) {
      counter.steps++
    }
  }
  // `null`: tried at the start of every inline run, before anything else
  // there has written an event.
  const probe: Construct = {
    name: 'countingEvents',
    tokenize(this: TokenizeContext, _effects, _ok, nok) {
      if (!counted.has(this.events)) {
        const events = new Proxy(this.events, {
          get(target, key, receiver) {
            count(key)
            return Reflect.get(target, key, receiver)
          },
          set(target, key, value, receiver) {
            count(key)
            return Reflect.set(target, key, value, receiver)
          },
        })
        counted.add(events)
        this.events = events
      }
      return nok
    },
  }
  const extension: Extension = { text: { null: [probe] } }
  return function (this: Processor) {
    const data = this.data()
    data.micromarkExtensions = [...(data.micromarkExtensions ?? []), extension]
  }
}

/** pipeline.ts's parser, with the probe. */
function stepsPerCharacter(body: string): number {
  const counter: Counter = { steps: 0 }
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(function (this: Processor) {
      const data = this.data()
      data.micromarkExtensions = [
        ...(data.micromarkExtensions ?? []),
        delimiterBudgetExtension,
        closingRunsExtension,
      ]
    })
    .use(countingEvents(counter))
    .parse(body)
  return counter.steps / body.length
}

function ascendingOpeners(marker: string, count: number): string {
  let openers = ''
  for (let size = 1; size <= count; size++) openers += `${marker.repeat(size)}a`
  return openers
}

/** Accesses per character a run may cost. Ordinary prose costs about five. */
const STEPS_PER_CHARACTER_CEILING = 64

const SHAPES = [
  { name: 'plain words', body: 'word and more words '.repeat(800) },
  // Each opener scans to the end of the run for a closer of its own length,
  // and filler of many tokens makes each scan write many events.
  { name: 'code span openers', body: `${ascendingOpeners('`', 128)} ${'a '.repeat(8_000)}` },
  { name: 'math openers', body: `${ascendingOpeners('$', 128)} ${'a '.repeat(8_000)}` },
  // Each unmatched closer walks back over every event of the run.
  { name: 'emphasis closers after escapes', body: `${'\\*'.repeat(16_000)}${'a* '.repeat(256)}` },
  { name: 'label ends after escapes', body: `${'\\*'.repeat(16_000)}${'a] '.repeat(256)}` },
]

describe('inline run event accesses', () => {
  it.each(SHAPES)('$name stays under the step ceiling', ({ body }) => {
    const steps = stepsPerCharacter(body)
    // The probe reached the run: even prose writes a few events per character.
    expect(steps).toBeGreaterThan(1)
    expect(steps).toBeLessThan(STEPS_PER_CHARACTER_CEILING)
  }, 120_000)
})
