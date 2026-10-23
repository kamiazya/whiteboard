// @vitest-environment node
import { documentPathSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { planLinkTarget } from './link-target-plan.js'

describe('planLinkTarget', () => {
  it('gives the text the address the first rename would, and the text as the name', () => {
    expect(planLinkTarget('Lecture 6 notes', 'week-1', ['week-1'])).toEqual({
      path: 'lecture-6-notes',
      name: 'Lecture 6 notes',
      markup: '[[lecture-6-notes|Lecture 6 notes]]',
    })
  })

  it('numbers from -2 when the address is taken', () => {
    const plan = planLinkTarget('Rollback', 'a', ['a', 'rollback', 'rollback-2'])
    expect(plan?.path).toBe('rollback-3')
    expect(plan?.markup).toBe('[[rollback-3|Rollback]]')
  })

  it('creates beside the linking document', () => {
    expect(planLinkTarget('Spec', 'design/overview', ['design/overview'])?.path).toBe('design/spec')
    expect(planLinkTarget('Spec', 'design/overview', ['design/spec'])?.path).toBe('design/spec-2')
  })

  it('keeps text that is already an address, and still names the document', () => {
    expect(planLinkTarget('rollback', 'a', ['a'])).toEqual({
      path: 'rollback',
      name: 'rollback',
      markup: '[[rollback]]',
    })
  })

  it('keeps a typed folder and derives only the last segment', () => {
    const plan = planLinkTarget('notes/Q3 plan', 'a', ['a'])
    expect(plan?.path).toBe('notes/q3-plan')
    expect(plan?.name).toBe('Q3 plan')
  })

  it('falls back to a generated address for a name with none to give', () => {
    const plan = planLinkTarget('設計メモ', 'a', ['a', 'untitled'])
    expect(plan?.path).toBe('untitled-2')
    expect(plan?.name).toBe('設計メモ')
    expect(plan?.markup).toBe('[[untitled-2|設計メモ]]')
  })

  it('offers nothing for empty text', () => {
    expect(planLinkTarget('   ', 'a', [])).toBeNull()
  })

  it('always yields a valid document path', () => {
    for (const text of ['A b', 'x/y z', 'My Folder/Item', 'ÅÄÖ', '!!!', 'a--b']) {
      const plan = planLinkTarget(text, 'f/own', ['f/own'])
      expect(documentPathSchema.safeParse(plan?.path).success).toBe(true)
    }
  })
})
