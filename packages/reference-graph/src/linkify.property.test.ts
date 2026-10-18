/**
 * What `linkMarkupFor` writes is read back by the codec's own scanner as ONE
 * reference to the intended document, whatever the document is named. The
 * scanner is the grammar's reader, so it — not a re-statement of its rules —
 * is the oracle.
 *
 * And a canvas node's text is rewritten exactly as a markdown body is: the
 * body is spliced in place through Loro's own text, the node is rebuilt as a
 * string, so the one is an oracle for the other that shares no rewriting
 * code with it.
 */

import { scanReferences } from '@kamiazya/whiteboard-codec'
import {
  MARKDOWN_BODY_KEY,
  readSpatialCanvas,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { nodeText } from '@kamiazya/whiteboard-model'
import {
  afterAllFloor,
  fc,
  fcTest,
  textNode,
  withDefaults,
} from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { linkifyMentionsIn, linkMarkupFor } from './linkify.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

// The characters the grammar assigns a meaning to, drawn as often as the
// ordinary ones: a sparse alphabet reaches `Arrays [0]` once in a blue moon
// and the property passes without ever asking.
const UNIT = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('[', ']', '|', '#', '!', '\n', '\r', ' ', '\t') },
  { weight: 2, arbitrary: fc.constantFrom('日', '本', '語', 'é', '😀') },
  { weight: 5, arbitrary: fc.constantFrom('a', 'B', 'c', '0', '1', '/', '-', '_') },
)
const nameArbitrary = fc.string({ unit: UNIT, minLength: 1, maxLength: 14 })
const pathArbitrary = fc.string({ unit: UNIT, minLength: 1, maxLength: 14 })

const plainArbitrary = fc.string({
  unit: fc.constantFrom('a', 'B', 'c', '0', '1', ' ', '[', '日', '本'),
  minLength: 1,
  maxLength: 14,
})

describe('linkMarkupFor, read back by the scanner', () => {
  fcTest.prop([pathArbitrary, nameArbitrary], withDefaults())(
    'is one reference to the path or the id, never a truncated one',
    (path, name) => {
      const markup = linkMarkupFor({ documentId: ID, path, name })
      const found = scanReferences(markup)

      expect(found).toHaveLength(1)
      const [reference] = found
      expect(reference?.full).toBe(markup)
      expect(reference?.isEmbed).toBe(false)
      expect(reference?.fragment).toBeUndefined()
      expect([path, ID]).toContain(reference?.target)
      // An alias is the name or nothing: a truncated name is a corrupted one.
      expect([name, undefined]).toContain(reference?.alias)
    },
  )

  it('writes a name with a bracket in it as the bare reference, not a truncated one', () => {
    const markup = linkMarkupFor({ documentId: ID, path: 'arrays', name: 'Arrays [0]' })

    expect(scanReferences(markup)).toMatchObject([{ full: markup, target: 'arrays' }])
  })

  fcTest.prop([plainArbitrary, plainArbitrary], withDefaults())(
    'keeps both the path and the name when neither needs any care',
    (path, name) => {
      const [reference] = scanReferences(linkMarkupFor({ documentId: ID, path, name }))

      expect(reference?.target).toBe(path)
      // A label that repeats the path says nothing the bare reference does not.
      expect(reference?.alias).toBe(name === path ? undefined : name)
    },
  )
})

// Mentions packed next to each other, inside references the rewrite must
// step over, and beside brackets that open or close nothing — drawn as whole
// tokens, since a character alphabet almost never spells a closed reference.
const MENTION_TOKEN = fc.constantFrom('N', 'N', 'o', ' ', '[[N]]', '[[n|N]]', '[[', ']]', '[', '|')
const mentionTextArbitrary = fc
  .array(MENTION_TOKEN, { minLength: 1, maxLength: 24 })
  .map((tokens) => tokens.join(''))
const mentionNameArbitrary = fc.constantFrom('N', 'No', 'N N', 'o')

describe('linkifyMentionsIn, a canvas node against a markdown body', () => {
  const reached = { runs: 0, severalLinks: 0, aMentionLeftLinked: 0 }
  afterAllFloor(['writes the same text and counts the same links'], () => {
    // Where splice order matters: two or more links in one text, and a
    // mention inside an existing reference that the rewrite must step over.
    // Measured at 12-16% and 18-23% of runs; the floors sit well below.
    expect(reached.severalLinks / reached.runs).toBeGreaterThan(0.05)
    expect(reached.aMentionLeftLinked / reached.runs).toBeGreaterThan(0.08)
  })

  fcTest.prop([mentionTextArbitrary, mentionNameArbitrary], withDefaults())(
    'writes the same text and counts the same links',
    (text, name) => {
      const target = { documentId: ID, path: 'n', name }
      const body = new LoroDoc()
      writeMarkdownBody(body, text)
      const board = new LoroDoc()
      writeSpatialCanvas(board, {
        nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text })],
        edges: [],
      })

      const inBody = linkifyMentionsIn(body, 'markdown', target)
      const onBoard = linkifyMentionsIn(board, 'spatial', target)

      reached.runs += 1
      if (inBody >= 2) reached.severalLinks += 1
      if (text.split(name).length - 1 > inBody) reached.aMentionLeftLinked += 1
      expect(onBoard).toBe(inBody)
      const [node] = readSpatialCanvas(board).nodes
      expect(node === undefined ? undefined : nodeText(node)).toBe(
        body.getText(MARKDOWN_BODY_KEY).toString(),
      )
    },
  )
})
