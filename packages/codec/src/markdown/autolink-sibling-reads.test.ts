import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { type Processor, unified } from 'unified'
import { describe, expect, it } from 'vitest'

/**
 * GFM's literal-autolink pass (mdast-util-find-and-replace) looks every text
 * node, and each of its ancestors, up among its siblings. Done from the
 * start of the list each time, a paragraph of n text nodes — or a body of n
 * paragraphs — costs n²/2 reads: `a\`c\`` repeated to the 256 KB body limit
 * took seconds, while the same body without GFM took half a second.
 *
 * A timing ratio cannot hold this: the quadratic term is a cheap read, so it
 * only dominates near the body limit, where a fitted exponent still reads
 * about 1.2. This counts the reads instead. A transform registered ahead of
 * GFM's wraps every child list in a proxy that counts element reads; the
 * pass must read each list a bounded number of times over.
 */
type Counter = { reads: number; elements: number }

function countingChildren(counter: Counter) {
  return function (this: Processor) {
    const data = this.data()
    const wrap = (node: { children?: unknown[] }) => {
      if (!Array.isArray(node.children)) return
      for (const child of node.children) wrap(child as { children?: unknown[] })
      counter.elements += node.children.length
      node.children = new Proxy(node.children, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) counter.reads++
          return Reflect.get(target, key, receiver)
        },
      })
    }
    data.fromMarkdownExtensions = [
      ...(data.fromMarkdownExtensions ?? []),
      { transforms: [(tree) => void wrap(tree as { children?: unknown[] })] },
    ]
  }
}

function readsPerElement(body: string): number {
  const counter: Counter = { reads: 0, elements: 0 }
  // Ours first: transforms run in registration order.
  unified().use(remarkParse).use(countingChildren(counter)).use(remarkGfm).parse(body)
  return counter.reads / counter.elements
}

/** Reads per child the pass may spend, independent of how many there are. */
const READS_PER_ELEMENT_CEILING = 16

describe('GFM autolink pass sibling lookups', () => {
  it.each([
    { name: 'one paragraph of many text nodes', unit: 'a`c`' },
    { name: 'many paragraphs', unit: 'a\n\n' },
    { name: 'many list items', unit: '- a\n' },
  ])('reads each child a bounded number of times: $name', ({ unit }) => {
    expect(readsPerElement(unit.repeat(1_500))).toBeLessThan(READS_PER_ELEMENT_CEILING)
  })
})
