import { documentPathSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { addressForNameIn } from './address-from-name.js'

describe('addressForNameIn', () => {
  it('makes the address from the name, accents spelled', () => {
    expect(addressForNameIn('', 'Équipe Ops', 'folder', [])).toBe('equipe-ops')
    expect(addressForNameIn('q3', 'Q3 hiring plan', 'markdown', [])).toBe('q3/q3-hiring-plan')
  })

  it('falls back to what the thing is when the name has no Latin spelling', () => {
    expect(addressForNameIn('', '概要', 'markdown', [])).toBe('note')
    expect(addressForNameIn('', '図', 'spatial', [])).toBe('canvas')
    expect(addressForNameIn('', '文献レビュー', 'folder', [])).toBe('folder')
  })

  it('numbers past a sibling document or a sibling folder holding the address', () => {
    expect(addressForNameIn('', '概要', 'markdown', ['note', 'note-2'])).toBe('note-3')
    expect(addressForNameIn('d', 'Plan', 'markdown', ['d/plan/inner'])).toBe('d/plan-2')
    expect(addressForNameIn('d', 'Plan', 'markdown', ['plan', 'e/plan'])).toBe('d/plan')
  })

  const nameArb = fc.string({
    unit: fc.constantFrom(...Array.from('aÉß概 -/.🚀1')),
    maxLength: 30,
  })
  const pathsArb = fc.array(fc.constantFrom('a', 'note', 'note-2', 'd/a', 'd/note', 'canvas'), {
    maxLength: 6,
  })

  fcTest.prop(
    [nameArb, fc.constantFrom('', 'd'), fc.constantFrom('markdown', 'spatial', 'folder'), pathsArb],
    withDefaults(),
  )('is always a valid path no sibling holds', (name, folder, kind, paths) => {
    const path = addressForNameIn(folder, name, kind as 'markdown', paths)
    expect(documentPathSchema.safeParse(path).success).toBe(true)
    expect(paths).not.toContain(path)
  })
})
