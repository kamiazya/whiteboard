import { deriveFacetForm } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bundledFacetRegistry, VISUAL_AXES_MAX, visualPlugin } from './data.js'

// The simple visual facets are generated from `contracts/facets/visual`. What
// a generated schema must keep is what a reader can observe of the
// hand-written one: which payloads parse and to what, the code, message and
// path of every refusal, the JSON Schema `wb_facet_list` publishes, and the
// form the facet panel derives. A facet's own spelling of a refusal is the
// behaviour, so each case names it in full.

const schemaOf = (name: string): z.ZodTypeAny => {
  const facet = visualPlugin.facets.find((f) => f.name === name)
  if (facet === undefined) throw new Error(`visual declares no facet named ${name}`)
  return facet.schema
}

const issuesOf = (schema: z.ZodTypeAny, value: unknown) => {
  const result = schema.safeParse(value)
  return result.success
    ? []
    : result.error.issues.map(({ code, message, path }) => ({ code, message, path }))
}

const option = (...values: string[]) => ({
  code: 'invalid_value',
  message: `Invalid option: expected one of ${values.map((v) => `"${v}"`).join('|')}`,
})
const SHAPES = ['ellipse', 'diamond', 'hexagon', 'parallelogram', 'cylinder', 'octagon']
const ROUTINGS = ['straight', 'orthogonal', 'curved']
const missingString = {
  code: 'invalid_type',
  message: 'Invalid input: expected string, received undefined',
}
const ID_REFUSAL = {
  code: 'invalid_format',
  message: 'must be a namespaced id like "visual.diamond"',
}
const KEY_REFUSAL = {
  code: 'invalid_format',
  message: 'must be a facet key like "visual.shape/v0"',
}

const fieldIssue = (base: object, ...path: PropertyKey[]) => ({ ...base, path })

describe('visual.shape', () => {
  const schema = schemaOf('shape')

  it('takes each silhouette and strips what it does not name', () => {
    for (const kind of SHAPES) expect(schema.parse({ kind, extra: 1 })).toEqual({ kind })
  })

  it('refuses rect, which is the absent facet, a missing kind and a non-string one', () => {
    const refusal = [fieldIssue(option(...SHAPES), 'kind')]
    expect(issuesOf(schema, { kind: 'rect' })).toEqual(refusal)
    expect(issuesOf(schema, {})).toEqual(refusal)
    expect(issuesOf(schema, { kind: 3 })).toEqual(refusal)
  })

  it('refuses a payload that is not an object, at the root', () => {
    expect(issuesOf(schema, null)).toEqual([
      { code: 'invalid_type', message: 'Invalid input: expected object, received null', path: [] },
    ])
    expect(issuesOf(schema, [])).toEqual([
      { code: 'invalid_type', message: 'Invalid input: expected object, received array', path: [] },
    ])
  })
})

describe('visual.text', () => {
  const schema = schemaOf('text')

  it('takes both placements and strips the rest', () => {
    expect(schema.parse({ align: 'start', x: 1 })).toEqual({ align: 'start' })
    expect(schema.parse({ align: 'center' })).toEqual({ align: 'center' })
  })

  it('refuses a third value and an absent one', () => {
    const refusal = [fieldIssue(option('start', 'center'), 'align')]
    expect(issuesOf(schema, { align: 'end' })).toEqual(refusal)
    expect(issuesOf(schema, {})).toEqual(refusal)
  })
})

describe('visual.edges', () => {
  const schema = schemaOf('edges')

  it('takes either field, both, or none, and strips the rest', () => {
    expect(schema.parse({})).toEqual({})
    expect(schema.parse({ lineJumps: 'none' })).toEqual({ lineJumps: 'none' })
    expect(schema.parse({ routing: 'curved', lineJumps: 'arc', x: 1 })).toEqual({
      routing: 'curved',
      lineJumps: 'arc',
    })
    for (const routing of ROUTINGS) expect(schema.parse({ routing })).toEqual({ routing })
  })

  it('refuses a routing or a jump setting outside the model vocabulary', () => {
    expect(issuesOf(schema, { routing: 'zig' })).toEqual([
      fieldIssue(option(...ROUTINGS), 'routing'),
    ])
    expect(issuesOf(schema, { lineJumps: 1 })).toEqual([
      fieldIssue(option('none', 'arc'), 'lineJumps'),
    ])
  })
})

describe('visual.ink', () => {
  const schema = schemaOf('ink')

  it('takes a group id and strips the rest', () => {
    expect(schema.parse({ group: 'g', y: 1 })).toEqual({ group: 'g' })
  })

  it('refuses an empty id, a missing one and a non-string one', () => {
    expect(issuesOf(schema, { group: '' })).toEqual([
      {
        code: 'too_small',
        message: 'Too small: expected string to have >=1 characters',
        path: ['group'],
      },
    ])
    expect(issuesOf(schema, {})).toEqual([fieldIssue(missingString, 'group')])
    expect(issuesOf(schema, { group: 1 })).toEqual([
      fieldIssue(
        { code: 'invalid_type', message: 'Invalid input: expected string, received number' },
        'group',
      ),
    ])
  })
})

describe('visual.stroke', () => {
  const schema = schemaOf('stroke')

  it('takes the two stored weights and strips the rest', () => {
    expect(schema.parse({ width: 'thick', z: 1 })).toEqual({ width: 'thick' })
    expect(schema.parse({ width: 'medium' })).toEqual({ width: 'medium' })
  })

  it('refuses thin, which is the absent facet, and a missing width', () => {
    const refusal = [fieldIssue(option('medium', 'thick'), 'width')]
    expect(issuesOf(schema, { width: 'thin' })).toEqual(refusal)
    expect(issuesOf(schema, {})).toEqual(refusal)
  })
})

describe.each([
  ['theme', 'theme'],
  ['stencil', 'stencil'],
] as const)('visual.%s', (name, field) => {
  const schema = schemaOf(name)

  it('takes a namespaced id and strips the rest', () => {
    expect(schema.parse({ [field]: 'visual.sketch', k: 1 })).toEqual({ [field]: 'visual.sketch' })
    expect(schema.parse({ [field]: 'a-b.c-d' })).toEqual({ [field]: 'a-b.c-d' })
  })

  it('refuses an id that is not <plugin>.<name> with the grammar named in the message', () => {
    for (const bad of ['Visual.sketch', 'sketch', 'a.b.c', '1a.b', 'a.b\n', 'a.', '.b', '']) {
      expect(issuesOf(schema, { [field]: bad })).toEqual([fieldIssue(ID_REFUSAL, field)])
    }
  })

  it('refuses a missing id and a non-string one', () => {
    expect(issuesOf(schema, {})).toEqual([fieldIssue(missingString, field)])
    expect(issuesOf(schema, { [field]: 1 })).toEqual([
      fieldIssue(
        { code: 'invalid_type', message: 'Invalid input: expected string, received number' },
        field,
      ),
    ])
  })
})

describe('visual.axes', () => {
  const schema = schemaOf('axes')
  const keys = (count: number) => Array.from({ length: count }, () => 'a.b/v0')

  it('takes a list of facet keys, however short, and strips the rest', () => {
    expect(schema.parse({ axes: [] })).toEqual({ axes: [] })
    expect(schema.parse({ axes: ['visual.shape/v0', 'a.b/v12'], x: 1 })).toEqual({
      axes: ['visual.shape/v0', 'a.b/v12'],
    })
  })

  it('refuses a key outside the facet-key grammar at its index', () => {
    for (const bad of ['visual.shape', 'visual.shape/v', 'a/v0', 'A.b/v0', 'a.b/v0\n']) {
      expect(issuesOf(schema, { axes: ['a.b/v0', bad] })).toEqual(
        [KEY_REFUSAL].map((i) => fieldIssue(i, 'axes', 1)),
      )
    }
  })

  it('holds a board to the axis limit and says which limit', () => {
    expect(VISUAL_AXES_MAX).toBe(64)
    expect(schema.safeParse({ axes: keys(64) }).success).toBe(true)
    expect(issuesOf(schema, { axes: keys(65) })).toEqual([
      {
        code: 'too_big',
        message: 'more axes than the 64-axis limit for one board',
        path: ['axes'],
      },
    ])
  })

  it('refuses a missing list and a non-array', () => {
    expect(issuesOf(schema, {})).toEqual([
      fieldIssue(
        { code: 'invalid_type', message: 'Invalid input: expected array, received undefined' },
        'axes',
      ),
    ])
    expect(issuesOf(schema, { axes: 'x' })).toEqual([
      fieldIssue(
        { code: 'invalid_type', message: 'Invalid input: expected array, received string' },
        'axes',
      ),
    ])
  })
})

// `wb_facet_list` serves `z.toJSONSchema(schema)` to agents verbatim, so a
// reordered key or a changed pattern is a changed answer.
const DRAFT = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",'
const ID_PATTERN = '"pattern":"^[a-z][a-z0-9-]*\\\\.[a-z][a-z0-9-]*$"'
const PUBLISHED: Record<string, string> = {
  shape: `${DRAFT}"properties":{"kind":{"type":"string","enum":["ellipse","diamond","hexagon","parallelogram","cylinder","octagon"]}},"required":["kind"],"additionalProperties":false}`,
  text: `${DRAFT}"properties":{"align":{"type":"string","enum":["start","center"]}},"required":["align"],"additionalProperties":false}`,
  edges: `${DRAFT}"properties":{"routing":{"type":"string","enum":["straight","orthogonal","curved"]},"lineJumps":{"type":"string","enum":["none","arc"]}},"additionalProperties":false}`,
  ink: `${DRAFT}"properties":{"group":{"type":"string","minLength":1}},"required":["group"],"additionalProperties":false}`,
  stroke: `${DRAFT}"properties":{"width":{"type":"string","enum":["medium","thick"]}},"required":["width"],"additionalProperties":false}`,
  theme: `${DRAFT}"properties":{"theme":{"type":"string",${ID_PATTERN}}},"required":["theme"],"additionalProperties":false}`,
  stencil: `${DRAFT}"properties":{"stencil":{"type":"string",${ID_PATTERN}}},"required":["stencil"],"additionalProperties":false}`,
  axes: `${DRAFT}"properties":{"axes":{"maxItems":64,"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]*\\\\.[a-z][a-z0-9-]*\\\\/v[0-9]+$"}}},"required":["axes"],"additionalProperties":false}`,
}

describe('what the facet list publishes', () => {
  it.each(Object.keys(PUBLISHED))('keeps the JSON Schema of visual.%s byte for byte', (name) => {
    expect(JSON.stringify(z.toJSONSchema(schemaOf(name)))).toBe(PUBLISHED[name])
  })
})

const choice = (name: string, options: string[], required: boolean) => ({
  name,
  label: name[0]?.toUpperCase() + name.slice(1),
  control: { kind: 'choice', options },
  required,
  quick: false,
})
const text = (name: string) => ({
  name,
  label: name[0]?.toUpperCase() + name.slice(1),
  control: { kind: 'text' },
  required: true,
  quick: false,
})

describe('the form derived from the schema alone', () => {
  const fields = (...f: object[]) => ({ kind: 'fields', fields: f })
  const derived: Record<string, unknown> = {
    shape: fields(choice('kind', SHAPES, true)),
    text: fields(choice('align', ['start', 'center'], true)),
    edges: fields(
      { ...choice('routing', ROUTINGS, false), label: 'Routing' },
      { ...choice('lineJumps', ['none', 'arc'], false), label: 'Line jumps' },
    ),
    ink: fields(text('group')),
    stroke: fields(choice('width', ['medium', 'thick'], true)),
    theme: fields(text('theme')),
    stencil: fields(text('stencil')),
    axes: { kind: 'unsupported' },
  }

  it.each(Object.keys(derived))('is unchanged for visual.%s', (name) => {
    expect(deriveFacetForm(schemaOf(name))).toEqual(derived[name])
  })

  it('still drives the declared field editors over the schema', () => {
    expect(bundledFacetRegistry.facetForm('visual.ink/v0')).toEqual(derived.ink)
    expect(bundledFacetRegistry.facetForm('visual.stroke/v0')).toEqual(derived.stroke)
    expect(bundledFacetRegistry.facetForm('visual.axes/v0')).toEqual(derived.axes)
    const edges = bundledFacetRegistry.facetForm('visual.edges/v0')
    expect(edges.kind === 'fields' && edges.fields.map((f) => f.control.kind)).toEqual([
      'segmented',
      'segmented',
    ])
  })
})
