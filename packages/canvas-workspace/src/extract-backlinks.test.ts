import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/internal'
import { describe, expect, test } from 'vitest'
import { extractBacklinks } from './extract-backlinks.js'

const FROM = '01J0000000000000000000000A'
const TO_1 = '01J0000000000000000000000B'
const TO_2 = '01J0000000000000000000000C'

describe('extractBacklinks', () => {
  test('extracts wikiLink canvasIds', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'See ' },
            { type: 'wikiLink', canvasId: TO_1, alias: 'notes' },
            { type: 'text', value: ' and ' },
            { type: 'wikiLink', canvasId: TO_2 },
          ],
        },
      ],
    }

    const rows = extractBacklinks(FROM, root)
    expect(rows).toEqual([
      { fromCanvasId: FROM, toCanvasId: TO_1 },
      { fromCanvasId: FROM, toCanvasId: TO_2 },
    ])
  })

  test('extracts embed canvasIds', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'embed', canvasId: TO_1 }],
        },
      ],
    }

    const rows = extractBacklinks(FROM, root)
    expect(rows).toEqual([{ fromCanvasId: FROM, toCanvasId: TO_1 }])
  })

  test('deduplicates same target appearing multiple times', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'wikiLink', canvasId: TO_1 },
            { type: 'wikiLink', canvasId: TO_1, alias: 'again' },
            { type: 'embed', canvasId: TO_1 },
          ],
        },
      ],
    }

    const rows = extractBacklinks(FROM, root)
    expect(rows).toEqual([{ fromCanvasId: FROM, toCanvasId: TO_1 }])
  })

  test('returns empty array when no links exist', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'No links here.' }],
        },
      ],
    }

    expect(extractBacklinks(FROM, root)).toEqual([])
  })

  test('walks into headings', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'heading',
          depth: 2,
          children: [{ type: 'wikiLink', canvasId: TO_1 }],
        },
      ],
    }

    expect(extractBacklinks(FROM, root)).toEqual([{ fromCanvasId: FROM, toCanvasId: TO_1 }])
  })

  test('walks into blockquotes', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'blockquote',
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'wikiLink', canvasId: TO_1 }],
            },
          ],
        },
      ],
    }

    expect(extractBacklinks(FROM, root)).toEqual([{ fromCanvasId: FROM, toCanvasId: TO_1 }])
  })

  test('walks into list items', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          spread: false,
          children: [
            {
              type: 'listItem',
              spread: false,
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'wikiLink', canvasId: TO_1 }],
                },
              ],
            },
          ],
        },
      ],
    }

    expect(extractBacklinks(FROM, root)).toEqual([{ fromCanvasId: FROM, toCanvasId: TO_1 }])
  })

  test('walks into table cells', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'table',
          align: [null],
          children: [
            {
              type: 'tableRow',
              children: [
                {
                  type: 'tableCell',
                  children: [{ type: 'wikiLink', canvasId: TO_1 }],
                },
              ],
            },
          ],
        },
      ],
    }

    expect(extractBacklinks(FROM, root)).toEqual([{ fromCanvasId: FROM, toCanvasId: TO_1 }])
  })

  test('walks into nested phrasing (strong, emphasis)', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'strong',
              children: [
                {
                  type: 'emphasis',
                  children: [{ type: 'wikiLink', canvasId: TO_1 }],
                },
              ],
            },
          ],
        },
      ],
    }

    expect(extractBacklinks(FROM, root)).toEqual([{ fromCanvasId: FROM, toCanvasId: TO_1 }])
  })
})
