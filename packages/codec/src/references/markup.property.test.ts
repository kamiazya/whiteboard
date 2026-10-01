import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { documentReferenceMarkup, referenceMarkup } from './markup.js'
import { scanReferences } from './scan.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

// The grammar's own delimiters are drawn as often as ordinary text. A sparse
// alphabet reaches `Arrays [0]` rarely and the property would pass without
// asking.
const UNIT = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('[', ']', '|', '#', '!', '\n', '\r', ' ', '\t') },
  { weight: 2, arbitrary: fc.constantFrom('日', '本', '語', 'é', '😀') },
  { weight: 4, arbitrary: fc.constantFrom('a', 'B', '0', '/', '-') },
)
const textArbitrary = fc.string({ unit: UNIT, maxLength: 12 })

const PLAIN_UNIT = fc.constantFrom('a', 'B', '0', ' ', '[', '日', '!')
const plainArbitrary = fc.string({ unit: PLAIN_UNIT, minLength: 1, maxLength: 12 })

describe('referenceMarkup, read back by the scanner', () => {
  fcTest.prop([textArbitrary, fc.option(textArbitrary, { nil: undefined })], withDefaults())(
    'is one reference with the written target and alias, or is refused',
    (target, alias) => {
      const markup = referenceMarkup({ target, alias })
      fc.pre(markup !== undefined)

      const found = scanReferences(markup as string)
      expect(found).toHaveLength(1)
      const [reference] = found
      expect(reference?.full).toBe(markup)
      expect(reference?.isEmbed).toBe(false)
      expect(reference?.fragment).toBeUndefined()
      expect(reference?.target).toBe(target)
      expect(reference?.alias).toBe(alias === '' ? undefined : alias)
    },
  )

  fcTest.prop([plainArbitrary, plainArbitrary], withDefaults())(
    'writes whatever holds no delimiter, so a refusal is never the lazy answer',
    (target, alias) => {
      expect(referenceMarkup({ target, alias })).toBeDefined()
    },
  )

  fcTest.prop([textArbitrary, textArbitrary], withDefaults())(
    'a refusal is real: the raw template for the same parts does not read back as them',
    (target, alias) => {
      fc.pre(alias !== '')
      // A line break is refused for the block structure the markdown around a
      // reference imposes, which a text-level scanner does not see.
      fc.pre(!/[\r\n]/.test(target + alias))
      fc.pre(referenceMarkup({ target, alias }) === undefined)

      const [reference, ...rest] = scanReferences(`[[${target}|${alias}]]`)
      const asWritten =
        rest.length === 0 &&
        reference?.full === `[[${target}|${alias}]]` &&
        reference.target === target &&
        reference.alias === alias
      expect(asWritten).toBe(false)
    },
  )

  fcTest.prop([textArbitrary, textArbitrary, textArbitrary], withDefaults())(
    'a document link is one reference to its path or id, labeled with the label, the name or nothing',
    (path, name, label) => {
      const markup = documentReferenceMarkup({ id: ID, path, name }, label)
      const found = scanReferences(markup)

      expect(found).toHaveLength(1)
      const [reference] = found
      expect(reference?.full).toBe(markup)
      expect([path, ID]).toContain(reference?.target)
      expect(reference?.fragment).toBeUndefined()
      const labels = label === '' ? [name, undefined] : [label, name, undefined]
      expect(labels).toContain(reference?.alias)
    },
  )
})

describe('documentReferenceMarkup', () => {
  // Counterexample the property found: the alias `]` closed the reference
  // early and left a literal `]` behind.
  it('writes a name holding a bracket as a bare path reference', () => {
    expect(
      documentReferenceMarkup({ id: ID, path: 'arrays', name: 'Arrays [0]' }, 'Arrays [0]'),
    ).toBe('[[arrays]]')
  })

  it('keeps an alias with an opening bracket, which the scanner reads as text', () => {
    expect(documentReferenceMarkup({ id: ID, path: 'arrays', name: 'Arrays [' }, 'Arrays [')).toBe(
      '[[arrays|Arrays []]',
    )
  })

  it('spells a path that reads as a different id by the id', () => {
    expect(documentReferenceMarkup({ id: ID, path: OTHER_ID, name: 'Shadowy' }, 'Shadowy')).toBe(
      `[[${ID}|Shadowy]]`,
    )
  })

  it('spells an unwritable path by the id', () => {
    expect(documentReferenceMarkup({ id: ID, path: 'a]b', name: 'A' })).toBe(`[[${ID}|A]]`)
  })
})
