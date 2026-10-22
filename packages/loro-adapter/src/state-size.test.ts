import { NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { writeSpatialCanvas } from './loro-bridge.js'
import { stateSize } from './state-size.js'

const NODES = 20

function board(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: Array.from({ length: NODES }, (_unused, i) =>
      textNode({ id: `n${i}`, x: i, y: 0, width: 100, height: 40, text }),
    ),
    edges: [],
  })
  doc.commit()
  return doc
}

describe('stateSize', () => {
  it('charges a board for the text its nodes carry, not for how many nodes it has', () => {
    const near = stateSize(board('x'.repeat(NODE_TEXT_MAX_CHARS)))
    const short = stateSize(board('x'))
    // The text alone, nodes times the near-limit text, is a floor on the charge.
    expect(near).toBeGreaterThanOrEqual(NODES * NODE_TEXT_MAX_CHARS)
    // And the difference is the text's, character for character.
    expect(near - short).toBe(NODES * (NODE_TEXT_MAX_CHARS - 1))
  })

  it('charges a note for its body, character for character', () => {
    const note = (body: string) => {
      const doc = new LoroDoc()
      doc.getText(MARKDOWN_BODY_KEY).insert(0, body)
      doc.commit()
      return stateSize(doc)
    }
    expect(note('a'.repeat(1_000)) - note('a')).toBe(999)
  })

  it('counts the entries of an object a map holds whole, beside its strings', () => {
    const one = new LoroDoc()
    one.getMap('m').set('k', { a: 1 })
    const three = new LoroDoc()
    three.getMap('m').set('k', { a: 1, b: 2, c: 3 })
    expect(stateSize(three) - stateSize(one)).toBe(2)
  })
})
