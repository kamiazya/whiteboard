import { describe, expect, it } from 'vitest'
import { isSelfOrDescendant, pathBelow, rebasePath } from './document-path.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

describe('isSelfOrDescendant', () => {
  it('holds for the ancestor itself and for anything below it', () => {
    expect(isSelfOrDescendant('design', 'design')).toBe(true)
    expect(isSelfOrDescendant('design/x', 'design')).toBe(true)
    expect(isSelfOrDescendant('design/x/y', 'design')).toBe(true)
  })

  it('does not hold for a sibling that merely shares the ancestor as a prefix', () => {
    expect(isSelfOrDescendant('design-system', 'design')).toBe(false)
    expect(isSelfOrDescendant('design-v2/x', 'design')).toBe(false)
  })

  it('does not hold for an ancestor of the path', () => {
    expect(isSelfOrDescendant('design', 'design/x')).toBe(false)
  })
})

describe('rebasePath', () => {
  it('moves the root itself and everything below it', () => {
    expect(rebasePath('design', 'design', 'ui')).toBe('ui')
    expect(rebasePath('design/x', 'design', 'ui')).toBe('ui/x')
    expect(rebasePath('design/x/y', 'design', 'ui/deep')).toBe('ui/deep/x/y')
  })

  it('leaves a sibling that shares the prefix, and an unrelated path, where they are', () => {
    expect(rebasePath('design-system/x', 'design', 'ui')).toBe('design-system/x')
    expect(rebasePath('other', 'design', 'ui')).toBe('other')
    expect(rebasePath('design', 'design/x', 'ui')).toBe('design')
  })
})

describe('pathBelow', () => {
  it('answers what is left of a path once its folder is dropped', () => {
    expect(pathBelow('design', 'design/x')).toBe('x')
    expect(pathBelow('design', 'design/x/y')).toBe('x/y')
  })

  it('answers undefined for the folder itself, a sibling sharing the prefix, and an ancestor', () => {
    expect(pathBelow('design', 'design')).toBeUndefined()
    expect(pathBelow('design', 'design-system/x')).toBeUndefined()
    expect(pathBelow('design/x', 'design')).toBeUndefined()
    expect(pathBelow('design', 'other/x')).toBeUndefined()
  })

  it('treats the empty folder as the workspace root, which holds every path', () => {
    expect(pathBelow('', 'design/x')).toBe('design/x')
    expect(pathBelow('', 'readme')).toBe('readme')
  })

  // Small mixed alphabet so a folder is often a prefix of a path, and often a
  // prefix that stops mid-segment — the case the boundary exists for.
  const segmentArbitrary = fc.stringMatching(/^[aAb0]([aAb0-]*[aAb0])?$/)
  const pathArbitrary = fc
    .array(segmentArbitrary, { minLength: 1, maxLength: 4 })
    .map((segments) => segments.join('/'))

  fcTest.prop([pathArbitrary, pathArbitrary], withDefaults())(
    'is defined exactly when the path is strictly inside the folder, and agrees with rebasePath',
    (folder, path) => {
      const below = pathBelow(folder, path)
      expect(below !== undefined).toBe(path !== folder && isSelfOrDescendant(path, folder))
      if (below === undefined) return
      expect(`${folder}/${below}`).toBe(path)
      expect(rebasePath(path, folder, 'moved')).toBe(`moved/${below}`)
    },
  )
})
