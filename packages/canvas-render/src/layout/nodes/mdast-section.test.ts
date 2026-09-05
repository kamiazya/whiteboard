import type { MdastFlowContent, MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { selectMarkdownSection } from './mdast-section.js'

const h = (depth: 1 | 2 | 3, text: string): MdastFlowContent => ({
  type: 'heading',
  depth,
  children: [{ type: 'text', value: text }],
})
const p = (text: string): MdastFlowContent => ({
  type: 'paragraph',
  children: [{ type: 'text', value: text }],
})

const root: MdastRoot = {
  type: 'root',
  children: [
    p('intro'),
    h(2, 'Plan'),
    p('plan body'),
    h(3, 'Detail'),
    p('detail body'),
    h(2, 'Launch'),
    p('launch body'),
    h(1, 'Appendix'),
    p('appendix body'),
  ],
}

const texts = (section: MdastRoot | undefined) =>
  section?.children.map((child) =>
    child.type === 'paragraph' || child.type === 'heading'
      ? child.children.map((c) => ('value' in c ? c.value : '')).join('')
      : child.type,
  )

describe('selectMarkdownSection', () => {
  it('runs from the heading to the next heading of the same or shallower depth', () => {
    expect(texts(selectMarkdownSection(root, 'Plan'))).toEqual([
      'Plan',
      'plan body',
      'Detail',
      'detail body',
    ])
    expect(texts(selectMarkdownSection(root, 'Detail'))).toEqual(['Detail', 'detail body'])
    expect(texts(selectMarkdownSection(root, 'Appendix'))).toEqual(['Appendix', 'appendix body'])
  })

  it('matches the heading text case-insensitively when nothing matches exactly', () => {
    expect(texts(selectMarkdownSection(root, 'launch'))).toEqual(['Launch', 'launch body'])
  })

  it('an unknown or empty fragment selects nothing', () => {
    expect(selectMarkdownSection(root, 'Nowhere')).toBeUndefined()
    expect(selectMarkdownSection(root, ' ')).toBeUndefined()
  })

  it('a paragraph spelling the fragment is not a heading', () => {
    expect(selectMarkdownSection(root, 'intro')).toBeUndefined()
  })
})
