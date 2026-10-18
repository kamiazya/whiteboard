import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from './pipeline.js'

type Walked = { type: string; url?: string; children?: Walked[] }

function linkUrls(root: MdastRoot): string[] {
  const urls: string[] = []
  const stack: Walked[] = [root as Walked]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'link' && node.url !== undefined) urls.push(node.url)
    stack.push(...(node.children ?? []))
  }
  return urls
}

// The tokenizer reads at most 2,048 characters of a literal link's path and
// 256 closing punctuation marks (a patched micromark-extension-gfm-autolink-
// literal; see parse-cost.test.ts).
describe('parseMarkdownBody literal link bounds', () => {
  it('links a path inside the bound whole', () => {
    expect(linkUrls(parseMarkdownBody(`www.a.com/${'p'.repeat(2_000)}`))).toEqual([
      `http://www.a.com/${'p'.repeat(2_000)}`,
    ])
  })

  it('ends the link at the bound of a longer path', () => {
    expect(linkUrls(parseMarkdownBody(`www.a.com/${'p'.repeat(3_000)}`))).toEqual([
      `http://www.a.com/${'p'.repeat(2_047)}`,
    ])
  })

  it('leaves closing punctuation inside the bound out of the link', () => {
    expect(linkUrls(parseMarkdownBody(`www.a.com/x${'!'.repeat(200)}`))).toEqual([
      'http://www.a.com/x',
    ])
  })

  it('keeps all but the last 256 of a longer closing run in the link', () => {
    expect(linkUrls(parseMarkdownBody(`www.a.com/x${'!'.repeat(300)}`))).toEqual([
      `http://www.a.com/x${'!'.repeat(44)}`,
    ])
  })
})
