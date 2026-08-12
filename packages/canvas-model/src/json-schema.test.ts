// The committed schema under docs/reference/ is the published artifact of the
// extension contract; this test holds it byte-equal to what the Zod schemas
// generate. Regenerate deliberately with:
//   UPDATE_JSON_SCHEMA=1 pnpm vitest run --project canvas-model-node json-schema
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { xWhiteboardJsonSchema } from './json-schema.js'

const committedPath = fileURLToPath(
  new URL('../../../docs/reference/x-whiteboard.schema.json', import.meta.url),
)

describe('x-whiteboard JSON Schema artifact', () => {
  it('docs/reference/x-whiteboard.schema.json matches the model schemas', () => {
    const generated = `${JSON.stringify(xWhiteboardJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_JSON_SCHEMA === '1') writeFileSync(committedPath, generated)
    expect(readFileSync(committedPath, 'utf8')).toBe(generated)
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
