import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FACET_KEY_PATTERN, FACET_NAMESPACED_ID_PATTERN } from './facet-grammar.js'
import { stencilAssetSchema } from './stencil.js'
import { SAMPLE_THEME_TOKENS } from './testing/sample-theme-tokens.js'
import { iconAssetSchema, namespacedIdSchema, themeTokensSchema } from './theme-tokens.js'

// The engine's asset schemas (theme tokens, icon, stencil, namespaced id) are
// generated from `contracts/facets/engine/engine.schema.json`. What a generated
// schema must keep is what a reader can observe of the hand-written one:
// which payloads parse and to what, the code, message, path and ORDER of
// every refusal, the JSON Schema it publishes, and the types it infers.

type Shown = {
  path: PropertyKey[]
  code: string
  message: string
  keys?: string[]
  errors?: Shown[][]
}

const show = (issue: z.core.$ZodIssue): Shown => {
  const { path, code, message } = issue
  const out: Shown = { path, code, message }
  if ('keys' in issue) out.keys = issue.keys as string[]
  if ('errors' in issue) out.errors = (issue.errors as z.core.$ZodIssue[][]).map((b) => b.map(show))
  return out
}

const issuesOf = (schema: z.ZodTypeAny, value: unknown): Shown[] => {
  const result = schema.safeParse(value)
  return result.success ? [] : result.error.issues.map(show)
}

const at = (path: PropertyKey[], code: string, message: string): Shown => ({ path, code, message })
const missing = (path: PropertyKey[], what: string) =>
  at(path, 'invalid_type', `Invalid input: expected ${what}, received undefined`)
const wrongType = (path: PropertyKey[], want: string, got: string) =>
  at(path, 'invalid_type', `Invalid input: expected ${want}, received ${got}`)
const option = (path: PropertyKey[], ...values: string[]) =>
  at(
    path,
    'invalid_value',
    `Invalid option: expected one of ${values.map((v) => `"${v}"`).join('|')}`,
  )
const HEX_MESSAGE = 'must be a six-digit hex colour (resvg parses no oklch)'
const ID_MESSAGE = 'must be a namespaced id like "visual.diamond"'
const hexRefusal = (path: PropertyKey[]) => at(path, 'invalid_format', HEX_MESSAGE)
const nonEmpty = (path: PropertyKey[]) =>
  at(path, 'too_small', 'Too small: expected string to have >=1 characters')
const notPositive = (path: PropertyKey[]) =>
  at(path, 'too_small', 'Too small: expected number to be >0')

type Loose = any
const S = SAMPLE_THEME_TOKENS as Loose
const set = (obj: Loose, path: string[], value: unknown): Loose => {
  const [head, ...rest] = path
  if (head === undefined) return value
  return { ...obj, [head]: set(obj[head], rest, value) }
}
const light =
  (...path: string[]) =>
  (value: unknown) =>
    set(S, ['palette', 'light', ...path], value)
const dark =
  (...path: string[]) =>
  (value: unknown) =>
    set(S, ['palette', 'dark', ...path], value)

describe('themeTokensSchema accepts and strips', () => {
  it('takes the sample bundle whole and fills an absent defaults with an empty object', () => {
    const parsed = themeTokensSchema.parse(S)
    expect(parsed).toEqual({ ...S, defaults: { edgeRouting: 'curved' } })
    const bare = themeTokensSchema.parse({ ...S, defaults: undefined })
    expect(bare.defaults).toEqual({})
    expect(themeTokensSchema.parse({ ...S, defaults: undefined }).defaults).not.toBe(bare.defaults)
  })

  it('strips a key it does not name at every level and keeps the ones it does', () => {
    const noisy = {
      ...S,
      extra: 1,
      palette: {
        ...S.palette,
        extra: 1,
        light: {
          ...S.palette.light,
          extra: 1,
          node: { ...S.palette.light.node, text: { ...S.palette.light.node.text, extra: 1 } },
          presets: { ...S.palette.light.presets, 7: { stroke: '#000000', fill: '#000000' } },
        },
      },
      defaults: { edgeRouting: 'orthogonal', extra: 1, groupFrame: { strokeWidth: 2, extra: 1 } },
      glow: { radiusPx: 3, extra: 1 },
    }
    const parsed = themeTokensSchema.parse(noisy)
    expect(parsed).toEqual({
      ...S,
      defaults: { edgeRouting: 'orthogonal', groupFrame: { strokeWidth: 2 } },
      glow: { radiusPx: 3 },
    })
  })

  it('takes every optional field and holds the colours to six digits of either case', () => {
    const full = {
      ...S,
      strokeWidthPx: 1.4,
      fontFamily: 'Yomogi',
      glow: { radiusPx: 0.5 },
      palette: { ...S.palette, dark: { ...S.palette.dark, markdownChrome: '#ABCDEF' } },
      defaults: {
        nodeShape: 'visual.diamond',
        edgeRouting: 'straight',
        groupFrame: { strokeDasharray: '4 2', strokeWidth: 1.5 },
      },
    }
    expect(themeTokensSchema.parse(full)).toEqual(full)
    expect(themeTokensSchema.safeParse(dark('surface')('#ABCDEF')).success).toBe(true)
    expect(themeTokensSchema.safeParse(light('cornerRadiusPx')(0)).success).toBe(true)
    expect(themeTokensSchema.safeParse(dark('node', 'text', 'fill')('none')).success).toBe(true)
  })
})

describe('themeTokensSchema refuses', () => {
  const refusals: [string, unknown, Shown[]][] = [
    [
      'an empty object, naming ink and then palette',
      {},
      [option(['ink'], 'clean', 'sketch'), missing(['palette'], 'object')],
    ],
    ['null', null, [wrongType([], 'object', 'null')]],
    ['an array', [], [wrongType([], 'object', 'array')]],
    ['an ink that is neither', { ...S, ink: 'neon' }, [option(['ink'], 'clean', 'sketch')]],
    ['a zero line weight', { ...S, strokeWidthPx: 0 }, [notPositive(['strokeWidthPx'])]],
    ['a negative line weight', { ...S, strokeWidthPx: -1 }, [notPositive(['strokeWidthPx'])]],
    [
      'a string line weight',
      { ...S, strokeWidthPx: '1' },
      [wrongType(['strokeWidthPx'], 'number', 'string')],
    ],
    [
      'a NaN line weight',
      { ...S, strokeWidthPx: Number.NaN },
      [wrongType(['strokeWidthPx'], 'number', 'NaN')],
    ],
    ['an empty font family', { ...S, fontFamily: '' }, [nonEmpty(['fontFamily'])]],
    ['a glow of radius zero', { ...S, glow: { radiusPx: 0 } }, [notPositive(['glow', 'radiusPx'])]],
    ['a glow with no radius', { ...S, glow: {} }, [missing(['glow', 'radiusPx'], 'number')]],
    ['a null glow', { ...S, glow: null }, [wrongType(['glow'], 'object', 'null')]],
    [
      'a palette with neither mode',
      { ...S, palette: {} },
      [missing(['palette', 'light'], 'object'), missing(['palette', 'dark'], 'object')],
    ],
    [
      'an oklch surface, naming resvg',
      light('surface')('oklch(0.98 0 0)'),
      [hexRefusal(['palette', 'light', 'surface'])],
    ],
    [
      'an eight-digit hex',
      light('surface')('#ffffff00'),
      [hexRefusal(['palette', 'light', 'surface'])],
    ],
    ['a three-digit hex', dark('surface')('#fff'), [hexRefusal(['palette', 'dark', 'surface'])]],
    [
      'a hex with a trailing newline',
      dark('surface')('#ffffff\n'),
      [hexRefusal(['palette', 'dark', 'surface'])],
    ],
    [
      'a numeric surface',
      dark('surface')(5),
      [wrongType(['palette', 'dark', 'surface'], 'string', 'number')],
    ],
    [
      'a negative corner radius',
      light('cornerRadiusPx')(-1),
      [
        at(
          ['palette', 'light', 'cornerRadiusPx'],
          'too_small',
          'Too small: expected number to be >=0',
        ),
      ],
    ],
    [
      'a NaN corner radius',
      light('cornerRadiusPx')(Number.NaN),
      [wrongType(['palette', 'light', 'cornerRadiusPx'], 'number', 'NaN')],
    ],
    [
      'an infinite corner radius',
      light('cornerRadiusPx')(Number.POSITIVE_INFINITY),
      [wrongType(['palette', 'light', 'cornerRadiusPx'], 'number', 'Infinity')],
    ],
    [
      'a stroke of none, which only a fill may be',
      light('node', 'text', 'stroke')('none'),
      [hexRefusal(['palette', 'light', 'node', 'text', 'stroke'])],
    ],
    [
      'a fill keyword other than none, answering the string branch',
      light('node', 'text', 'fill')('transparent'),
      [hexRefusal(['palette', 'light', 'node', 'text', 'fill'])],
    ],
    [
      'a numeric fill, answering both branches of the union',
      light('node', 'text', 'fill')(1),
      [
        {
          path: ['palette', 'light', 'node', 'text', 'fill'],
          code: 'invalid_union',
          message: 'Invalid input',
          errors: [
            [wrongType([], 'string', 'number')],
            [at([], 'invalid_value', 'Invalid input: expected "none"')],
          ],
        },
      ],
    ],
    [
      'a missing fill, answering both branches of the union',
      light('node', 'text')({ stroke: '#000000' }),
      [
        {
          path: ['palette', 'light', 'node', 'text', 'fill'],
          code: 'invalid_union',
          message: 'Invalid input',
          errors: [
            [missing([], 'string')],
            [at([], 'invalid_value', 'Invalid input: expected "none"')],
          ],
        },
      ],
    ],
    [
      'a missing preset',
      light('presets')(
        Object.fromEntries(Object.entries(S.palette.light.presets).filter(([k]) => k !== '3')),
      ),
      [missing(['palette', 'light', 'presets', '3'], 'object')],
    ],
    [
      'a preset accent that is not hex',
      dark('presets', '2', 'fill')('red'),
      [hexRefusal(['palette', 'dark', 'presets', '2', 'fill'])],
    ],
    [
      'a syntax colour that is not hex',
      dark('syntax', 'comment')('x'),
      [hexRefusal(['palette', 'dark', 'syntax', 'comment'])],
    ],
    [
      'a comment pin that is not hex',
      dark('comment', 'pin', 'fill')('x'),
      [hexRefusal(['palette', 'dark', 'comment', 'pin', 'fill'])],
    ],
    [
      'a proposal edge that is not hex',
      dark('proposal', 'edge')('x'),
      [hexRefusal(['palette', 'dark', 'proposal', 'edge'])],
    ],
    [
      'a markdown chrome that is not hex',
      dark('markdownChrome')('grey'),
      [hexRefusal(['palette', 'dark', 'markdownChrome'])],
    ],
    [
      'a bare default shape',
      { ...S, defaults: { nodeShape: 'diamond' } },
      [at(['defaults', 'nodeShape'], 'invalid_format', ID_MESSAGE)],
    ],
    [
      'a capitalised default shape',
      { ...S, defaults: { nodeShape: 'Visual.diamond' } },
      [at(['defaults', 'nodeShape'], 'invalid_format', ID_MESSAGE)],
    ],
    [
      'a default routing outside the vocabulary',
      { ...S, defaults: { edgeRouting: 'zig' } },
      [option(['defaults', 'edgeRouting'], 'straight', 'orthogonal', 'curved')],
    ],
    [
      'an empty dash array and a zero frame weight, in that order',
      {
        ...S,
        defaults: { groupFrame: { strokeDasharray: '', strokeWidth: 0 } },
      },
      [
        nonEmpty(['defaults', 'groupFrame', 'strokeDasharray']),
        notPositive(['defaults', 'groupFrame', 'strokeWidth']),
      ],
    ],
    [
      'null defaults, which a default does not replace',
      { ...S, defaults: null },
      [wrongType(['defaults'], 'object', 'null')],
    ],
    ['string defaults', { ...S, defaults: 'x' }, [wrongType(['defaults'], 'object', 'string')]],
    [
      'eight refusals in the order the fields are declared',
      {
        ink: 1,
        strokeWidthPx: 0,
        fontFamily: '',
        glow: {},
        palette: { light: 1 },
        defaults: { nodeShape: 'x', edgeRouting: 'y' },
      },
      [
        option(['ink'], 'clean', 'sketch'),
        notPositive(['strokeWidthPx']),
        nonEmpty(['fontFamily']),
        missing(['glow', 'radiusPx'], 'number'),
        wrongType(['palette', 'light'], 'object', 'number'),
        missing(['palette', 'dark'], 'object'),
        at(['defaults', 'nodeShape'], 'invalid_format', ID_MESSAGE),
        option(['defaults', 'edgeRouting'], 'straight', 'orthogonal', 'curved'),
      ],
    ],
  ]

  it.each(refusals)('%s', (_name, input, expected) => {
    expect(issuesOf(themeTokensSchema, input)).toEqual(expected)
  })
})

describe('iconAssetSchema', () => {
  it('takes the four primitives, strips what they do not name and keeps their order', () => {
    const parsed = iconAssetSchema.parse({
      viewBox: '0 0 24 24',
      x: 1,
      geometry: [
        { tag: 'path', d: 'M0 0', y: 2 },
        { tag: 'rect', x: 0, y: 0, width: 1, height: 2, rx: 1, z: 1 },
        { tag: 'circle', cx: 1, cy: 2, r: 3, q: 1 },
        { tag: 'ellipse', cx: 1, cy: 2, rx: 3, ry: 4, q: 1 },
      ],
    })
    expect(parsed).toEqual({
      viewBox: '0 0 24 24',
      geometry: [
        { tag: 'path', d: 'M0 0' },
        { tag: 'rect', x: 0, y: 0, width: 1, height: 2, rx: 1 },
        { tag: 'circle', cx: 1, cy: 2, r: 3 },
        { tag: 'ellipse', cx: 1, cy: 2, rx: 3, ry: 4 },
      ],
    })
    expect(iconAssetSchema.parse({ geometry: [{ tag: 'path', d: 'M' }] })).toEqual({
      geometry: [{ tag: 'path', d: 'M' }],
    })
  })

  // What each member of the geometry union answers when it does not match.
  const num = (key: string) => missing([key], 'number')
  const tagIs = (tag: string) => at(['tag'], 'invalid_value', `Invalid input: expected "${tag}"`)
  const PATH = [tagIs('path'), missing(['d'], 'string')]
  const RECT = [tagIs('rect'), num('x'), num('y'), num('width'), num('height')]
  const CIRCLE = [tagIs('circle'), num('cx'), num('cy'), num('r')]
  const ELLIPSE = [tagIs('ellipse'), num('cx'), num('cy'), num('rx'), num('ry')]
  const union = (index: number, ...branches: Shown[][]): Shown => ({
    path: ['geometry', index],
    code: 'invalid_union',
    message: 'Invalid input',
    errors: branches,
  })

  it('answers a payload that is not an object, and a missing or malformed list', () => {
    expect(issuesOf(iconAssetSchema, null)).toEqual([wrongType([], 'object', 'null')])
    expect(issuesOf(iconAssetSchema, {})).toEqual([missing(['geometry'], 'array')])
    expect(issuesOf(iconAssetSchema, { geometry: 'x' })).toEqual([
      wrongType(['geometry'], 'array', 'string'),
    ])
    expect(issuesOf(iconAssetSchema, { geometry: [] })).toEqual([
      at(['geometry'], 'too_small', 'Too small: expected array to have >=1 items'),
    ])
    expect(issuesOf(iconAssetSchema, { viewBox: '', geometry: [{ tag: 'path', d: 'M' }] })).toEqual(
      [nonEmpty(['viewBox'])],
    )
  })

  it('answers an element no member takes with every member refusal, in declaration order', () => {
    expect(issuesOf(iconAssetSchema, { geometry: [{ tag: 'line', x1: 0 }] })).toEqual([
      union(0, PATH, RECT, CIRCLE, ELLIPSE),
    ])
    expect(issuesOf(iconAssetSchema, { geometry: [{ d: 'M0 0' }] })).toEqual([
      union(0, [tagIs('path')], RECT, CIRCLE, ELLIPSE),
    ])
    expect(
      issuesOf(iconAssetSchema, { geometry: [{ tag: 'path', d: 'M' }, { tag: 'circle' }] }),
    ).toEqual([union(1, PATH, RECT, [num('cx'), num('cy'), num('r')], ELLIPSE)])
  })

  it('answers a member that matches its tag with the refusal of its fields alone', () => {
    expect(issuesOf(iconAssetSchema, { geometry: [{ tag: 'path', d: '' }] })).toEqual([
      nonEmpty(['geometry', 0, 'd']),
    ])
    expect(issuesOf(iconAssetSchema, { geometry: [{ tag: 'path' }] })).toEqual([
      union(0, [missing(['d'], 'string')], RECT, CIRCLE, ELLIPSE),
    ])
    expect(issuesOf(iconAssetSchema, { geometry: [{ tag: 'rect', x: 0 }] })).toEqual([
      union(0, PATH, [num('y'), num('width'), num('height')], CIRCLE, ELLIPSE),
    ])
    expect(issuesOf(iconAssetSchema, { geometry: [{ tag: 'circle', cx: 0, cy: 0 }] })).toEqual([
      union(0, PATH, RECT, [num('r')], [tagIs('ellipse'), num('rx'), num('ry')]),
    ])
    expect(
      issuesOf(iconAssetSchema, { geometry: [{ tag: 'ellipse', cx: 0, cy: 0, rx: 1 }] }),
    ).toEqual([union(0, PATH, RECT, [tagIs('circle'), num('r')], [num('ry')])])
  })

  it('refuses a non-finite number as a wrong type', () => {
    const [issue] = issuesOf(iconAssetSchema, {
      geometry: [{ tag: 'circle', cx: Number.NaN, cy: 0, r: Number.POSITIVE_INFINITY }],
    })
    expect(issue?.errors?.[2]).toEqual([
      wrongType(['cx'], 'number', 'NaN'),
      wrongType(['r'], 'number', 'Infinity'),
    ])
  })
})

describe('stencilAssetSchema', () => {
  it('fills facets with an empty record and passes colour and payloads through untouched', () => {
    expect(stencilAssetSchema.parse({ displayName: 'A' })).toEqual({ displayName: 'A', facets: {} })
    expect(stencilAssetSchema.parse({ displayName: 'A', facets: undefined })).toEqual({
      displayName: 'A',
      facets: {},
    })
    const full = { displayName: 'A', color: '5', facets: { 'a.b/v0': { k: [1] }, 'c.d/v1': null } }
    expect(stencilAssetSchema.parse(full)).toEqual(full)
    const parsed = stencilAssetSchema.parse({ displayName: 'A', facets: { 'e.f/v2': undefined } })
    expect(Object.keys(parsed.facets)).toEqual(['e.f/v2'])
  })

  it('refuses every key it does not name, once, naming them in the order written', () => {
    expect(issuesOf(stencilAssetSchema, { displayName: 'A', x: 1 })).toEqual([
      { path: [], code: 'unrecognized_keys', message: 'Unrecognized key: "x"', keys: ['x'] },
    ])
    expect(issuesOf(stencilAssetSchema, { displayName: 'A', x: 1, y: 2, text: 'hi' })).toEqual([
      {
        path: [],
        code: 'unrecognized_keys',
        message: 'Unrecognized keys: "x", "y", "text"',
        keys: ['x', 'y', 'text'],
      },
    ])
  })

  it('refuses a missing, empty or mistyped name and colour at their own paths', () => {
    expect(issuesOf(stencilAssetSchema, {})).toEqual([missing(['displayName'], 'string')])
    expect(issuesOf(stencilAssetSchema, null)).toEqual([wrongType([], 'object', 'null')])
    expect(issuesOf(stencilAssetSchema, { displayName: '' })).toEqual([nonEmpty(['displayName'])])
    expect(issuesOf(stencilAssetSchema, { displayName: 1 })).toEqual([
      wrongType(['displayName'], 'string', 'number'),
    ])
    expect(issuesOf(stencilAssetSchema, { displayName: 'A', color: '' })).toEqual([
      nonEmpty(['color']),
    ])
    expect(issuesOf(stencilAssetSchema, { displayName: 'A', color: 5 })).toEqual([
      wrongType(['color'], 'string', 'number'),
    ])
  })

  it('refuses a facet key outside the grammar with no word about which grammar', () => {
    const invalidKey = (key: string) => at(['facets', key], 'invalid_key', 'Invalid key in record')
    expect(issuesOf(stencilAssetSchema, { displayName: 'A', facets: { 'bad key': 1 } })).toEqual([
      invalidKey('bad key'),
    ])
    expect(
      issuesOf(stencilAssetSchema, {
        displayName: 'A',
        facets: { 'a.b/v0': 1, 'visual.shape': 2, 'A.b/v0': 3 },
      }),
    ).toEqual([invalidKey('visual.shape'), invalidKey('A.b/v0')])
  })

  it('refuses facets that are not a record', () => {
    expect(issuesOf(stencilAssetSchema, { displayName: 'A', facets: null })).toEqual([
      wrongType(['facets'], 'record', 'null'),
    ])
    expect(issuesOf(stencilAssetSchema, { displayName: 'A', facets: [] })).toEqual([
      wrongType(['facets'], 'record', 'array'),
    ])
    expect(issuesOf(stencilAssetSchema, { displayName: 'A', facets: 'x' })).toEqual([
      wrongType(['facets'], 'record', 'string'),
    ])
  })

  it('reports fields before the unrecognised keys', () => {
    expect(
      issuesOf(stencilAssetSchema, { displayName: '', color: '', facets: { bad: 1 }, x: 1 }),
    ).toEqual([
      nonEmpty(['displayName']),
      nonEmpty(['color']),
      at(['facets', 'bad'], 'invalid_key', 'Invalid key in record'),
      { path: [], code: 'unrecognized_keys', message: 'Unrecognized key: "x"', keys: ['x'] },
    ])
  })
})

describe('namespacedIdSchema', () => {
  it('takes two lowercase segments and names the grammar in its refusal', () => {
    expect(namespacedIdSchema.parse('visual.diamond')).toBe('visual.diamond')
    expect(namespacedIdSchema.parse('a-b.c-d')).toBe('a-b.c-d')
    for (const bad of ['Visual.x', 'a.b.c', 'a.b\n', '', 'sketch', '1a.b', 'a.']) {
      expect(issuesOf(namespacedIdSchema, bad)).toEqual([at([], 'invalid_format', ID_MESSAGE)])
    }
    expect(issuesOf(namespacedIdSchema, 1)).toEqual([wrongType([], 'string', 'number')])
    expect(issuesOf(namespacedIdSchema, null)).toEqual([wrongType([], 'string', 'null')])
  })
})

// The JSON Schema a registered asset publishes is read by tools, so a
// reordered key, a changed pattern or a dropped bound is a changed answer.
const DRAFT = '{"$schema":"https://json-schema.org/draft/2020-12/schema",'
const json = (schema: z.ZodTypeAny, io?: 'input') =>
  JSON.stringify(io === undefined ? z.toJSONSchema(schema) : z.toJSONSchema(schema, { io }))
const HEX = '{"type":"string","pattern":"^#[0-9a-fA-F]{6}$"}'
const FILL = `{"anyOf":[${HEX},{"type":"string","const":"none"}]}`
const STYLE = `{"type":"object","properties":{"fill":${FILL},"stroke":${HEX}},"required":["fill","stroke"],"additionalProperties":false}`
const ACCENT = `{"type":"object","properties":{"stroke":${HEX},"fill":${HEX}},"required":["stroke","fill"],"additionalProperties":false}`
const POSITIVE = '{"type":"number","exclusiveMinimum":0}'
const object = (properties: string, required: string[]) =>
  `{"type":"object","properties":{${properties}},"required":[${required.map((r) => `"${r}"`).join(',')}],"additionalProperties":false}`
const PALETTE = object(
  [
    `"node":${object(`"text":${STYLE},"file":${STYLE},"link":${STYLE},"group":${STYLE}`, ['text', 'file', 'link', 'group'])}`,
    `"edgeStroke":${HEX}`,
    `"labelFill":${HEX}`,
    `"surface":${HEX}`,
    '"cornerRadiusPx":{"type":"number","minimum":0}',
    `"presets":${object([1, 2, 3, 4, 5, 6].map((n) => `"${n}":${ACCENT}`).join(','), ['1', '2', '3', '4', '5', '6'])}`,
    `"syntax":${object(`"keyword":${HEX},"string":${HEX},"number":${HEX},"comment":${HEX}`, ['keyword', 'string', 'number', 'comment'])}`,
    `"comment":${object(`"pin":${STYLE},"bubble":${STYLE}`, ['pin', 'bubble'])}`,
    `"proposal":${object(`"edge":${HEX},"bubbleFill":${HEX}`, ['edge', 'bubbleFill'])}`,
    `"markdownChrome":${HEX}`,
  ].join(','),
  [
    'node',
    'edgeStroke',
    'labelFill',
    'surface',
    'cornerRadiusPx',
    'presets',
    'syntax',
    'comment',
    'proposal',
  ],
)
const THEME_DEFAULTS = `{"default":{},"type":"object","properties":{"nodeShape":{"type":"string","pattern":"^[a-z][a-z0-9-]*\\\\.[a-z][a-z0-9-]*$"},"edgeRouting":{"type":"string","enum":["straight","orthogonal","curved"]},"groupFrame":{"type":"object","properties":{"strokeDasharray":{"type":"string","minLength":1},"strokeWidth":${POSITIVE}},"additionalProperties":false}},"additionalProperties":false}`
const THEME = `${DRAFT}"type":"object","properties":{"ink":{"type":"string","enum":["clean","sketch"]},"strokeWidthPx":${POSITIVE},"fontFamily":{"type":"string","minLength":1},"glow":{"type":"object","properties":{"radiusPx":${POSITIVE}},"required":["radiusPx"],"additionalProperties":false},"palette":${object(`"light":${PALETTE},"dark":${PALETTE}`, ['light', 'dark'])},"defaults":${THEME_DEFAULTS}},"required":["ink","palette","defaults"],"additionalProperties":false}`
const FACET_KEY = '{"type":"string","pattern":"^[a-z][a-z0-9-]*\\\\.[a-z][a-z0-9-]*\\\\/v[0-9]+$"}'
const STENCIL_FACETS = `"facets":{"default":{},"type":"object","propertyNames":${FACET_KEY},"additionalProperties":{}}`
const STENCIL_HEAD = `${DRAFT}"type":"object","properties":{"displayName":{"type":"string","minLength":1},"color":{"type":"string","minLength":1},${STENCIL_FACETS}},`
const members = (strict: string) =>
  [
    `{"type":"object","properties":{"tag":{"type":"string","const":"path"},"d":{"type":"string","minLength":1}},"required":["tag","d"]${strict}}`,
    `{"type":"object","properties":{"tag":{"type":"string","const":"rect"},"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},"rx":{"type":"number"}},"required":["tag","x","y","width","height"]${strict}}`,
    `{"type":"object","properties":{"tag":{"type":"string","const":"circle"},"cx":{"type":"number"},"cy":{"type":"number"},"r":{"type":"number"}},"required":["tag","cx","cy","r"]${strict}}`,
    `{"type":"object","properties":{"tag":{"type":"string","const":"ellipse"},"cx":{"type":"number"},"cy":{"type":"number"},"rx":{"type":"number"},"ry":{"type":"number"}},"required":["tag","cx","cy","rx","ry"]${strict}}`,
  ].join(',')
const icon = (strict: string) =>
  `${DRAFT}"type":"object","properties":{"viewBox":{"type":"string","minLength":1},"geometry":{"minItems":1,"type":"array","items":{"anyOf":[${members(strict)}]}}},"required":["geometry"]${strict}}`

describe('what the engine publishes of its assets', () => {
  it('spells the engine grammar, which the generated schemas cannot import', () => {
    const patternOf = (schema: z.ZodTypeAny) =>
      (z.toJSONSchema(schema) as { pattern?: string }).pattern
    expect(patternOf(namespacedIdSchema)).toBe(FACET_NAMESPACED_ID_PATTERN.source)
    const facets = (z.toJSONSchema(stencilAssetSchema) as Loose).properties.facets
    expect(facets.propertyNames.pattern).toBe(FACET_KEY_PATTERN.source)
  })

  it('keeps the JSON Schema of the namespaced id byte for byte', () => {
    expect(json(namespacedIdSchema)).toBe(
      `${DRAFT}"type":"string","pattern":"^[a-z][a-z0-9-]*\\\\.[a-z][a-z0-9-]*$"}`,
    )
  })

  it('keeps the JSON Schema of the theme tokens byte for byte', () => {
    expect(json(themeTokensSchema)).toBe(THEME)
  })

  it('keeps the JSON Schema of the icon asset byte for byte, as read and as written', () => {
    expect(json(iconAssetSchema)).toBe(icon(',"additionalProperties":false'))
    expect(json(iconAssetSchema, 'input')).toBe(icon(''))
  })

  it('keeps the JSON Schema of the stencil asset byte for byte, as read and as written', () => {
    expect(json(stencilAssetSchema)).toBe(
      `${STENCIL_HEAD}"required":["displayName","facets"],"additionalProperties":false}`,
    )
    expect(json(stencilAssetSchema, 'input')).toBe(
      `${STENCIL_HEAD}"required":["displayName"],"additionalProperties":false}`,
    )
  })
})

describe('the types the schemas infer', () => {
  it('keeps defaults and facets required on the way out and optional on the way in', () => {
    const out: z.infer<typeof themeTokensSchema>['defaults'] = {}
    const into: z.input<typeof themeTokensSchema> = { ink: 'clean', palette: S.palette }
    const stencil: z.input<typeof stencilAssetSchema> = { displayName: 'A' }
    const stencilOut: z.infer<typeof stencilAssetSchema>['facets'] = {}
    expect([out, into.defaults, stencil.facets, stencilOut]).toEqual([{}, undefined, undefined, {}])
  })
})
