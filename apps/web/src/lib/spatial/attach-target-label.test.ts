import { groupNode, linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { attachTargetLabel } from './attach-target-label.js'

const at = { x: 0, y: 0, width: 100, height: 50 }

describe('attachTargetLabel', () => {
  it('names a text node by its first line of text', () => {
    expect(attachTargetLabel(textNode({ id: 'abcdef123', ...at, text: 'Second box\nmore' }))).toBe(
      "Attach to 'Second box'",
    )
  })

  it('names a group by its label', () => {
    expect(attachTargetLabel(groupNode({ id: 'g1', ...at, label: 'Tier' }))).toBe(
      "Attach to 'Tier'",
    )
  })

  it('clips a long name', () => {
    const label = attachTargetLabel(textNode({ id: 'x', ...at, text: 'w'.repeat(200) }))
    expect(label.length).toBeLessThan(70)
    expect(label.endsWith("…'")).toBe(true)
  })

  it('falls back to the kind and a short id when there is nothing to read', () => {
    expect(attachTargetLabel(textNode({ id: 'abcdef123456', ...at, text: '  ' }))).toBe(
      'Attach to text node abcdef',
    )
    expect(attachTargetLabel(groupNode({ id: 'zyxwvu9999', ...at }))).toBe('Attach to group zyxwvu')
    expect(attachTargetLabel(linkNode({ id: 'l1l1l1l1', ...at, url: 'https://e.com' }))).toBe(
      'Attach to link l1l1l1',
    )
  })
})
