/**
 * What re-placing a text anchor costs once its stored offsets miss, COUNTED
 * rather than timed so the number is the same on any machine and under any
 * load.
 *
 * Two kinds of work are counted, because they are the two a resolution does:
 * SEARCHES, every `indexOf` a lookup makes (one per occurrence it collects),
 * and READS, every character of the body read by index (the context scoring
 * of each collected occurrence). The body is a `String` wrapped in a proxy
 * that counts the reads and forwards everything else to the primitive.
 *
 * The shape is the expensive one: a one-character quote in a periodic body,
 * so it occurs at every other position and every occurrence shares most of
 * the remembered context. A proposal continued by `wb_body_edit` re-places up
 * to `DOCUMENT_MAX_OPEN_CHANGES` such anchors under the workspace write lock,
 * so whatever one anchor costs is paid a thousand times per call.
 */
import { describe, expect, it } from 'vitest'
import { TEXT_ANCHOR_CONTEXT_MAX_CHARS, type TextAnchor } from './annotation.js'
import { resolveTextAnchor } from './text-anchor.js'

interface Work {
  readonly reads: number
  readonly searches: number
}

function counted(text: string, run: (body: string) => void): Work {
  let reads = 0
  let searches = 0
  const body = new Proxy(new String(text), {
    get(_target, key) {
      if (typeof key === 'string' && key.length > 0 && key.length < 10 && /^\d+$/.test(key)) {
        reads += 1
        return text[Number(key)]
      }
      if (key === 'length') return text.length
      const member = (String.prototype as unknown as Record<PropertyKey, unknown>)[key]
      return typeof member === 'function'
        ? (...args: unknown[]) => (member as (...a: unknown[]) => unknown).apply(text, args)
        : member
    },
  }) as unknown as string
  const indexOf = String.prototype.indexOf
  const lastIndexOf = String.prototype.lastIndexOf
  String.prototype.indexOf = function (this: string, ...args: [string, number?]) {
    searches += 1
    return indexOf.apply(this, args)
  }
  String.prototype.lastIndexOf = function (this: string, ...args: [string, number?]) {
    searches += 1
    return lastIndexOf.apply(this, args)
  }
  try {
    run(body)
  } finally {
    String.prototype.indexOf = indexOf
    String.prototype.lastIndexOf = lastIndexOf
  }
  return { reads, searches }
}

/** `ab` repeated: `a` at every even offset, `b` at every odd one. */
const periodic = (occurrences: number) => 'ab'.repeat(occurrences)

const CONTEXT = 'ab'.repeat(TEXT_ANCHOR_CONTEXT_MAX_CHARS / 2)

/**
 * A stored anchor on `a` whose offsets point at a `b`, with context matching
 * every occurrence up to the farthest character — the arrangement that makes
 * every occurrence a contender and every comparison run long.
 */
const missing = (start: number): TextAnchor => ({
  kind: 'text',
  quote: {
    exact: 'a',
    prefix: `x${CONTEXT.slice(1)}`,
    suffix: `b${CONTEXT.slice(0, -1)}`,
  },
  start,
  end: start + 1,
})

const ANCHORS = 2
const OCCURRENCES = 32 * 1024

/**
 * At most the occurrences nearest the stored offsets are scored, each read
 * for at most the context window on either side plus the character that
 * ends it; a few reads for the offsets' own check. Measured at 4,098
 * searches and 65,536 reads per anchor; before the bound every one of the
 * 32,768 occurrences was collected and scored, 32,769 searches and 2,096,640
 * reads.
 */
const SCORED_MAX = 1024
const READ_CEILING = SCORED_MAX * 2 * (TEXT_ANCHOR_CONTEXT_MAX_CHARS + 1) + 64
const SEARCH_CEILING = 12_000

describe('re-placing an anchor whose offsets missed', () => {
  it('costs a bounded amount however often its quote occurs', () => {
    const body = periodic(OCCURRENCES)
    const work = counted(body, (proxied) => {
      for (let i = 0; i < ANCHORS; i += 1) {
        const resolved = resolveTextAnchor(proxied, missing(body.length / 2 + 1 + 64 * i))
        expect(resolved.kind).toBe('placed')
      }
    })
    expect(work.reads / ANCHORS).toBeLessThanOrEqual(READ_CEILING)
    expect(work.searches / ANCHORS).toBeLessThanOrEqual(SEARCH_CEILING)
  })
})
