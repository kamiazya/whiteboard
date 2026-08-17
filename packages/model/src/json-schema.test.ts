// The committed schema under docs/reference/ is the published artifact of the
// extension contract; this file-snapshot test holds it byte-equal to what the
// Zod schemas generate (CI fails on drift). Regenerate deliberately with:
//   pnpm vitest run --project model-node json-schema -u
import { describe, expect, it } from 'vitest'
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
    expect(defs.nodeExtension.type).toBe('object')
    // Neither def re-declares a root `$schema` of its own.
    expect('$schema' in defs.canvasExtension).toBe(false)
    expect('$schema' in defs.nodeExtension).toBe(false)
  })
})
