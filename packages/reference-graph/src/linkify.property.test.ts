/**
 * What `linkMarkupFor` writes is read back by the codec's own scanner as ONE
 * reference to the intended document, whatever the document is named. The
 * scanner is the grammar's reader, so it — not a re-statement of its rules —
 * is the oracle.
 */

import { scanReferences } from '@kamiazya/whiteboard-codec'
import { fc, fcTest, withDefaults } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { linkMarkupFor } from './linkify.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

// The characters the grammar assigns a meaning to, drawn as often as the
// ordinary ones: a sparse alphabet reaches `Arrays [0]` once in a blue moon
// and the property passes without ever asking.
const UNIT = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('[', ']', '|', '#', '!', '\n', '\r', ' ', '\t') },
  { weight: 2, arbitrary: fc.constantFrom('日', '本', '語', 'é', '😀') },
  { weight: 5, arbitrary: fc.constantFrom('a', 'B', 'c', '0', '1', '/', '-', '_') },
)
const nameArbitrary = fc.string({ unit: UNIT, minLength: 1, maxLength: 14 })
const pathArbitrary = fc.string({ unit: UNIT, minLength: 1, maxLength: 14 })

const plainArbitrary = fc.string({
  unit: fc.constantFrom('a', 'B', 'c', '0', '1', ' ', '[', '日', '本'),
  minLength: 1,
  maxLength: 14,
})

describe('linkMarkupFor, read back by the scanner', () => {
  fcTest.prop([pathArbitrary, nameArbitrary], withDefaults())(
    'is one reference to the path or the id, never a truncated one',
    (path, name) => {
      const markup = linkMarkupFor({ documentId: ID, path, name })
      const found = scanReferences(markup)

      expect(found).toHaveLength(1)
      const [reference] = found
      expect(reference?.full).toBe(markup)
      expect(reference?.isEmbed).toBe(false)
      expect(reference?.fragment).toBeUndefined()
      expect([path, ID]).toContain(reference?.target)
      // An alias is the name or nothing: a truncated name is a corrupted one.
      expect([name, undefined]).toContain(reference?.alias)
    },
  )

  it('writes a name with a bracket in it as the bare reference, not a truncated one', () => {
    const markup = linkMarkupFor({ documentId: ID, path: 'arrays', name: 'Arrays [0]' })

    expect(scanReferences(markup)).toMatchObject([{ full: markup, target: 'arrays' }])
  })

  fcTest.prop([plainArbitrary, plainArbitrary], withDefaults())(
    'keeps both the path and the name when neither needs any care',
    (path, name) => {
      const [reference] = scanReferences(linkMarkupFor({ documentId: ID, path, name }))

      expect(reference?.target).toBe(path)
      // A label that repeats the path says nothing the bare reference does not.
      expect(reference?.alias).toBe(name === path ? undefined : name)
    },
  )
})
