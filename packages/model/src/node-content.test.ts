/**
 * Reading what a node SHOWS, without reading how it is stored.
 *
 * ADR-0038 decision 3 dissolves the node-kind union: text becomes a resource,
 * a file a resource with a location, a link a resource whose location is a
 * URL. 121 production sites read `node.type === 'text'` and `node.text` today,
 * and each is a place the change would otherwise have to reach.
 *
 * So these accessors land FIRST and the readers move onto them while the
 * stored shape is untouched — the same order the fixture migration used, and
 * for the same reason: the interesting change then happens in one file rather
 * than in a hundred.
 *
 * They are deliberately 1:1 with what callers read today (text, file, url,
 * frame) rather than a resource-shaped API. A caller that distinguishes a
 * document reference from an external link still can, and porting stays
 * behaviour-preserving; what each accessor reads changes underneath in the
 * increment that moves the storage.
 */
import { describe, expect, it } from 'vitest'
import {
  applyNodePatch,
  frameBackground,
  frameBackgroundStyle,
  frameLabel,
  isFrame,
  nodeFile,
  nodeSubpath,
  nodeText,
  nodeUrl,
} from './node-content.js'
import { fileNode, groupNode, linkNode, textNode } from './test-utils/index.js'

const at = { x: 0, y: 0, width: 10, height: 10 }

describe('what a node shows', () => {
  const text = textNode({ id: 't', ...at, text: 'hello' })
  const file = fileNode({ id: 'f', ...at, file: 'notes.md' })
  const link = linkNode({ id: 'l', ...at, url: 'https://example.com' })
  const group = groupNode({ id: 'g', ...at, label: 'Tier' })

  it('answers the one thing the node has, and undefined for the rest', () => {
    expect([nodeText(text), nodeFile(text), nodeUrl(text)]).toEqual(['hello', undefined, undefined])
    expect([nodeText(file), nodeFile(file), nodeUrl(file)]).toEqual([
      undefined,
      'notes.md',
      undefined,
    ])
    expect([nodeText(link), nodeFile(link), nodeUrl(link)]).toEqual([
      undefined,
      undefined,
      'https://example.com',
    ])
  })

  it('a frame shows nothing', () => {
    expect([nodeText(group), nodeFile(group), nodeUrl(group)]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it('names the frame axis separately from what a node shows', () => {
    expect([isFrame(group), isFrame(text), isFrame(file), isFrame(link)]).toEqual([
      true,
      false,
      false,
      false,
    ])
  })

  it('an empty text is text, not an absent one', () => {
    // `?? undefined` on a falsy value is the mistake these accessors exist to
    // stop: a node whose text is '' still SHOWS text, and a caller asking
    // "does this show text?" must not be told no.
    expect(nodeText(textNode({ id: 'e', ...at, text: '' }))).toBe('')
  })
})

describe('applyNodePatch', () => {
  const at = { x: 0, y: 0, width: 10, height: 10 }

  it('passes geometry straight through and leaves content untouched', () => {
    const n = applyNodePatch(textNode({ id: 't', ...at, text: 'a' }), { x: 5, width: 40 })
    expect([n.x, n.width, nodeText(n)]).toEqual([5, 40, 'a'])
  })

  it('rewrites the text of a text node and ignores a text key on a file node', () => {
    expect(nodeText(applyNodePatch(textNode({ id: 't', ...at, text: 'a' }), { text: 'b' }))).toBe(
      'b',
    )
    const f = applyNodePatch(fileNode({ id: 'f', ...at, file: 'a.md' }), { text: 'b' })
    expect(nodeText(f)).toBeUndefined()
    expect(nodeFile(f)).toBe('a.md')
  })

  it('re-points a file node and drops the subpath of the old reference', () => {
    const base = applyNodePatch(fileNode({ id: 'f', ...at, file: 'a.md' }), { subpath: '#old' })
    expect(nodeSubpath(base)).toBe('#old')
    const moved = applyNodePatch(base, { file: 'b.md' })
    expect(nodeFile(moved)).toBe('b.md')
    expect(nodeSubpath(moved)).toBeUndefined()
  })

  it('keeps the new subpath when file and subpath arrive together', () => {
    const n = applyNodePatch(fileNode({ id: 'f', ...at, file: 'a.md' }), {
      file: 'b.md',
      subpath: '#h',
    })
    expect([nodeFile(n), nodeSubpath(n)]).toEqual(['b.md', '#h'])
  })

  it('ignores a subpath key on a node that is not a file', () => {
    const n = applyNodePatch(textNode({ id: 't', ...at, text: 'a' }), { subpath: '#h' })
    expect(nodeSubpath(n)).toBeUndefined()
    expect(nodeText(n)).toBe('a')
  })

  it('re-points a link node and ignores a url key on a text node', () => {
    expect(
      nodeUrl(
        applyNodePatch(linkNode({ id: 'l', ...at, url: 'https://a.test' }), {
          url: 'https://b.test',
        }),
      ),
    ).toBe('https://b.test')
    expect(
      nodeUrl(applyNodePatch(textNode({ id: 't', ...at, text: 'a' }), { url: 'https://b.test' })),
    ).toBeUndefined()
  })

  it('applies label, background and backgroundStyle to a frame only', () => {
    const g = applyNodePatch(groupNode({ id: 'g', ...at, label: 'one' }), {
      label: 'two',
      background: 'bg.png',
      backgroundStyle: 'repeat',
    })
    expect([frameLabel(g), frameBackground(g), frameBackgroundStyle(g)]).toEqual([
      'two',
      'bg.png',
      'repeat',
    ])
    const kept = applyNodePatch(groupNode({ id: 'g', ...at, label: 'one', background: 'x.png' }), {
      color: '2',
    })
    expect([frameLabel(kept), frameBackground(kept)]).toEqual(['one', 'x.png'])
    const t = applyNodePatch(textNode({ id: 't', ...at, text: 'a' }), {
      label: 'nope',
      background: 'nope.png',
    })
    expect(frameLabel(t)).toBeUndefined()
    expect(frameBackground(t)).toBeUndefined()
  })
})
