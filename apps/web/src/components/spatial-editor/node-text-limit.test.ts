import { EditorState } from '@codemirror/state'
import {
  LABEL_MAX_CHARS,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import {
  copiedLabelNotice,
  copiedLocationNotice,
  copiedNodeTextNotice,
} from '../../lib/limit-notice.js'
import {
  type CopiedFragment,
  copiedFragmentRefusal,
  nodeTextLengthLimit,
  pastedTextRefusal,
} from './node-text-limit.js'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [nodeTextLengthLimit] })
}

describe('nodeTextLengthLimit', () => {
  it('refuses an edit that takes the node text past the node limit', () => {
    const state = stateWith('short')
    const grown = state.update({ changes: { from: 5, insert: 'x'.repeat(NODE_TEXT_MAX_CHARS) } })
    expect(grown.state.doc.toString()).toBe('short')
  })

  it('lets an edit land exactly at the node limit', () => {
    const state = stateWith('')
    const filled = state.update({ changes: { from: 0, insert: 'x'.repeat(NODE_TEXT_MAX_CHARS) } })
    expect(filled.state.doc).toHaveLength(NODE_TEXT_MAX_CHARS)
  })

  it('lets a node already past the limit shrink, and refuses its growth', () => {
    const state = stateWith('x'.repeat(NODE_TEXT_MAX_CHARS + 5))
    expect(state.update({ changes: { from: 0, to: 2 } }).state.doc).toHaveLength(
      NODE_TEXT_MAX_CHARS + 3,
    )
    expect(state.update({ changes: { from: 0, insert: 'y' } }).state.doc).toHaveLength(
      NODE_TEXT_MAX_CHARS + 5,
    )
  })
})

describe('pastedTextRefusal', () => {
  it('lets text at the node limit through', () => {
    expect(pastedTextRefusal('x'.repeat(NODE_TEXT_MAX_CHARS))).toBeNull()
  })

  it('refuses text past the node limit, naming both lengths', () => {
    const refusal = pastedTextRefusal('x'.repeat(NODE_TEXT_MAX_CHARS + 1))
    expect(refusal).toContain('8,193')
    expect(refusal).toContain('8,192')
  })
})

describe('copiedFragmentRefusal', () => {
  const box = { x: 0, y: 0, width: 100, height: 50 }
  const node = (id: string, length: number) => textNode({ id, ...box, text: 'x'.repeat(length) })
  const fragmentOf = (fields: Partial<CopiedFragment>): CopiedFragment => ({
    nodes: [],
    edges: [],
    ...fields,
  })
  /** A valid URL exactly `length` characters long. */
  const urlOf = (length: number) => {
    const origin = 'https://example.com/'
    return origin + 'a'.repeat(length - origin.length)
  }
  const ends = { from: { node: 'a' }, to: { node: 'b' } }
  const pair = [node('a', 1), node('b', 1)]
  const labelled = (length: number) => 'l'.repeat(length)

  it('lets copies through when every node is within the limit', () => {
    const fragment = fragmentOf({ nodes: [node('a', NODE_TEXT_MAX_CHARS), node('b', 1)] })
    expect(copiedFragmentRefusal(fragment, 'pasted')).toBeNull()
  })

  it('refuses copies when any node is past the limit, naming the longest', () => {
    const refusal = copiedFragmentRefusal(
      fragmentOf({
        nodes: [
          node('a', 1),
          node('b', NODE_TEXT_MAX_CHARS + 1),
          node('c', NODE_TEXT_MAX_CHARS + 2),
        ],
      }),
      'duplicated',
    )
    expect(refusal).toBe(copiedNodeTextNotice('duplicated', NODE_TEXT_MAX_CHARS + 2))
  })

  it('keeps a link whose URL is at the location limit, and refuses one past it', () => {
    const link = (length: number) =>
      fragmentOf({ nodes: [linkNode({ id: 'l', ...box, url: urlOf(length) })] })
    expect(copiedFragmentRefusal(link(NODE_LOCATION_MAX_CHARS), 'pasted')).toBeNull()
    expect(copiedFragmentRefusal(link(NODE_LOCATION_MAX_CHARS + 1), 'pasted')).toBe(
      copiedLocationNotice('pasted', 'URL', NODE_LOCATION_MAX_CHARS + 1),
    )
  })

  it('keeps a file whose path is at the location limit, and refuses one past it', () => {
    const file = (length: number) =>
      fragmentOf({ nodes: [fileNode({ id: 'f', ...box, file: 'p'.repeat(length) })] })
    expect(copiedFragmentRefusal(file(NODE_LOCATION_MAX_CHARS), 'duplicated')).toBeNull()
    expect(copiedFragmentRefusal(file(NODE_LOCATION_MAX_CHARS + 1), 'duplicated')).toBe(
      copiedLocationNotice('duplicated', 'path', NODE_LOCATION_MAX_CHARS + 1),
    )
  })

  it('keeps a file whose subpath is at the location limit, and refuses one past it', () => {
    const file = (length: number) =>
      fragmentOf({
        nodes: [
          fileNode({ id: 'f', ...box, file: 'notes.md', subpath: `#${'s'.repeat(length - 1)}` }),
        ],
      })
    expect(copiedFragmentRefusal(file(NODE_LOCATION_MAX_CHARS), 'pasted')).toBeNull()
    expect(copiedFragmentRefusal(file(NODE_LOCATION_MAX_CHARS + 1), 'pasted')).toBe(
      copiedLocationNotice('pasted', 'subpath', NODE_LOCATION_MAX_CHARS + 1),
    )
  })

  // Every label the keeper bounds, wherever the fragment carries it — a cut's
  // severed edges too, since a paste that reconnects them writes them again.
  const LABEL_HOLDERS = {
    'an edge': (label: string) => fragmentOf({ nodes: pair, edges: [{ id: 'e', ...ends, label }] }),
    'a line': (label: string) =>
      fragmentOf({
        nodes: pair,
        lines: [
          {
            id: 'i',
            from: { kind: 'node', node: 'a' },
            to: { kind: 'point', point: { x: 0, y: 0 } },
            label,
          },
        ],
      }),
    'a frame': (label: string) => fragmentOf({ nodes: [groupNode({ id: 'g', ...box, label })] }),
    "a cut's severed edge": (label: string) =>
      fragmentOf({
        nodes: [node('a', 1)],
        cut: { id: 'cut', boundaryEdges: [{ id: 'e', ...ends, label }] },
      }),
  } satisfies Record<string, (label: string) => CopiedFragment>

  it.each(
    Object.entries(LABEL_HOLDERS),
  )("keeps %s's label at the label limit, and refuses one past it", (_, holding) => {
    expect(copiedFragmentRefusal(holding(labelled(LABEL_MAX_CHARS)), 'pasted')).toBeNull()
    expect(copiedFragmentRefusal(holding(labelled(LABEL_MAX_CHARS + 1)), 'pasted')).toBe(
      copiedLabelNotice('pasted', LABEL_MAX_CHARS + 1),
    )
  })
})
