import { describe, expect, it } from 'vitest'
import { deriveWorkspaceSegment } from './derive-workspace-segment.js'
import { WORKSPACE_DISPLAY_NAME_MAX_LENGTH, workspaceSegmentSchema } from './ids.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

/**
 * Dense on the arrangements this function is ABOUT: dashes, spaces and other
 * punctuation at the edges and in runs. `fc.string()` reaches them only by
 * accident, which is how a property ends up passing without ever meeting its
 * subject.
 */
const nameArb = fc.string({
  unit: fc.constantFrom(...'ab1 -_/.。 '.split('')),
  maxLength: 24,
})

describe('deriveWorkspaceSegment', () => {
  it('lowercases and joins words with a single dash', () => {
    expect(deriveWorkspaceSegment('Marketing Team')).toBe('marketing-team')
  })

  it('collapses a RUN of non-alphanumerics to one dash, never several', () => {
    expect(deriveWorkspaceSegment('Marketing   ///   Team')).toBe('marketing-team')
  })

  it('trims the dash a leading or trailing run would otherwise leave', () => {
    expect(deriveWorkspaceSegment('  Studio  ')).toBe('studio')
    expect(deriveWorkspaceSegment('---Studio---')).toBe('studio')
  })

  it('answers undefined for a name the segment charset cannot spell', () => {
    // Absent is a real answer, not a failure to try: ADR-0019 addresses such a
    // workspace by its canonical id rather than by a mangled approximation.
    expect(deriveWorkspaceSegment('設計チーム')).toBeUndefined()
    expect(deriveWorkspaceSegment('---')).toBeUndefined()
    expect(deriveWorkspaceSegment('')).toBeUndefined()
  })

  it('transliterates Latin diacritics rather than dropping the letter', () => {
    expect(deriveWorkspaceSegment('Équipe Ops')).toBe('equipe-ops')
    expect(deriveWorkspaceSegment('Café Müller')).toBe('cafe-muller')
    expect(deriveWorkspaceSegment('İstanbul')).toBe('istanbul')
  })

  it('spells the Latin letters that carry no combining mark', () => {
    expect(deriveWorkspaceSegment('Straße')).toBe('strasse')
    expect(deriveWorkspaceSegment('Æsir Œuvre')).toBe('aesir-oeuvre')
    expect(deriveWorkspaceSegment('Ørsted Łódź')).toBe('orsted-lodz')
  })

  it('folds full-width and ligature forms to their ASCII letters', () => {
    expect(deriveWorkspaceSegment('Ｑ３ ﬁles')).toBe('q3-files')
  })

  it('stays inside the segment bound when a letter spells as two', () => {
    const segment = deriveWorkspaceSegment('ß'.repeat(WORKSPACE_DISPLAY_NAME_MAX_LENGTH))
    expect(segment).toBe('s'.repeat(WORKSPACE_DISPLAY_NAME_MAX_LENGTH))
  })

  /**
   * Accented Latin, the table's letters, CJK, emoji and separators, so the
   * mark-stripping, the table and the fallback to absent are each reached.
   */
  const wideNameArb = fc.string({
    unit: fc.constantFrom(...Array.from('aÉüßæØİﬁＡ1 -/.。設🚀'), 'e\u0301'),
    maxLength: 260,
  })

  fcTest.prop([wideNameArb], withDefaults())(
    'a derived segment is never empty, always a segment, and derives to itself',
    (displayName) => {
      const segment = deriveWorkspaceSegment(displayName)
      if (segment === undefined) return
      expect(segment).not.toBe('')
      expect(workspaceSegmentSchema.safeParse(segment).success).toBe(true)
      expect(segment).toMatch(/^[a-z0-9-]+$/)
      expect(deriveWorkspaceSegment(segment)).toBe(segment)
    },
  )

  fcTest.prop([nameArb], withDefaults())(
    'never yields a leading, trailing or doubled dash',
    (displayName) => {
      const segment = deriveWorkspaceSegment(displayName)
      if (segment === undefined) return
      expect(segment.startsWith('-')).toBe(false)
      expect(segment.endsWith('-')).toBe(false)
      expect(segment.includes('--')).toBe(false)
    },
  )

  // The trims are written `^-` and `-$` rather than `^-+` and `-+$`, because
  // the collapse above already guarantees at most ONE dash can be leading or
  // trailing. These two pin that the narrower form is not a behaviour change:
  // it is the same function, stated without the claim that a RUN might be
  // there.
  //
  // The wider form made that claim, and a reader of it was right to worry —
  // `-+$` over a string that may hold a long run is the shape CodeQL reports
  // as polynomial backtracking, on a name that arrives in a request body.
  fcTest.prop([nameArb], withDefaults({ numRuns: 500 }))(
    'the narrow trim and the wider one it replaced produce the same candidate',
    (displayName) => {
      const collapsed = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      expect(collapsed.replace(/^-/, '').replace(/-$/, '')).toBe(collapsed.replace(/^-+|-+$/g, ''))
    },
  )

  fcTest.prop([nameArb], withDefaults({ numRuns: 500 }))(
    'and the whole derivation answers what the wider pipeline answered',
    (displayName) => {
      const wider = displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      expect(deriveWorkspaceSegment(displayName)).toBe(
        workspaceSegmentSchema.safeParse(wider).success ? wider : undefined,
      )
    },
  )
})
