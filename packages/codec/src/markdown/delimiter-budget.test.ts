import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from './pipeline.js'

type Walked = { type: string; children?: Walked[] }

function countNodes(root: MdastRoot, type: string): number {
  let count = 0
  const stack: Walked[] = [root as Walked]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === type) count += 1
    stack.push(...(node.children ?? []))
  }
  return count
}

// One paragraph hands emphasis, strikethrough and link resolution at most
// 1,024 delimiter characters; past that they are text. `**b** ` spends four.
describe('parseMarkdownBody delimiter budget', () => {
  it('keeps every emphasis of a paragraph inside the budget', () => {
    expect(countNodes(parseMarkdownBody('**b** '.repeat(256)), 'strong')).toBe(256)
  })

  it('reads the delimiters past the budget as text', () => {
    const root = parseMarkdownBody('**b** '.repeat(300))
    expect(countNodes(root, 'strong')).toBe(256)
    expect(JSON.stringify(root)).toContain('**b** **b**')
  })

  it('gives each paragraph a budget of its own', () => {
    const paragraph = '**b** '.repeat(200)
    expect(countNodes(parseMarkdownBody(`${paragraph}\n\n${paragraph}`), 'strong')).toBe(400)
  })

  it('does not charge an underscore inside a word, which cannot emphasise', () => {
    const root = parseMarkdownBody(`${'snake_case_name '.repeat(2_000)}*kept*`)
    expect(countNodes(root, 'emphasis')).toBe(1)
  })

  it('charges each bracket of a closing pair once', () => {
    // Two `]` per wiki link: 800 of the 1,024, so the link after them forms.
    expect(countNodes(parseMarkdownBody(`${'[[a]] '.repeat(400)}[l](u)`), 'link')).toBe(1)
  })

  it('charges strikethrough and label ends to the same budget', () => {
    expect(countNodes(parseMarkdownBody(`${'a~ '.repeat(1_000)}[l](u)`), 'link')).toBe(1)
    expect(countNodes(parseMarkdownBody(`${'a] '.repeat(1_100)}[l](u)`), 'link')).toBe(0)
  })
})
