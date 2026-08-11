import { describe, expect, it } from 'vitest'
import { deriveDisplaySlug } from './derive-display-slug.js'

describe('deriveDisplaySlug', () => {
  it('slugifies a display name', () => {
    expect(deriveDisplaySlug('My Design Notes', [])).toBe('my-design-notes')
  })

  it('falls back to untitled when the name is absent or yields nothing sluggable', () => {
    expect(deriveDisplaySlug(undefined, [])).toBe('untitled')
    expect(deriveDisplaySlug('🎨✨', [])).toBe('untitled')
    expect(deriveDisplaySlug('   ', [])).toBe('untitled')
  })

  it('suffixes to avoid entries already taken', () => {
    expect(deriveDisplaySlug('My Design Notes', ['my-design-notes'])).toBe('my-design-notes-2')
    expect(deriveDisplaySlug('My Design Notes', ['my-design-notes', 'my-design-notes-2'])).toBe(
      'my-design-notes-3',
    )
  })

  it('degrades a non-latin name to untitled rather than mojibake', () => {
    expect(deriveDisplaySlug('設計メモ', [])).toBe('untitled')
  })

  it('collapses runs of separators and trims edge hyphens', () => {
    expect(deriveDisplaySlug('  --Weekly   sync!!  ', [])).toBe('weekly-sync')
  })
})
