import { describe, expect, it } from 'vitest'
import { deriveCopyName, deriveCopyPath } from './derive-copy.js'
import {
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_PATH_MAX_LENGTH,
  documentNameSchema,
  documentPathSchema,
} from './ids.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

/** No lone surrogate: `String.prototype.isWellFormed` is past this package's ES2022 lib. */
const isWellFormed = (text: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

describe('deriveCopyName', () => {
  it('appends " (copy)" when no collision exists', () => {
    expect(deriveCopyName('Diagram', [])).toBe('Diagram (copy)')
  })

  it('appends " (copy 2)" when "(copy)" is already taken', () => {
    expect(deriveCopyName('Diagram', ['Diagram (copy)'])).toBe('Diagram (copy 2)')
  })

  it('keeps incrementing past multiple existing numbered copies', () => {
    expect(
      deriveCopyName('Diagram', ['Diagram (copy)', 'Diagram (copy 2)', 'Diagram (copy 3)']),
    ).toBe('Diagram (copy 4)')
  })

  it('does not collide with an unrelated numbered copy of a different base name', () => {
    expect(deriveCopyName('Diagram', ['Sketch (copy)', 'Sketch (copy 2)'])).toBe('Diagram (copy)')
  })

  it('fills a gap left by a renamed or deleted numbered copy rather than picking max+1', () => {
    expect(deriveCopyName('Diagram', ['Diagram (copy)', 'Diagram (copy 3)'])).toBe(
      'Diagram (copy 2)',
    )
  })

  it('accepts a Set as well as an array for existing names', () => {
    expect(deriveCopyName('Diagram', new Set(['Diagram (copy)']))).toBe('Diagram (copy 2)')
  })

  it('shortens a name at the bound so the copy still fits it', () => {
    const copy = deriveCopyName('x'.repeat(DOCUMENT_NAME_MAX_LENGTH), [])
    expect(copy).toHaveLength(DOCUMENT_NAME_MAX_LENGTH)
    expect(copy.endsWith(' (copy)')).toBe(true)
  })

  it('never splits a surrogate pair when it shortens', () => {
    const copy = deriveCopyName('😀'.repeat(DOCUMENT_NAME_MAX_LENGTH / 2), [])
    expect(isWellFormed(copy)).toBe(true)
  })
})

describe('deriveCopyPath', () => {
  it('puts the copy beside its source, inside the same folder', () => {
    expect(deriveCopyPath('notes/roadmap', [])).toBe('notes/roadmap-copy')
  })

  it('appends "-copy-2" when "-copy" is already taken', () => {
    expect(deriveCopyPath('diagram', ['diagram-copy'])).toBe('diagram-copy-2')
  })

  it('keeps incrementing past multiple existing numbered copies', () => {
    expect(deriveCopyPath('diagram', ['diagram-copy', 'diagram-copy-2', 'diagram-copy-3'])).toBe(
      'diagram-copy-4',
    )
  })

  it('does not collide with an unrelated numbered copy of a different base path', () => {
    expect(deriveCopyPath('diagram', ['sketch-copy', 'sketch-copy-2'])).toBe('diagram-copy')
  })

  it('shortens only the last segment of a path at the bound, never leaving a doubled hyphen', () => {
    const folder = 'a'.repeat(500)
    // The cut for "-copy" lands just after the hyphen in the leaf.
    const leaf = `${'b'.repeat(517)}-ccccc`
    expect(`${folder}/${leaf}`).toHaveLength(DOCUMENT_PATH_MAX_LENGTH)
    const copy = deriveCopyPath(`${folder}/${leaf}`, [])
    expect(copy).toBe(`${folder}/${'b'.repeat(517)}-copy`)
    expect(documentPathSchema.safeParse(copy).success).toBe(true)
  })

  it('answers null when the folder leaves no room for a copy beside the source', () => {
    const folder = 'a'.repeat(DOCUMENT_PATH_MAX_LENGTH - 3)
    expect(deriveCopyPath(`${folder}/b`, [])).toBeNull()
  })
})

/**
 * Names and paths drawn AT their bounds as often as below them: a base well
 * under the bound never reaches the truncation, so a generator of ordinary
 * lengths would pass with the truncation deleted.
 */
const nameBase = fc
  .integer({ min: DOCUMENT_NAME_MAX_LENGTH - 12, max: DOCUMENT_NAME_MAX_LENGTH })
  .chain((length) =>
    fc.string({
      unit: fc.constantFrom('a', ' ', '-', '😀', 'é'),
      minLength: length,
      maxLength: length,
    }),
  )
  .map((raw) => raw.slice(0, DOCUMENT_NAME_MAX_LENGTH))
  .filter((name) => documentNameSchema.safeParse(name).success)

const segmentUnit = fc.constantFrom('a', 'Z', '7', '-')
const segment = (length: number) =>
  fc
    .string({ unit: segmentUnit, minLength: length, maxLength: length })
    .map((raw) => `a${raw.slice(1, -1)}${length > 1 ? 'z' : ''}`.slice(0, length))

/** A folder long enough to crowd the leaf, then a leaf filling what is left. */
const pathBase = fc
  .tuple(
    fc.integer({ min: 0, max: DOCUMENT_PATH_MAX_LENGTH - 20 }),
    fc.integer({ min: 0, max: 12 }),
  )
  .chain(([folderLength, slack]) => {
    const leafLength = Math.max(1, DOCUMENT_PATH_MAX_LENGTH - folderLength - 1 - slack)
    return fc.tuple(
      folderLength === 0 ? fc.constant('') : segment(folderLength),
      segment(leafLength),
    )
  })
  .map(([folder, leaf]) => (folder === '' ? leaf : `${folder}/${leaf}`))
  .filter((path) => documentPathSchema.safeParse(path).success)

/** Up to a handful of earlier copies, so the `-N` / `(copy N)` suffixes are reached too. */
const takenCount = fc.integer({ min: 0, max: 12 })

describe('copies stay inside the bounds their schemas hold', () => {
  fcTest.prop([nameBase, takenCount], withDefaults())(
    'a copy of any writable name is a writable name, through every numbered suffix',
    (base, taken) => {
      const existing: string[] = []
      for (let i = 0; i <= taken; i += 1) {
        const copy = deriveCopyName(base, existing)
        expect(documentNameSchema.safeParse(copy).success).toBe(true)
        expect(isWellFormed(copy)).toBe(true)
        expect(existing).not.toContain(copy)
        existing.push(copy)
      }
    },
  )

  fcTest.prop([pathBase, takenCount], withDefaults())(
    'a copy of any valid path is a valid path beside it, through every numbered suffix',
    (base, taken) => {
      const existing: string[] = [base]
      const folder = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
      for (let i = 0; i <= taken; i += 1) {
        const copy = deriveCopyPath(base, existing)
        if (copy === null) {
          // Only a folder that leaves less room than the shortest copy segment.
          expect(folder.length + '0-copy-99'.length).toBeGreaterThan(DOCUMENT_PATH_MAX_LENGTH)
          return
        }
        expect(documentPathSchema.safeParse(copy).success).toBe(true)
        expect(copy.startsWith(folder)).toBe(true)
        expect(existing).not.toContain(copy)
        existing.push(copy)
      }
    },
  )
})
