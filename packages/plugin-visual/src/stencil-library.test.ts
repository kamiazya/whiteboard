// `visual.stencils/v0` — the facet a DOCUMENT carries to be a workspace's
// stencil library (ADR-0034 decision 4, authoring format settled 2026-09-11).
//
// A library is content: an ordinary OKF markdown document whose body says
// what the vocabulary is for, and whose facets hold the vocabulary itself.
// That means it is written with `wb_facet_set` and needs no new tool, no new
// document kind, and no new storage — and it syncs, versions and forks with
// the workspace the way every other document does.
import { createFacetRegistry, withWorkspaceStencils } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import {
  bundledFacetRegistry,
  readStencilLibrary,
  VISUAL_STENCILS_KEY,
  visualPlugin,
} from './index.js'

describe('the stencil-library facet', () => {
  it('attaches to a DOCUMENT, which is what a library is', () => {
    // Not a node and not a canvas. A library is not something one drawing
    // wears — it is a document other documents draw FROM.
    expect(bundledFacetRegistry.targetsOf(VISUAL_STENCILS_KEY)).toEqual(['document'])
  })

  it('accepts a vocabulary of stencils keyed by bare name', () => {
    const result = bundledFacetRegistry.validateFacetWrite(VISUAL_STENCILS_KEY, {
      stencils: {
        bucket: {
          displayName: 'Bucket',
          color: '5',
          facets: { 'visual.shape/v0': { kind: 'cylinder' } },
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a name that could not become an id, at the write rather than at the read', () => {
    // The registry composes `workspace.<name>`, so a name that is not a
    // segment yields an id every writer refuses — a stencil the library
    // lists and no drawing can wear.
    expect(
      bundledFacetRegistry.validateFacetWrite(VISUAL_STENCILS_KEY, {
        stencils: { 'Not A Name': { displayName: 'x' } },
      }).ok,
    ).toBe(false)
  })

  it('takes the model’s colour: a preset or a hex colour, and refuses anything else naming the presets', () => {
    const write = (color: string) =>
      bundledFacetRegistry.validateFacetWrite(VISUAL_STENCILS_KEY, {
        stencils: { box: { displayName: 'Box', color } },
      })
    expect(write('3').ok).toBe(true)
    expect(write('#00ffAA').ok).toBe(true)
    for (const bad of ['red', '7', '#fff']) {
      const result = write(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/"1" to "6"/)
    }
  })

  it('refuses a stencil carrying position or text, which decision 3 forbids', () => {
    // `stencilAssetSchema` is strict about its own shape, so the rule that a
    // stencil never says WHERE or WHAT IT SAYS is enforced on the way in
    // rather than by whoever applies it.
    expect(
      bundledFacetRegistry.validateFacetWrite(VISUAL_STENCILS_KEY, {
        stencils: { box: { displayName: 'Box', x: 10 } },
      }).ok,
    ).toBe(false)
  })

  it('offers no derived form, because a library is authored as a document', () => {
    // The honest `unsupported` signal rather than a half-rendered payload: a
    // record of records is outside the form vocabulary, and the affordance
    // for growing a vocabulary is editing the document, not an inspector row.
    expect(bundledFacetRegistry.facetForm(VISUAL_STENCILS_KEY).kind).toBe('unsupported')
  })
})

describe('reading a library off a document', () => {
  it('answers the stencils a document declares', () => {
    expect(
      readStencilLibrary({
        [VISUAL_STENCILS_KEY]: { stencils: { bucket: { displayName: 'Bucket' } } },
      }),
    ).toEqual({ bucket: { displayName: 'Bucket', facets: {} } })
  })

  it('answers nothing for a document that declares none, and for a payload the schema refuses', () => {
    // Degrade rather than throw, the same rule every resolver here follows:
    // a document that is not a library is the overwhelmingly common case,
    // and a malformed one must not stop a drawing being read.
    expect(readStencilLibrary({})).toEqual({})
    expect(readStencilLibrary({ [VISUAL_STENCILS_KEY]: { stencils: 'nope' } })).toEqual({})
  })

  it('leaves out only the stencil the schema refuses, so one bad entry does not hide the rest', () => {
    expect(
      readStencilLibrary({
        [VISUAL_STENCILS_KEY]: {
          stencils: {
            bucket: { displayName: 'Bucket' },
            bad: { displayName: 'Bad', color: 'red' },
            'Not A Name': { displayName: 'x' },
            placed: { displayName: 'Placed', x: 10 },
          },
        },
      }),
    ).toEqual({ bucket: { displayName: 'Bucket', facets: {} } })
  })

  it('carries no key at all for a refused stencil, not even one holding undefined', () => {
    // toEqual treats an undefined-valued key as absent, so the assertion above cannot tell a reader
    // that dropped the entry from one that kept it; what a caller is handed differs.
    const library = readStencilLibrary({
      [VISUAL_STENCILS_KEY]: {
        stencils: {
          bucket: { displayName: 'Bucket' },
          bad: { displayName: 'Bad', color: 'red' },
          'Not A Name': { displayName: 'x' },
          placed: { displayName: 'Placed', x: 10 },
        },
      },
    })
    expect(Object.keys(library)).toEqual(['bucket'])
    expect(library).toStrictEqual({ bucket: { displayName: 'Bucket', facets: {} } })
  })

  it('answers by name, because a library has no order that survives storage', () => {
    // A deployment's assets keep REGISTRATION order and that order means
    // something. A library's does not survive the round trip through the
    // document's CRDT map — measured, `ledger` came back before `lakehouse`
    // for a document authored the other way round — so a name sort is the
    // only order a caller can predict, and it is what makes two calls of
    // `wb_facet_list` agree.
    const library = readStencilLibrary({
      [VISUAL_STENCILS_KEY]: {
        stencils: {
          ledger: { displayName: 'Ledger' },
          bucket: { displayName: 'Bucket' },
          lakehouse: { displayName: 'Lakehouse' },
        },
      },
    })
    expect(Object.keys(library)).toEqual(['bucket', 'lakehouse', 'ledger'])
  })

  it('composes into a registry whose ids a drawing can wear', () => {
    const library = readStencilLibrary({
      [VISUAL_STENCILS_KEY]: {
        stencils: {
          bucket: {
            displayName: 'Bucket',
            color: '5',
            facets: { 'visual.shape/v0': { kind: 'cylinder' } },
          },
        },
      },
    })
    const registry = withWorkspaceStencils(createFacetRegistry([visualPlugin]), library)

    expect(registry.stencilAsset('workspace.bucket')?.color).toBe('5')
    expect(
      registry.validateFacetWrite('visual.stencil/v0', { stencil: 'workspace.bucket' }).ok,
    ).toBe(true)
  })
})

// What a library may hold is bounded, because it is recomposed into the
// registry on every read that resolves a stencil and its size is otherwise
// whatever was written or synced.
describe('the size of a stencil library', () => {
  const sized = (count: number) =>
    Object.fromEntries(
      Array.from(
        { length: count },
        (_, index) => [`s${String(index).padStart(4, '0')}`, { displayName: `S${index}` }] as const,
      ),
    )
  const write = (stencils: Record<string, unknown>) =>
    bundledFacetRegistry.validateFacetWrite(VISUAL_STENCILS_KEY, { stencils })

  it('accepts a library at the cap', () => {
    expect(write(sized(256)).ok).toBe(true)
  })

  it('refuses a library over the cap at the write, naming the cap and the count', () => {
    const result = write(sized(257))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/at most 256 stencils/)
    expect(result.message).toMatch(/257/)
  })

  it('refuses an oversized library by its count alone, before judging any entry', () => {
    // Judging every entry first would hand the author one issue per bad
    // stencil — tens of thousands of them in one message — and pay for
    // every parse before the refusal that was coming anyway.
    const bad = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`s${index}`, { displayName: 7 }] as const),
    )
    const result = write(bad)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/at most 256 stencils/)
    expect(result.message).not.toMatch(/displayName/)
  })

  it('reads only the first stencils by name when a stored library is over the cap', () => {
    // A library that arrived some other way than this write — a synced edit
    // — is read rather than refused, and what is read stays bounded.
    const library = readStencilLibrary({ [VISUAL_STENCILS_KEY]: { stencils: sized(300) } })
    const names = Object.keys(library)
    expect(names).toHaveLength(256)
    expect(names[0]).toBe('s0000')
    expect(names.at(-1)).toBe('s0255')
  })

  it('counts the cap over the stencils it keeps, so refused entries do not crowd out good ones', () => {
    const stencils = {
      ...Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`a${index}`, { displayName: '' }] as const),
      ),
      ...sized(256),
    }
    const library = readStencilLibrary({ [VISUAL_STENCILS_KEY]: { stencils } })
    expect(Object.keys(library)).toHaveLength(256)
    expect(Object.keys(library)[0]).toBe('s0000')
  })
})
