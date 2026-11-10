import {
  deriveFacetForm,
  FACET_KEY_PATTERN,
  FACET_NAMESPACED_ID_PATTERN,
} from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bundledFacetRegistry, visualPlugin } from './data.js'

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
  it("spells the engine's grammars, which the generated schemas cannot import", () => {
    const patternAt = (name: string, ...path: string[]) => {
      let node: unknown = z.toJSONSchema(schemaOf(name))
      for (const key of ['properties', ...path]) node = (node as Record<string, unknown>)[key]
      return (node as { pattern?: string }).pattern
    }
    expect(patternAt('theme', 'theme')).toBe(FACET_NAMESPACED_ID_PATTERN.source)
    expect(patternAt('stencil', 'stencil')).toBe(FACET_NAMESPACED_ID_PATTERN.source)
    expect(patternAt('axes', 'axes', 'items')).toBe(FACET_KEY_PATTERN.source)
  })

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

// `visual.symbol` is a union of an icon and an emoji, and its description is
// the answer `wb_facet_list` gives an agent about where a badge is drawn.
describe('visual.symbol', () => {
  const schema = schemaOf('symbol')

  const unionIssues = (value: unknown) => {
    const result = schema.safeParse(value)
    if (result.success) return []
    return result.error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
      arms:
        issue.code === 'invalid_union'
          ? issue.errors.map((arm) =>
              arm.map(({ code, message, path }) => ({ code, message, path })),
            )
          : undefined,
    }))
  }

  const invalidKind = (kind: string) => ({
    code: 'invalid_value',
    message: `Invalid input: expected "${kind}"`,
    path: ['kind'],
  })
  const missing = (field: string) => ({
    code: 'invalid_type',
    message: 'Invalid input: expected string, received undefined',
    path: [field],
  })
  const notObject = (received: string) => ({
    code: 'invalid_type',
    message: `Invalid input: expected object, received ${received}`,
    path: [],
  })
  const union = (...arms: object[][]) => [
    { code: 'invalid_union', message: 'Invalid input', path: [], arms },
  ]
  const SINGLE = {
    code: 'custom',
    message: 'must be a single character or emoji, not a string',
    path: ['char'],
  }
  const TOO_SMALL = (field: string) => ({
    code: 'too_small',
    message: 'Too small: expected string to have >=1 characters',
    path: [field],
  })

  it('takes an icon and an emoji and strips what neither names', () => {
    expect(schema.parse({ kind: 'icon', name: 'star', extra: 1 })).toEqual({
      kind: 'icon',
      name: 'star',
    })
    expect(schema.parse({ kind: 'emoji', char: '\u2705', name: 'x' })).toEqual({
      kind: 'emoji',
      char: '\u2705',
    })
  })

  it('takes one grapheme of any length: ZWJ families, flags, keycaps, skin tones, a letter', () => {
    for (const char of [
      '\u2705',
      '\u26a0\ufe0f',
      '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}',
      '\u{1f1ef}\u{1f1f5}',
      '1\ufe0f\u20e3',
      '\u{1f44d}\u{1f3fd}',
      '\u91cd',
      'e\u0301',
    ]) {
      expect(schema.safeParse({ kind: 'emoji', char }).success, char).toBe(true)
    }
  })

  it('refuses two graphemes and an empty character, each at the character', () => {
    expect(issuesOf(schema, { kind: 'emoji', char: '\u2705\u{1f525}' })).toEqual([SINGLE])
    expect(issuesOf(schema, { kind: 'emoji', char: 'ab' })).toEqual([SINGLE])
    expect(issuesOf(schema, { kind: 'emoji', char: '' })).toEqual([TOO_SMALL('char'), SINGLE])
    expect(issuesOf(schema, { kind: 'icon', name: '' })).toEqual([TOO_SMALL('name')])
  })

  it('answers a payload no arm takes with both arms refusals, in order', () => {
    expect(unionIssues({})).toEqual(
      union([invalidKind('icon'), missing('name')], [invalidKind('emoji'), missing('char')]),
    )
    expect(unionIssues(null)).toEqual(union([notObject('null')], [notObject('null')]))
    expect(unionIssues('x')).toEqual(union([notObject('string')], [notObject('string')]))
    expect(unionIssues({ kind: 'icon' })).toEqual(
      union([missing('name')], [invalidKind('emoji'), missing('char')]),
    )
    expect(unionIssues({ kind: 'emoji' })).toEqual(
      union([invalidKind('icon'), missing('name')], [missing('char')]),
    )
    expect(unionIssues({ kind: 'other', name: 'x' })).toEqual(
      union([invalidKind('icon')], [invalidKind('emoji'), missing('char')]),
    )
    expect(unionIssues({ kind: 'icon', name: 3 })).toEqual(
      union(
        [{ ...missing('name'), message: 'Invalid input: expected string, received number' }],
        [invalidKind('emoji'), missing('char')],
      ),
    )
  })

  it('publishes the JSON Schema and the description wb_facet_list serves, byte for byte', () => {
    expect(JSON.stringify(z.toJSONSchema(schema))).toBe(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","anyOf":[{"type":"object","properties":{"kind":{"type":"string","const":"icon"},"name":{"type":"string","minLength":1}},"required":["kind","name"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"emoji"},"char":{"type":"string","minLength":1}},"required":["kind","char"],"additionalProperties":false}],"description":"What SYMBOLISES this object, for surfaces too small to read it: the minimap, a row in the document browser, the tab favicon. NOT drawn on a canvas \u2014 a node at full size already shows its own content \u2014 so a badge written to say what a box IS or how it is DOING is invisible to anyone reading the board. To record state or kind on a board, write a scoped tag instead (`priority:high`) AND declare its key in the workspace tag library: a declared value carries a colour, so the boxes wearing it are drawn in it and the board legend names it. A tag nobody declared is recorded and drawn in nothing."}',
    )
  })

  // The Rust twin's grapheme tables are Unicode 17.0 and its test asserts that;
  // the host's own release is the other half of the claim they agree.
  it('counts graphemes with the Unicode release the Rust crate implements', () => {
    expect(process.versions.unicode).toBe('17.0')
  })

  it('derives a variants form over the discriminant and keeps its picker', () => {
    const variant = (label: string, name: string) => ({
      label,
      fields: [{ ...text(name), label: name[0]?.toUpperCase() + name.slice(1) }],
    })
    expect(deriveFacetForm(schema)).toEqual({
      kind: 'variants',
      discriminant: 'kind',
      discriminantLabel: 'Kind',
      variants: [variant('icon', 'name'), variant('emoji', 'char')],
    })
    const form = bundledFacetRegistry.facetForm('visual.symbol/v0')
    expect(form.kind).toBe('picker')
  })
})
