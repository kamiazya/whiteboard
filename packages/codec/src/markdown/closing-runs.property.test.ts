import type { Extension } from 'micromark-util-types'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { type Processor, unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { closingRunsExtension } from './closing-runs.js'
import { delimiterBudgetExtension } from './delimiter-budget.js'

/**
 * The closing-run record refuses an opener without scanning, so it is only
 * correct if it refuses exactly the openers micromark's own scan would have
 * failed. The oracle is the same parser without it: micromark deciding by
 * scanning, the machinery the record replaces, compared tree for tree with
 * positions included.
 */
function parserWith(extensions: Extension[]) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(function (this: Processor) {
      const data = this.data()
      data.micromarkExtensions = [...(data.micromarkExtensions ?? []), ...extensions]
    })
}

const withRecord = parserWith([delimiterBudgetExtension, closingRunsExtension])
const scanning = parserWith([delimiterBudgetExtension])

const parse = (parser: ReturnType<typeof parserWith>, body: string) =>
  JSON.stringify(parser.parse(body))

// Dense in markers, escapes and line endings, so runs of every small length
// meet each other with and without a closer, across lines and containers.
const fragment = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('`', '``', '```', '$', '$$') },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '\\`',
      '\\$',
      '\\',
      'a',
      'www.a.co/',
      ' ',
      '\n',
      '\n\n',
      '> ',
      '- ',
      '*',
      '[',
      ']',
    ),
  },
)
const body = fc.array(fragment, { maxLength: 40 }).map((parts) => parts.join(''))

type Walked = { type: string; value?: string; children?: Walked[] }

function countKinds(tree: Walked): { spans: number; refused: number } {
  let spans = 0
  let refused = 0
  const stack = [tree]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'inlineCode' || node.type === 'inlineMath') spans += 1
    if (node.type === 'text' && /[`$]/.test(node.value ?? '')) refused += 1
    stack.push(...(node.children ?? []))
  }
  return { spans, refused }
}

describe('closing-run record', () => {
  fcTest.prop([body], withDefaults({ numRuns: 500 }))(
    'parses every body as the scanning parser does',
    (text) => {
      expect(parse(withRecord, text)).toBe(parse(scanning, text))
    },
  )

  it('draws bodies with spans and with refused openers both', () => {
    let spans = 0
    let refused = 0
    for (const text of fc.sample(body, 300)) {
      const kinds = countKinds(withRecord.parse(text) as Walked)
      if (kinds.spans > 0) spans += 1
      if (kinds.refused > 0) refused += 1
    }
    // Measured about 52 and 175 of the 300.
    expect(spans).toBeGreaterThan(30)
    expect(refused).toBeGreaterThan(100)
  })

  it('closes an opener at a later run of its length past runs of others', () => {
    const tree = withRecord.parse('`a ``b`` ```c` d') as Walked
    expect(countKinds(tree).spans).toBe(1)
    expect(JSON.stringify(tree)).toContain('"value":"a ``b`` ```c"')
  })

  it('measures an opener after an escape from the escape, not the raw run', () => {
    expect(parse(withRecord, '\\```a`` b')).toBe(parse(scanning, '\\```a`` b'))
    expect(JSON.stringify(withRecord.parse('\\```a`` b'))).toContain('"type":"inlineCode"')
  })
})
