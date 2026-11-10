import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadCore } from './load.js'

// The artifact is built, not committed (see index.rust.test.ts).
const bytes = () => readFileSync(new URL('../artifacts/whiteboard_wasm_bg.wasm', import.meta.url))

/**
 * Each frontmatter with the issues Zod 4 reports for it through
 * `okfMarkdownFrontmatterSchema`, as `[path, code, message]`. The messages are
 * what `parseOkf` in `packages/codec` answered when the table was written, so
 * the words are Zod's and not a transcription.
 */
const ZOD: readonly (readonly [
  string,
  readonly (readonly [(string | number)[], string, string])[],
])[] = [
  ['type: 7', [[['type'], 'invalid_type', 'Invalid input: expected string, received number']]],
  ['type: true', [[['type'], 'invalid_type', 'Invalid input: expected string, received boolean']]],
  ['type: null', [[['type'], 'invalid_type', 'Invalid input: expected string, received null']]],
  ['type: [a]', [[['type'], 'invalid_type', 'Invalid input: expected string, received array']]],
  ['type: {a: 1}', [[['type'], 'invalid_type', 'Invalid input: expected string, received object']]],
  ['type: 1.5', [[['type'], 'invalid_type', 'Invalid input: expected string, received number']]],
  ['type: .nan', [[['type'], 'invalid_type', 'Invalid input: expected string, received NaN']]],
  ['type: .inf', [[['type'], 'invalid_type', 'Invalid input: expected string, received Infinity']]],
  [
    'type: -.inf',
    [[['type'], 'invalid_type', 'Invalid input: expected string, received -Infinity']],
  ],
  [
    'type: 99999999999999999999',
    [[['type'], 'invalid_type', 'Invalid input: expected string, received bigint']],
  ],
  ['type: ""', [[['type'], 'too_small', 'Too small: expected string to have >=1 characters']]],
  ['type: ~', [[['type'], 'invalid_type', 'Invalid input: expected string, received null']]],
  ['', [[[], 'invalid_type', 'Invalid input: expected object, received null']]],
  [
    'type: x\ntags: 5',
    [[['tags'], 'invalid_type', 'Invalid input: expected array, received number']],
  ],
  [
    'type: x\ntags: a',
    [[['tags'], 'invalid_type', 'Invalid input: expected array, received string']],
  ],
  [
    'type: x\ntags: null',
    [[['tags'], 'invalid_type', 'Invalid input: expected array, received null']],
  ],
  [
    'type: x\ntags: {a: b}',
    [[['tags'], 'invalid_type', 'Invalid input: expected array, received object']],
  ],
  [
    'type: x\ntags: [1, null, true, [a], {a: 1}, .inf, -.inf, .nan, ""]',
    [
      [['tags', 0], 'invalid_type', 'Invalid input: expected string, received number'],
      [['tags', 1], 'invalid_type', 'Invalid input: expected string, received null'],
      [['tags', 2], 'invalid_type', 'Invalid input: expected string, received boolean'],
      [['tags', 3], 'invalid_type', 'Invalid input: expected string, received array'],
      [['tags', 4], 'invalid_type', 'Invalid input: expected string, received object'],
      [['tags', 5], 'invalid_type', 'Invalid input: expected string, received Infinity'],
      [['tags', 6], 'invalid_type', 'Invalid input: expected string, received -Infinity'],
      [['tags', 7], 'invalid_type', 'Invalid input: expected string, received NaN'],
    ],
  ],
  [
    'type: x\ntitle: 5',
    [[['title'], 'invalid_type', 'Invalid input: expected string, received number']],
  ],
  [
    'type: x\ntitle: [a]',
    [[['title'], 'invalid_type', 'Invalid input: expected string, received array']],
  ],
  [
    'type: x\ntitle: {a: b}',
    [[['title'], 'invalid_type', 'Invalid input: expected string, received object']],
  ],
  [
    'type: x\ntitle: null',
    [[['title'], 'invalid_type', 'Invalid input: expected string, received null']],
  ],
  [
    'type: x\ntitle: true',
    [[['title'], 'invalid_type', 'Invalid input: expected string, received boolean']],
  ],
  [
    'type: x\ntitle: -12345678901234567890',
    [[['title'], 'invalid_type', 'Invalid input: expected string, received bigint']],
  ],
  [
    'type: x\ngenerated: 5',
    [[['generated'], 'invalid_type', 'Invalid input: expected object, received number']],
  ],
  [
    'type: x\ngenerated: a',
    [[['generated'], 'invalid_type', 'Invalid input: expected object, received string']],
  ],
  [
    'type: x\ngenerated: [a]',
    [[['generated'], 'invalid_type', 'Invalid input: expected object, received array']],
  ],
  [
    'type: x\ngenerated: null',
    [[['generated'], 'invalid_type', 'Invalid input: expected object, received null']],
  ],
  [
    'type: x\ngenerated: {}',
    [
      [['generated', 'by'], 'invalid_type', 'Invalid input: expected string, received undefined'],
      [['generated', 'at'], 'invalid_type', 'Invalid input: expected string, received undefined'],
    ],
  ],
  [
    'type: x\ngenerated: {by: 1, at: 2}',
    [
      [['generated', 'by'], 'invalid_type', 'Invalid input: expected string, received number'],
      [['generated', 'at'], 'invalid_type', 'Invalid input: expected string, received number'],
    ],
  ],
  [
    'type: x\ngenerated: {by: "", at: x}',
    [
      [['generated', 'by'], 'too_small', 'Too small: expected string to have >=1 characters'],
      [
        ['generated', 'at'],
        'invalid_format',
        'an OKF timestamp is an ISO 8601 datetime with an explicit UTC offset',
      ],
    ],
  ],
  [
    'type: x\ngenerated: {by: " a", at: "2025-01-01T00:00:00Z"}',
    [
      [
        ['generated', 'by'],
        'custom',
        'an OKF actor is a single-line string with no surrounding whitespace',
      ],
    ],
  ],
  [
    'type: x\ngenerated: {by: [], at: {}}',
    [
      [['generated', 'by'], 'invalid_type', 'Invalid input: expected string, received array'],
      [['generated', 'by'], 'too_small', 'Too small: expected array to have >=1 items'],
      [['generated', 'at'], 'invalid_type', 'Invalid input: expected string, received object'],
    ],
  ],
  [
    'type: x\ngenerated: {by: a}',
    [[['generated', 'at'], 'invalid_type', 'Invalid input: expected string, received undefined']],
  ],
  [
    'type: x\nverified: 5',
    [[['verified'], 'invalid_type', 'Invalid input: expected array, received number']],
  ],
  [
    'type: x\nverified: [1, a]',
    [
      [['verified', 0], 'invalid_type', 'Invalid input: expected object, received number'],
      [['verified', 1], 'invalid_type', 'Invalid input: expected object, received string'],
    ],
  ],
  [
    'type: x\nverified: [{by: a, at: b}]',
    [
      [
        ['verified', 0, 'at'],
        'invalid_format',
        'an OKF timestamp is an ISO 8601 datetime with an explicit UTC offset',
      ],
    ],
  ],
  [
    'type: x\nverified: {by: "a\\nb", at: 1}',
    [
      [
        ['verified', 0, 'by'],
        'custom',
        'an OKF actor is a single-line string with no surrounding whitespace',
      ],
      [['verified', 0, 'at'], 'invalid_type', 'Invalid input: expected string, received number'],
    ],
  ],
  [
    'type: x\nfacets: 5',
    [[['facets'], 'invalid_type', 'Invalid input: expected record, received number']],
  ],
  [
    'type: x\nfacets: [a]',
    [[['facets'], 'invalid_type', 'Invalid input: expected record, received array']],
  ],
  [
    'type: x\nfacets: {a: 1}',
    [
      [
        ['facets', 'a'],
        'custom',
        'extension facet key "a" must match {namespace}.{name}/v{n}, e.g. "visual.shape/v0"',
      ],
    ],
  ],
  [
    'type: x\nfacets: {"a.b/v1": 1, "Bad": 2}',
    [
      [
        ['facets', 'Bad'],
        'custom',
        'extension facet key "Bad" must match {namespace}.{name}/v{n}, e.g. "visual.shape/v0"',
      ],
    ],
  ],
  [
    'type: x\nfacets: null',
    [[['facets'], 'invalid_type', 'Invalid input: expected record, received null']],
  ],
  ['- a', [[[], 'invalid_type', 'Invalid input: expected object, received array']]],
  ['5', [[[], 'invalid_type', 'Invalid input: expected object, received number']]],
  ['a', [[[], 'invalid_type', 'Invalid input: expected object, received string']]],
  ['null', [[[], 'invalid_type', 'Invalid input: expected object, received null']]],
  [
    'type: []',
    [
      [['type'], 'invalid_type', 'Invalid input: expected string, received array'],
      [['type'], 'too_small', 'Too small: expected array to have >=1 items'],
    ],
  ],
  ['type: {}', [[['type'], 'invalid_type', 'Invalid input: expected string, received object']]],
  [
    'type: {length: 0}',
    [
      [['type'], 'invalid_type', 'Invalid input: expected string, received object'],
      [['type'], 'too_small', 'Too small: expected unknown to be >=1'],
    ],
  ],
  [
    'type: {length: 5}',
    [[['type'], 'invalid_type', 'Invalid input: expected string, received object']],
  ],
  [
    'type: x\ngenerated: {by: {length: 0}, at: 1}',
    [
      [['generated', 'by'], 'invalid_type', 'Invalid input: expected string, received object'],
      [['generated', 'by'], 'too_small', 'Too small: expected unknown to be >=1'],
      [['generated', 'at'], 'invalid_type', 'Invalid input: expected string, received number'],
    ],
  ],
  [
    'type: x\ntitle: 1\nview: 2\nresource: []',
    [
      [['title'], 'invalid_type', 'Invalid input: expected string, received number'],
      [['resource'], 'invalid_type', 'Invalid input: expected string, received array'],
      [['view'], 'invalid_type', 'Invalid input: expected string, received number'],
    ],
  ],
] as never

describe('the OKF shim over the built artifact, wording a refusal', () => {
  it('words every schema issue as Zod 4 does', async () => {
    const core = await loadCore(bytes())
    expect(ZOD.length).toBeGreaterThan(40)
    for (const [yaml, issues] of ZOD) {
      const read = core.parseOkf(`---\n${yaml}\n---\n`)
      expect(read.ok, yaml).toBe(false)
      if (read.ok) continue
      expect(
        read.error.issues.map((issue) => [issue.path, issue.code, issue.message]),
        yaml,
      ).toEqual(issues)
    }
  })
})
