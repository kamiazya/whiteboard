// `visual.tags/v0` — the facet a DOCUMENT carries to be a workspace's TAG
// library (ADR-0040 decision 5's declared layer). Content, not
// configuration: an ordinary OKF markdown document at the workspace path
// `tags`, written with `wb_facet_set`, syncing and versioning with the
// workspace like every other document — the shape ADR-0034 fixed for
// stencils, with a vocabulary of KEYS in place of a vocabulary of stencils.
import { describe, expect, it } from 'vitest'
import {
  bundledFacetRegistry,
  readTagLibrary,
  tagLibraryObjection,
  VISUAL_TAGS_KEY,
} from './index.js'

describe('the tag-library facet', () => {
  it('attaches to a DOCUMENT, which is what a library is', () => {
    expect(bundledFacetRegistry.targetsOf(VISUAL_TAGS_KEY)).toEqual(['document'])
  })

  it('accepts keys with a description, exclusivity, and admitted values with a colour each', () => {
    const result = bundledFacetRegistry.validateFacetWrite(VISUAL_TAGS_KEY, {
      keys: {
        health: {
          description: 'Whether the component is serving',
          exclusive: true,
          values: { ok: { color: '4' }, failing: { color: '1', description: 'Paged' } },
        },
        // A key with no `values` admits any value; declaring it still
        // gives it a description and a place in the vocabulary.
        owner: { description: 'The team on call' },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a key or a value outside the scoped-tag grammar, at the write', () => {
    // `Health` could never be written as a tag (decision 1 refuses it), so a
    // library declaring it would describe a key nothing can carry.
    expect(
      bundledFacetRegistry.validateFacetWrite(VISUAL_TAGS_KEY, { keys: { Health: {} } }).ok,
    ).toBe(false)
    expect(
      bundledFacetRegistry.validateFacetWrite(VISUAL_TAGS_KEY, {
        keys: { health: { values: { OK: {} } } },
      }).ok,
    ).toBe(false)
  })

  it('refuses a colour outside the canvas palette and a field it does not know', () => {
    expect(
      bundledFacetRegistry.validateFacetWrite(VISUAL_TAGS_KEY, {
        keys: { health: { values: { ok: { color: 'green' } } } },
      }).ok,
    ).toBe(false)
    expect(
      bundledFacetRegistry.validateFacetWrite(VISUAL_TAGS_KEY, {
        keys: { health: { required: true } },
      }).ok,
    ).toBe(false)
  })

  it('offers no derived form, because a library is authored as a document', () => {
    expect(bundledFacetRegistry.facetForm(VISUAL_TAGS_KEY).kind).toBe('unsupported')
  })
})

describe('readTagLibrary', () => {
  it('answers the keys BY NAME with each key’s values by name, whatever order the bucket holds', () => {
    // A record round-trips through a CRDT map and comes back in the map's
    // own order; a name sort is the only order two reads can agree on.
    const library = readTagLibrary({
      [VISUAL_TAGS_KEY]: {
        keys: {
          tier: { values: { web: {}, db: { color: '2' } } },
          health: { exclusive: true, values: { ok: { color: '4' }, failing: { color: '1' } } },
        },
      },
    })
    expect(Object.keys(library)).toEqual(['health', 'tier'])
    expect(Object.keys(library.health?.values ?? {})).toEqual(['failing', 'ok'])
    expect(library.tier?.values?.db?.color).toBe('2')
  })

  it('answers no keys for a document that is not a library, or holds a malformed one', () => {
    // A drawing must stay readable when a document elsewhere in the
    // workspace is wrong; the write path is where a bad library is refused.
    expect(readTagLibrary(undefined)).toEqual({})
    expect(readTagLibrary({ 'visual.shape/v0': { kind: 'hexagon' } })).toEqual({})
    expect(readTagLibrary({ [VISUAL_TAGS_KEY]: { keys: { Health: {} } } })).toEqual({})
  })
})

describe('tagLibraryObjection', () => {
  // The one JUDGEMENT both writers share — the MCP write path's refusal and
  // the editor's tag row — as data, so each renders its own sentence.
  const library = {
    health: { exclusive: true, values: { ok: { color: '4' as const }, failing: {} } },
    region: { values: { eu: {}, us: {} } },
    owner: {},
  }

  it('objects to a value a key does not admit, naming the admitted ones sorted', () => {
    expect(tagLibraryObjection(library, ['health:degraded'])).toEqual({
      kind: 'undeclared',
      tag: 'health:degraded',
      key: 'health',
      admitted: ['failing', 'ok'],
    })
  })

  it('objects to a second value under an exclusive key, naming what would be carried', () => {
    expect(tagLibraryObjection(library, ['health:ok', 'health:failing'])).toEqual({
      kind: 'exclusive',
      key: 'health',
      carried: ['health:ok', 'health:failing'],
    })
  })

  it('does not object to a plain tag, an undeclared key, two values under a non-exclusive key, or an admitted value', () => {
    expect(
      tagLibraryObjection(library, [
        'draft',
        'phase:design',
        'region:eu',
        'region:us',
        'owner:me',
        'health:ok',
      ]),
    ).toBeUndefined()
  })
})
