// `workspace` is reserved as a plugin id (ADR-0034's amendment).
//
// A document-backed stencil library resolves by composing a SYNTHETIC plugin
// carrying that workspace's own stencils, so their ids read
// `workspace.<name>`. The id has to be one no real plugin may take: today it
// is perfectly legal, and a deployment that took it would turn a rule into a
// startup crash (`createFacetRegistry` throws on a duplicate plugin id) at
// the moment a workspace first grew a library — far from the cause.
//
// Refused at DEFINITION, where the author is, rather than at registry build,
// where they are not.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineFacet, definePlugin } from './registry.js'

const aFacet = () =>
  defineFacet({
    name: 'thing',
    displayName: 'Thing',
    version: 'v0',
    targets: ['node'],
    schema: z.object({ value: z.string() }),
  })

describe('the reserved plugin namespace', () => {
  it('refuses a plugin that takes the workspace namespace, naming why', () => {
    expect(() =>
      definePlugin({ id: 'workspace', displayName: 'Workspace', facets: [aFacet()] }),
    ).toThrow(/reserved/)
  })

  it('leaves every other id alone, including ones that merely contain it', () => {
    // `workspace-index` is a real package name in this repo, so a plugin
    // named after one must not be caught by a substring check.
    for (const id of ['workspace-index', 'my-workspace', 'visual', 'infra']) {
      expect(() => definePlugin({ id, displayName: id, facets: [] })).not.toThrow()
    }
  })
})
