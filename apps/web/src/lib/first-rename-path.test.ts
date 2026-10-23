// @vitest-environment node
import { documentPathSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { pathAfterFirstRename } from './first-rename-path.js'
import { isGeneratedPath, newDocumentPathIn } from './new-document-path.js'

describe('pathAfterFirstRename', () => {
  it('derives the address from the name while the path is still generated', () => {
    expect(pathAfterFirstRename('untitled', 'Checkout Architecture', ['untitled'])).toBe(
      'checkout-architecture',
    )
  })

  it('treats a numbered generated path the same way', () => {
    expect(pathAfterFirstRename('untitled-3', 'Roadmap', ['untitled-3'])).toBe('roadmap')
  })

  it('keeps the document in its folder', () => {
    expect(pathAfterFirstRename('design/untitled', 'Spec', ['design/untitled'])).toBe('design/spec')
  })

  it('numbers from -2 when a sibling already holds the address', () => {
    const taken = ['untitled', 'roadmap', 'roadmap-2']
    expect(pathAfterFirstRename('untitled', 'Roadmap', taken)).toBe('roadmap-3')
  })

  it('does not count the same name in another folder as a collision', () => {
    expect(pathAfterFirstRename('untitled', 'Roadmap', ['untitled', 'design/roadmap'])).toBe(
      'roadmap',
    )
  })

  it('leaves a path somebody chose alone', () => {
    expect(pathAfterFirstRename('checkout', 'Checkout Architecture', ['checkout'])).toBeNull()
  })

  it('leaves the path when the name has no address to give', () => {
    expect(pathAfterFirstRename('untitled', '設計メモ', ['untitled'])).toBeNull()
    expect(pathAfterFirstRename('untitled', '   ', ['untitled'])).toBeNull()
  })

  // "Untitled 2" derives `untitled-2`, which would read as generated and let
  // a second rename move the document again.
  it('does not hand back an address that still looks generated', () => {
    expect(pathAfterFirstRename('untitled', 'Untitled 2', ['untitled'])).toBeNull()
  })

  const nearGenerated = fc.oneof(
    fc.constant('untitled'),
    fc.integer({ min: 2, max: 30 }).map((n) => `untitled-${n}`),
  )
  fcTest.prop([nearGenerated, fc.string(), fc.array(fc.string())], withDefaults({ numRuns: 100 }))(
    'answers an address the grammar accepts that nothing else holds, and that no longer reads as generated',
    (path, name, others) => {
      const existing = [path, ...others]
      const next = pathAfterFirstRename(path, name, existing)
      if (next === null) return
      expect(documentPathSchema.safeParse(next).success).toBe(true)
      expect(existing).not.toContain(next)
      expect(isGeneratedPath(next)).toBe(false)
    },
  )
})

describe('isGeneratedPath', () => {
  it('accepts exactly what newDocumentPathIn produces', () => {
    const taken: string[] = []
    for (let i = 0; i < 15; i++) {
      const path = newDocumentPathIn('design', taken)
      taken.push(path)
      expect(isGeneratedPath(path), path).toBe(true)
    }
    expect(isGeneratedPath('untitled-1')).toBe(false)
    expect(isGeneratedPath('untitled-02')).toBe(false)
    expect(isGeneratedPath('my-untitled')).toBe(false)
  })
})
