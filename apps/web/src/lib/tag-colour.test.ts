import { parseScopedTag } from '@kamiazya/whiteboard-model'
import { tagLibraryObjection } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { libraryWithTagColour } from './tag-colour.js'

describe('libraryWithTagColour', () => {
  it('declares the colour on the value, creating the key when the library has none', () => {
    expect(libraryWithTagColour({}, 'kind:service', '5', [])).toEqual({
      kind: { values: { service: { color: '5' } } },
    })
  })

  it('keeps every value already in use admitted when it turns an open key into a declared one', () => {
    const next = libraryWithTagColour({}, 'kind:service', '5', [
      'kind:service',
      'kind:database',
      'health:ok',
      'draft',
    ])
    expect(next).toEqual({
      kind: { values: { service: { color: '5' }, database: {} } },
    })
    // The point of seeding: what the workspace already carries still passes
    // the library's own judgement.
    expect(tagLibraryObjection(next ?? {}, ['kind:service', 'kind:database'])).toBeUndefined()
  })

  it('keeps the key description, exclusivity and the other values untouched', () => {
    const library = {
      health: {
        description: 'serving?',
        exclusive: true,
        values: {
          ok: { color: '4' as const, description: 'fine' },
          failing: { color: '1' as const },
        },
      },
    }
    expect(libraryWithTagColour(library, 'health:failing', '2', [])).toEqual({
      health: {
        description: 'serving?',
        exclusive: true,
        values: { ok: { color: '4', description: 'fine' }, failing: { color: '2' } },
      },
    })
    expect(library.health.values.failing.color).toBe('1')
  })

  it('removes only the colour when the colour is cleared, keeping the value admitted', () => {
    const library = { health: { values: { ok: { color: '4' as const, description: 'fine' } } } }
    expect(libraryWithTagColour(library, 'health:ok', undefined, [])).toEqual({
      health: { values: { ok: { description: 'fine' } } },
    })
  })

  it('leaves the library as it was when clearing a colour nothing declared', () => {
    const library = { health: { values: { ok: { color: '4' as const } } } }
    expect(libraryWithTagColour(library, 'health:unknown', undefined, [])).toEqual(library)
    expect(libraryWithTagColour({}, 'kind:service', undefined, [])).toEqual({})
  })

  it('declines a plain tag, which the library has no place for', () => {
    expect(parseScopedTag('draft')).toBeUndefined()
    expect(libraryWithTagColour({}, 'draft', '5', [])).toBeUndefined()
  })
})
