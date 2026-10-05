// @vitest-environment node
import {
  COMMENT_MESSAGE_MAX_CHARS,
  LABEL_MAX_CHARS,
  MARKDOWN_MAX_CHARS,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  TAGS_PER_ELEMENT_MAX,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  commentMessageNotice,
  copiedLabelNotice,
  copiedLocationNotice,
  copiedNodeTextNotice,
  KEEPER_LIMIT_REASON,
  labelNotice,
  markdownBodyNotice,
  nodeTextEditNotice,
  pastedTextNotice,
  tagCountNotice,
} from './limit-notice.js'

/** Every notice that names a count, with the bound it is about and the word for one of what it bounds. */
const COUNTED = [
  {
    name: 'markdown edit',
    notice: (n: number) => markdownBodyNotice('added', n),
    max: MARKDOWN_MAX_CHARS,
    one: 'document',
  },
  {
    name: 'markdown adoption',
    notice: (n: number) => markdownBodyNotice('adopted', n),
    max: MARKDOWN_MAX_CHARS,
    one: 'document',
  },
  { name: 'node edit', notice: nodeTextEditNotice, max: NODE_TEXT_MAX_CHARS, one: 'node' },
  { name: 'text paste', notice: pastedTextNotice, max: NODE_TEXT_MAX_CHARS, one: 'node' },
  {
    name: 'node paste',
    notice: (n: number) => copiedNodeTextNotice('pasted', n),
    max: NODE_TEXT_MAX_CHARS,
    one: 'node',
  },
  {
    name: 'node duplicate',
    notice: (n: number) => copiedNodeTextNotice('duplicated', n),
    max: NODE_TEXT_MAX_CHARS,
    one: 'node',
  },
  {
    name: 'link paste',
    notice: (n: number) => copiedLocationNotice('pasted', 'URL', n),
    max: NODE_LOCATION_MAX_CHARS,
    one: 'URL',
  },
  {
    name: 'file path duplicate',
    notice: (n: number) => copiedLocationNotice('duplicated', 'path', n),
    max: NODE_LOCATION_MAX_CHARS,
    one: 'path',
  },
  {
    name: 'file subpath paste',
    notice: (n: number) => copiedLocationNotice('pasted', 'subpath', n),
    max: NODE_LOCATION_MAX_CHARS,
    one: 'subpath',
  },
  {
    name: 'label paste',
    notice: (n: number) => copiedLabelNotice('pasted', n),
    max: LABEL_MAX_CHARS,
    one: 'label',
  },
  { name: 'label edit', notice: labelNotice, max: LABEL_MAX_CHARS, one: 'label' },
  {
    name: 'comment edit',
    notice: commentMessageNotice,
    max: COMMENT_MESSAGE_MAX_CHARS,
    one: 'comment',
  },
] as const

const enUs = (n: number) => n.toLocaleString('en-US')

describe('limit notices', () => {
  it.each(COUNTED)('the $name notice names the length and its own bound', ({
    notice,
    max,
    one,
  }) => {
    const said = notice(max + 1)
    expect(said).toContain(`${enUs(max + 1)} characters`)
    expect(said).toContain(`past the ${enUs(max)}-character limit for one ${one}.`)
  })

  it('the tag count notice names the count and its own bound', () => {
    const said = tagCountNotice(TAGS_PER_ELEMENT_MAX + 1)
    expect(said).toContain(`${enUs(TAGS_PER_ELEMENT_MAX + 1)} tags`)
    expect(said).toContain(`past the ${enUs(TAGS_PER_ELEMENT_MAX)}-tag limit`)
  })

  // The canvas element is a node in every other piece of the app's copy.
  it('calls a canvas element a node, never a card', () => {
    const all = [
      ...COUNTED.map(({ notice, max }) => notice(max + 1)),
      ...Object.values(KEEPER_LIMIT_REASON),
    ]
    for (const said of all) expect(said).not.toMatch(/\bcards?\b/i)
  })
})
