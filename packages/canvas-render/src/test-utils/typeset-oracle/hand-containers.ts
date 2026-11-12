import type {
  MdastListItem as ListItem,
  MdastCellPhrasingContent,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-model/mdast'
import { type Block, fence, h, ID, ID2, JA, LONG_EN, p, t } from './hand-builders.js'

/** Blocks that hold blocks or cells, and the embeds among them. */
const quote = (...children: Block[]): Block => ({ type: 'blockquote', children })
const item = (checked: boolean | null, ...children: Block[]): ListItem => ({
  type: 'listItem',
  checked,
  children,
})
const bullet = (...items: ListItem[]): Block => ({
  type: 'list',
  ordered: false,
  children: items,
})
const numbered = (start: number | undefined, ...items: ListItem[]): Block => ({
  type: 'list',
  ordered: true,
  ...(start === undefined ? {} : { start }),
  children: items,
})
const plain = (text: string): ListItem => item(null, p(t(text)))
const cell = (...children: MdastCellPhrasingContent[]): MdastTableCell => ({
  type: 'tableCell',
  children,
})
const row = (...cells: MdastTableCell[]): MdastTableRow => ({
  type: 'tableRow',
  children: cells,
})
const grid = (...rows: MdastTableRow[]): Block => ({ type: 'table', children: rows })
const word = (text: string) => cell({ type: 'text', value: text })

/** A table of a 2- and a 4-character column, which `FLOOR_EXACT` sets at the width where one meets the floor. */
export const FLOOR_TABLE: Block = grid(row(word('ab'), word('abcd')))

/** Blocks that hold blocks or cells: a quote, a list with its items and a table. */
export const HAND_CONTAINERS: readonly (readonly [string, readonly Block[]])[] = [
  ['quote', [quote(p(t(LONG_EN)))]],
  ['quote-two', [quote(p(t('one')), p(t('two')))]],
  ['quote-nested', [quote(p(t('outer')), quote(p(t('inner ')), quote(p(t(LONG_EN)))))]],
  [
    'quote-mixed',
    [
      quote(
        h(2, t('Head')),
        fence('x = 1', 'py'),
        { type: 'thematicBreak' },
        { type: 'math', value: 'a+b' },
      ),
    ],
  ],
  ['quote-empty', [quote()]],
  ['quote-ja', [p(t('before')), quote(p(t(JA))), p(t('after'))]],
  ['quote-list', [quote(bullet(plain('a'), plain('b')))]],
  ['bullets', [bullet(plain('first'), plain(LONG_EN), plain('third'))]],
  ['ordered', [numbered(undefined, plain('one'), plain('two'), plain('three'))]],
  ['ordered-start', [numbered(8, plain('eight'), plain('nine'), plain('ten'), plain('eleven'))]],
  ['ordered-zero', [numbered(0, plain('zero'), plain('one'))]],
  ['ordered-big', [numbered(1e21, plain('a'), plain('b'))]],
  [
    'ordered-fraction',
    [numbered(1.5, plain('a'), plain('b')), numbered(-3, plain('c'), plain('d'))],
  ],
  [
    'nested',
    [
      bullet(
        item(
          null,
          p(t('top')),
          bullet(item(null, p(t('mid')), bullet(plain('deep'), plain('deeper'))), plain('mid two')),
        ),
        plain('top two'),
      ),
    ],
  ],
  [
    'nested-ordered',
    [numbered(1, item(null, p(t('a')), numbered(1, plain('a.1'), plain('a.2'))), plain('b'))],
  ],
  [
    'spread',
    [
      {
        type: 'list',
        ordered: false,
        spread: true,
        children: [item(null, p(t('p1')), p(t('p2'))), plain('x')],
      },
    ],
  ],
  [
    'tasks',
    [
      bullet(
        item(true, p(t('done'))),
        item(false, p(t('todo'))),
        plain('plain'),
        item(true, p(t(LONG_EN))),
      ),
    ],
  ],
  ['tasks-ordered', [numbered(3, item(true, p(t('done'))), item(false, p(t('todo'))))]],
  [
    'item-blocks',
    [
      bullet(
        item(
          null,
          p(t('lead')),
          fence('code', 'js'),
          { type: 'thematicBreak' },
          quote(p(t('q'))),
          h(3, t('h')),
        ),
      ),
    ],
  ],
  ['item-empty', [bullet(item(null), item(false), plain('after'))]],
  ['list-empty', [{ type: 'list', ordered: false, children: [] }]],
  [
    'list-then-text',
    [
      p(t('before')),
      bullet(plain('a'), plain('b')),
      p(t('after')),
      numbered(undefined, plain('c')),
    ],
  ],
  ['list-in-list-in-quote', [quote(bullet(item(null, p(t('a')), quote(p(t('deep quote'))))))]],
  [
    'table',
    [
      grid(
        row(word('Name'), word('Role')),
        row(word('Ada'), word('Engineer')),
        row(word('Grace'), word('Admiral')),
      ),
    ],
  ],
  [
    'table-styled',
    [
      grid(
        row(word('H1'), word('H2')),
        row(
          cell(
            { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
            { type: 'text', value: ' ' },
            { type: 'inlineCode', value: 'code' },
          ),
          cell(
            { type: 'link', url: 'u', children: [{ type: 'text', value: 'link' }] },
            { type: 'delete', children: [{ type: 'text', value: 'gone' }] },
          ),
        ),
      ),
    ],
  ],
  [
    'table-long',
    [
      grid(
        row(word('Short'), word('Long')),
        row(word('x'), word(LONG_EN)),
        row(word(JA), word('y')),
      ),
    ],
  ],
  [
    'table-wide',
    [
      grid(
        row(...Array.from({ length: 8 }, (_, i) => word(`Column ${i} header`))),
        row(...Array.from({ length: 8 }, (_, i) => word(`value ${i} that is wide`))),
      ),
    ],
  ],
  [
    'table-ragged',
    [grid(row(word('a'), word('b'), word('c')), row(word('d')), row(), row(word('e'), word('f')))],
  ],
  ['table-empty-cells', [grid(row(cell(), cell()), row(cell(), word('x')))]],
  ['table-header-only', [grid(row(word('only'), word('header')))]],
  ['table-no-rows', [grid()]],
  [
    'table-wiki',
    [
      grid(
        row(
          cell({ type: 'wikiLink', documentId: ID }, { type: 'embed', documentId: ID2 }),
          cell({ type: 'image', url: 'https://e.com/a.png', alt: 'pic' }),
        ),
      ),
    ],
  ],
  [
    'table-nested-text',
    [
      grid(
        row(
          cell({
            type: 'emphasis',
            children: [
              { type: 'strong', children: [{ type: 'text', value: 'both' }] },
              {
                type: 'linkReference',
                identifier: 'r',
                referenceType: 'full',
                children: [{ type: 'text', value: 'ref' }],
              },
            ],
          }),
          cell({ type: 'inlineMath', value: 'a+b' }, { type: 'html', value: '<b>' }),
        ),
      ),
    ],
  ],
  [
    'table-among',
    [p(t('above')), grid(row(word('a'), word('b')), row(word('c'), word('d'))), p(t('below'))],
  ],
  [
    'everything',
    [
      h(1, t('Doc')),
      p(t(LONG_EN)),
      quote(bullet(item(true, p(t('t'))), plain('u'))),
      grid(row(word('k'), word('v')), row(word('1'), word('2'))),
      numbered(1, plain('last')),
    ],
  ],
]

const eid = (n: number): string => `emb-${n}`
const embedPara = (n: number, fragment?: string): Block =>
  p({ type: 'embed', documentId: eid(n), ...(fragment === undefined ? {} : { fragment }) })

/** Paragraphs that are only an embed, and embeds among prose, over every kind of target. */
export const HAND_EMBEDS: readonly (readonly [string, readonly Block[]])[] = [
  ...Array.from({ length: 16 }, (_, n): [string, readonly Block[]] => [
    `target-${n}`,
    [embedPara(n)],
  ]),
  [
    'fragments',
    ['Second', 'Embedded', 'missing', '', 'Cluster', '^n1', '^zz', 'cluster', ' Second '].map(
      (f, n) => embedPara(n, f),
    ),
  ],
  [
    'fragments-b',
    ['Second', 'Cluster', '^n1', 'missing'].flatMap((f) =>
      [3, 4, 6, 7, 9].map((n) => embedPara(n, f)),
    ),
  ],
  ['among-prose', [p(t('before')), embedPara(1), p(t('between')), embedPara(2), p(t('after'))]],
  [
    'mixed-inline',
    [
      p(t('see '), { type: 'embed', documentId: eid(1) }, t(' and '), {
        type: 'embed',
        documentId: eid(3),
        fragment: 'Part',
      }),
      p({ type: 'embed', documentId: eid(5) }, t(' trailing')),
    ],
  ],
  ['in-quote', [quote(embedPara(1), embedPara(3))]],
  [
    'in-list',
    [
      bullet(
        item(null, embedPara(2)),
        item(true, embedPara(4)),
        item(null, p(t('t')), embedPara(5)),
      ),
    ],
  ],
  [
    'in-table',
    [
      grid(
        row(
          cell({ type: 'embed', documentId: eid(1) }),
          cell({ type: 'embed', documentId: eid(3), fragment: 'F' }),
        ),
      ),
    ],
  ],
  [
    'budget-layouts',
    Array.from({ length: 140 }, (_, n) => embedPara(n % 16 === 0 ? 1 : (n % 16) | 1)),
  ],
  ['budget-elements', [embedPara(7), embedPara(7), embedPara(7)]],
  ['every-target', Array.from({ length: 16 }, (_, n) => embedPara(n))],
]
