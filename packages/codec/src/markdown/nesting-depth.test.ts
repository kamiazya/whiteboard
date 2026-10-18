import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from './pipeline.js'

type Walked = { type: string; value?: unknown; children?: Walked[] }

/** Deepest node level below the root, walked without recursion. */
function depthOf(root: MdastRoot): number {
  let deepest = 0
  const stack: [Walked, number][] = [[root as Walked, 0]]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, depth] = item
    deepest = Math.max(deepest, depth)
    for (const child of node.children ?? []) stack.push([child, depth + 1])
  }
  return deepest
}

function leafText(root: MdastRoot): string {
  let text = ''
  const stack: Walked[] = [root as Walked]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (typeof node.value === 'string') text += node.value
    for (const child of [...(node.children ?? [])].reverse()) stack.push(child)
  }
  return text
}

function blockquoteChain(root: MdastRoot): number {
  let count = 0
  let node: Walked | undefined = root.children[0] as Walked | undefined
  while (node?.type === 'blockquote') {
    count += 1
    node = node.children?.[0]
  }
  return count
}

// Every body below is far inside MARKDOWN_MAX_CHARS. Each one used to throw
// a RangeError (stack overflow) at a different stage — remark itself, the
// remark-to-model converter, or the schema parse — so each stage is pinned.
describe('parseMarkdownBody nesting depth', () => {
  it('keeps the structure of a realistically nested blockquote', () => {
    const root = parseMarkdownBody(`${'>'.repeat(12)} deep`)
    expect(blockquoteChain(root)).toBe(12)
    expect(leafText(root)).toBe('deep')
  })

  it('keeps nesting up to the bound and flattens what lies past it to text', () => {
    // 150 nested strong spans: past the converter's 64 levels (root, the
    // paragraph, 62 strong) the rest is flattened to the text it holds.
    const root = parseMarkdownBody(`${'*'.repeat(300)}x${'*'.repeat(300)}`)
    let strong = 0
    let node: Walked | undefined = root.children[0] as Walked | undefined
    while (node?.children?.[0] !== undefined) {
      if (node.type === 'strong') strong += 1
      node = node.children[0]
    }
    expect(strong).toBe(62)
    expect(leafText(root)).toBe('x')
  })

  it('opens no container past the thirty-second level and reads its marker as text', () => {
    // The parser itself stops nesting at 32 containers (a patched micromark;
    // see parse-cost.test.ts), so the markers past that are paragraph text.
    const root = parseMarkdownBody(`${'>'.repeat(50)} x`)
    expect(blockquoteChain(root)).toBe(32)
    expect(leafText(root)).toBe(`${'>'.repeat(18)} x`)
  })

  it.each([
    ['blockquotes past the schema parse', `${'>'.repeat(1_000)} tail`],
    ['blockquotes past the converter', `${'>'.repeat(3_000)} tail`],
    ['one-line nested lists', `${'- '.repeat(1_000)}tail`],
    ['nested emphasis', `${'*'.repeat(2_000)}tail${'*'.repeat(2_000)}`],
    ['blockquotes past remark itself', `${'>'.repeat(10_000)} tail`],
  ])(
    'degrades %s instead of overflowing the stack',
    (_shape, body) => {
      const root = parseMarkdownBody(body)
      // The converter's bound is 64; a container flattened just under it keeps
      // the paragraph and text that hold its words, so the tree may reach two
      // levels past it — and nowhere near the thousands the body spells.
      expect(depthOf(root)).toBeLessThanOrEqual(66)
      expect(leafText(root)).toContain('tail')
    },
    30_000,
  )
})
