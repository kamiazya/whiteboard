// The committed schema under docs/reference/ is the published artifact of the
// extension contract; this file-snapshot test holds it byte-equal to what the
// Zod schemas generate (CI fails on drift). Regenerate deliberately with:
//   pnpm vitest run --project model-node json-schema -u
import { describe, expect, it } from 'vitest'
import { EXTENSION_FACET_KEY_PATTERN } from './facets.js'
import { xWhiteboardJsonSchema } from './json-schema.js'

describe('x-whiteboard JSON Schema artifact', () => {
  it('docs/reference/x-whiteboard.schema.json matches the model schemas', async () => {
    const generated = `${JSON.stringify(xWhiteboardJsonSchema(), null, 2)}\n`
    await expect(generated).toMatchFileSnapshot('../../../docs/reference/x-whiteboard.schema.json')
  })

  it('describes both extension sites as draft 2020-12 definitions', () => {
    const schema = xWhiteboardJsonSchema()
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    const defs = schema.$defs as Record<string, Record<string, unknown>>
    expect(Object.keys(defs).sort()).toEqual(['canvasExtension', 'nodeExtension'])
    expect(defs.canvasExtension.type).toBe('object')
    // The node site is a UNION since ADR-0013: an embed variant and a
    // facets-only variant, each an object.
    const nodeVariants = defs.nodeExtension.anyOf as { type?: string }[]
    expect(nodeVariants).toHaveLength(2)
    for (const variant of nodeVariants) expect(variant.type).toBe('object')
    // Neither def re-declares a root `$schema` of its own.
    expect('$schema' in defs.canvasExtension).toBe(false)
    expect('$schema' in defs.nodeExtension).toBe(false)
  })

  it('the canvas facets bucket publishes the facet-key grammar, not any-string keys', () => {
    // extensionFacetsSchema enforces its key grammar in a superRefine, which
    // z.toJSONSchema cannot see — without the explicit injection the
    // published schema would accept keys the code rejects, drifting exactly
    // the way this artifact exists to prevent.
    const schema = xWhiteboardJsonSchema()
    const defs = schema.$defs as Record<string, Record<string, unknown>>
    const facets = (defs.canvasExtension.properties as Record<string, Record<string, unknown>>)
      .facets
    expect(facets).toBeDefined()
    const propertyNames = facets?.propertyNames as Record<string, unknown>
    expect(propertyNames.pattern).toBe(EXTENSION_FACET_KEY_PATTERN.source)
  })
})
