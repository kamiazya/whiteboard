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
    // One run of 1,000 tildes is one walk, so only the count can run out.
    // Not at the start of a line, where it would open a code fence.
    const tildes = `a${'~'.repeat(1_000)}`
    expect(countNodes(parseMarkdownBody(`${tildes} ${'a] '.repeat(20)}[l](u)`), 'link')).toBe(1)
    expect(countNodes(parseMarkdownBody(`${tildes} ${'a] '.repeat(30)}[l](u)`), 'link')).toBe(0)
  })

  // Each delimiter is also charged the events it may walk back over, and a
  // run's walks are capped: here an escape writes six, so a delimiter after
  // these 30,000 is charged about 180,000 and the cap holds five.
  const escapes = '\\*'.repeat(30_000)

  it('keeps the emphasis of a run whose walks fit the cap', () => {
    expect(countNodes(parseMarkdownBody(`${escapes}${' a*'.repeat(2)} *a*`), 'emphasis')).toBe(1)
  })

  it('reads the delimiters past the walk cap as text', () => {
    expect(countNodes(parseMarkdownBody(`${escapes}${' a*'.repeat(8)} *a*`), 'emphasis')).toBe(0)
  })
})
