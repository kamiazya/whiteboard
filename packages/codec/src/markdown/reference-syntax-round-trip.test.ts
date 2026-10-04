import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { resolveReferences } from '../references/resolve.js'
import { resolveReferencesForExport } from '../references/resolve-for-export.js'
import { parseMarkdownBody, stringifyMarkdownBody } from './pipeline.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

function roundTrip(body: string): string {
  return stringifyMarkdownBody(parseMarkdownBody(body))
}

function paragraphOf(children: unknown[]): MdastRoot {
  return { type: 'root', children: [{ type: 'paragraph', children }] } as MdastRoot
}

function firstParagraphChildren(root: MdastRoot) {
  const paragraph = root.children[0]
  if (paragraph?.type !== 'paragraph') throw new Error('expected paragraph')
  return paragraph.children
}

describe('the writer emits the reference syntax the reader recognises', () => {
  it.each([
    ['a wikiLink', '[[x]]'],
    ['an embed', '![[img.png]]'],
    ['an alias', '[[x|y]]'],
    ['a fragment', '[[x#Heading|y]]'],
    ['a reference between words', 'see [[abc]] and ![[img.png]] and [a](b)'],
    ['a list item', '* item [[x|y]]'],
    ['a heading', '## About [[x]]'],
    ['a blockquote', '> quoted [[x]]'],
    ['emphasis', '*see [[x]]*'],
    ['a table cell', '| a     |\n| ----- |\n| [[x]] |'],
  ])('round-trips %s unescaped', (_label, body) => {
    expect(roundTrip(body)).toBe(body)
  })

  it('escapes the pipe of an alias inside a table cell so the cell survives', () => {
    const body = '| a        |\n| -------- |\n| [[x\\|y]] |'
    const root = parseMarkdownBody(body)
    expect(stringifyMarkdownBody(root)).toBe(body)
    const resolved = resolveReferences(root, (alias) => (alias === 'x' ? ULID : null))
    const table = resolved.children[0]
    if (table?.type !== 'table') throw new Error('expected table')
    expect(table.children[1]?.children[0]?.children).toEqual([
      { type: 'wikiLink', documentId: ULID, alias: 'y' },
    ])
  })

  it('writes typed wikiLink and embed nodes as the syntax that resolves back to them', () => {
    const root = paragraphOf([
      { type: 'text', value: 'see ' },
      { type: 'wikiLink', documentId: ULID, alias: 'a name', fragment: 'Part' },
      { type: 'text', value: ' and ' },
      { type: 'embed', documentId: OTHER_ULID },
    ])
    const text = stringifyMarkdownBody(root)
    expect(text).toBe(`see [[${ULID}#Part|a name]] and ![[${OTHER_ULID}]]`)
    expect(firstParagraphChildren(resolveReferences(parseMarkdownBody(text)))).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'wikiLink', documentId: ULID, alias: 'a name', fragment: 'Part' },
      { type: 'text', value: ' and ' },
      { type: 'embed', documentId: OTHER_ULID },
    ])
  })

  it('still escapes brackets that are not a reference', () => {
    expect(roundTrip('a \\[b] and [[]] and [[|x]]')).toBe('a \\[b] and \\[\\[]] and \\[\\[|x]]')
  })

  it.each([
    '[[a\\*b]]',
    '[[x|a\\*b\\_c]]',
    '[[x|\\[y]]',
  ])('escapes markdown-significant characters inside a reference so they re-read as written: %s', (body) => {
    expect(roundTrip(body)).toBe(body)
  })
})

describe('the export seam writes links a markdown reader follows', () => {
  const resolver = (id: string) =>
    id === ULID ? 'notes/a.md' : id === OTHER_ULID ? 'img/b.png' : null

  it('composes with the writer into a link and an image', () => {
    const root = paragraphOf([
      { type: 'wikiLink', documentId: ULID, alias: 'Alias' },
      { type: 'text', value: ' ' },
      { type: 'embed', documentId: OTHER_ULID, fragment: 'f' },
    ])
    const text = stringifyMarkdownBody(resolveReferencesForExport(root, resolver))
    expect(text).toBe('[Alias](notes/a.md) ![img/b.png#f](img/b.png#f)')
    expect(firstParagraphChildren(parseMarkdownBody(text))).toMatchObject([
      {
        type: 'link',
        url: 'notes/a.md',
        children: [{ type: 'text', value: 'Alias' }],
      },
      { type: 'text', value: ' ' },
      { type: 'image', url: 'img/b.png#f', alt: 'img/b.png#f' },
    ])
  })

  it('leaves an unresolved reference as the syntax a later import resolves', () => {
    const root = paragraphOf([{ type: 'wikiLink', documentId: 'ZZ-unknown', alias: 'x' }])
    const text = stringifyMarkdownBody(resolveReferencesForExport(root, () => null))
    expect(text).toBe('[[ZZ-unknown|x]]')
  })
})
