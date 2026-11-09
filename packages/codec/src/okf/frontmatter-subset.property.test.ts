import { RESERVED_ROOT_KEYS } from '@kamiazya/whiteboard-model'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { parseOkf } from './parse.js'
import { serializeOkf } from './serialize.js'

const LONG_KEY_UNITS = 1025

// The characters that decide how `yaml.stringify` quotes, folds and breaks a
// string, weighted far above their share of random text; a string made of
// letters never reaches a block scalar, a folded line or an escape.
const awkwardUnit = fc.constantFrom(
  '\t',
  '\n',
  ' ',
  '  ',
  '\u0085',
  '\u2028',
  '\u007f',
  '\u0001',
  '"',
  "'",
  '#',
  ':',
  '-',
  '?',
  '|',
  '>',
  '\\',
  '\r',
  'é',
  '\u{1f600}',
)

const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

const awkwardString: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({
      unit: fc.oneof({ weight: 3, arbitrary: awkwardUnit }, fc.constantFrom('a', 'b', 'Z', '0')),
      maxLength: 40,
    }),
    fc.string({ unit: 'binary', maxLength: 20 }),
    fc
      .array(fc.stringMatching(/^[a-z]{1,12}$/), { minLength: 12, maxLength: 24 })
      .map((words) => words.join(' ')),
    fc
      .array(fc.stringMatching(/^[ a-z\t]{0,10}$/), { minLength: 1, maxLength: 5 })
      .map((lines) => lines.join('\n')),
    fc.string({ minLength: LONG_KEY_UNITS - 1, maxLength: LONG_KEY_UNITS + 60 }),
  )
  .filter((s) => !hasLoneSurrogate(s) && !s.includes('\uFEFF'))

const scalar: fc.Arbitrary<unknown> = fc.oneof(
  awkwardString,
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
)

const value: fc.Arbitrary<unknown> = fc.letrec<{ v: unknown }>((tie) => ({
  v: fc.oneof(
    { depthSize: 'small', maxDepth: 3, withCrossShrink: true },
    scalar,
    fc.array(tie('v'), { maxLength: 4 }),
    fc.dictionary(
      awkwardString.filter((k) => k !== '__proto__'),
      tie('v'),
      { maxKeys: 4 },
    ),
  ),
})).v

const reserved = new Set<string>(RESERVED_ROOT_KEYS)
const facetsRaw = fc.dictionary(
  awkwardString.filter((k) => k !== '__proto__' && !reserved.has(k)),
  value,
  { minKeys: 1, maxKeys: 5 },
)

describe('what serializeOkf writes stays inside the frontmatter YAML subset', () => {
  fcTest.prop([facetsRaw], withDefaults())(
    'parseOkf(serializeOkf(x)) returns x for strings and keys that exercise quoting, folding and long keys',
    (raw) => {
      const text = serializeOkf({ frontmatter: { type: 'note', facetsRaw: raw }, body: '' })
      const result = parseOkf(text)
      expect(
        result.ok,
        result.ok ? '' : `${result.error.message} :: ${JSON.stringify(text).slice(0, 600)}`,
      ).toBe(true)
      if (!result.ok) return
      expect(result.value.frontmatter.facetsRaw).toEqual(raw)
    },
  )
})
