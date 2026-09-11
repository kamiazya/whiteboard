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
