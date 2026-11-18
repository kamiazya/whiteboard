import { describe, expect, it } from 'vitest'
import { FenceTokenMemo } from './fence-tokens.js'
import { FontHandles } from './font-handles.js'
import { type LayoutGlue, layoutMarkdown, type MarkdownLayoutRequest } from './layout.js'

const errors = {
  refused: (operation: string, code: string, detail?: string) =>
    new Error(`${operation} ${code} ${detail ?? ''}`),
}

/** A glue answering each call from `answers` in turn, keeping what it was handed. */
function glueOf(...answers: string[]) {
  const sent: unknown[] = []
  const glue: LayoutGlue = {
    layout_spatial_canvas(request) {
      sent.push(JSON.parse(request))
      return answers[sent.length - 1] ?? '["refused","input-too-large","x"]'
    },
    register_layout_fonts: () => '["ok",3]',
    release_layout_fonts: () => true,
    release_layout_cache: () => false,
    layout_query: () => '',
  }
  return { glue, sent }
}

const lay = (glue: LayoutGlue, request: MarkdownLayoutRequest, highlight?: () => undefined) =>
  layoutMarkdown(
    glue,
    errors,
    request,
    highlight,
    new FenceTokenMemo(),
    new FontHandles(glue, errors),
  )

const note: MarkdownLayoutRequest = {
  kind: 'markdown',
  body: '# Hi',
  maxWidth: 720,
  measure: { kind: 'fake', factor: 0.5 },
  mode: 'light',
  section: 'Hi',
}

const comment: MarkdownLayoutRequest = {
  kind: 'comment',
  body: 'x',
  maxWidth: 200,
  measure: { kind: 'ratio' },
  density: 'compact',
}

describe('a markdown body over the artifact', () => {
  it('sends a note and a comment on the value wire under their kind', () => {
    const { glue, sent } = glueOf()
    lay(glue, note)
    lay(glue, comment)
    expect(sent[0]).toEqual([
      'm',
      'kind',
      'markdown',
      'body',
      '# Hi',
      'maxWidth',
      720,
      'measure',
      ['m', 'kind', 'fake', 'factor', ['f', '3fe0000000000000']],
      'mode',
      'light',
      'section',
      'Hi',
    ])
    expect(sent[1]).toEqual(
      [
        'm',
        'kind',
        'comment',
        'body',
        'x',
        'maxWidth',
        200,
        'measure',
        ['m', 'kind', 'ratio'],
      ].concat(['density', 'compact']),
    )
  })

  it('reads the scene, the degradations and the sources asked, without anchors', () => {
    const scene = { nodes: [] }
    const asks = [{ kind: 'math', value: 'x' }]
    const { glue } = glueOf(JSON.stringify(['ok', scene, [], [], asks]))
    expect(lay(glue, note)).toEqual({
      scene,
      blockLines: [],
      degradations: [],
      fragmentsAsked: asks,
    })
    const { glue: plain } = glueOf(JSON.stringify(['ok', scene, [], []]))
    expect(lay(plain, comment)).toEqual({ scene, blockLines: [], degradations: [] })
  })

  it('reads the line each block starts on from where a canvas answers its anchors', () => {
    const scene = { nodes: [] }
    const { glue } = glueOf(JSON.stringify(['ok', scene, [1, 3, 8], []]))
    expect(lay(glue, note)).toEqual({ scene, blockLines: [1, 3, 8], degradations: [] })
    const bad = (lines: unknown[]) => glueOf(JSON.stringify(['ok', scene, lines, []])).glue
    expect(() => lay(bad([1, 0]), note)).toThrow('malformed answer')
    expect(() => lay(bad([1.5]), note)).toThrow('malformed answer')
    expect(() => lay(bad([1, ['e', {}]]), note)).toThrow('malformed answer')
  })

  it('reads the keyed SVG a comment asked for', () => {
    const scene = { nodes: [] }
    const comment = {
      kind: 'comment',
      body: 'hi',
      maxWidth: 200,
      measure: { kind: 'ratio' },
      density: 'compact',
      svg: { padding: 1, form: 'keyed' },
    } as MarkdownLayoutRequest
    const { glue, sent } = glueOf(JSON.stringify(['ok', scene, [], [], ['<svg>', [], []]]))
    expect(lay(glue, comment)).toEqual({
      scene,
      blockLines: [],
      degradations: [],
      keyed: { svg: '<svg></svg>', rootOpen: '<svg>', rootAttrs: {}, groups: [] },
    })
    expect(JSON.stringify(sent[0])).toContain('"svg",["m","padding",1,"form","keyed"]')
  })

  it('reads the SVG a note asked for, after the sources asked', () => {
    const scene = { nodes: [] }
    const asks = [{ kind: 'math', value: 'x' }]
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    const asking = { ...note, svg: { viewBox: 'document' } } as MarkdownLayoutRequest
    const { glue, sent } = glueOf(JSON.stringify(['ok', scene, [], [], asks, svg]))
    expect(lay(glue, asking)).toEqual({
      scene,
      blockLines: [],
      degradations: [],
      fragmentsAsked: asks,
      svg,
    })
    expect(JSON.stringify(sent[0])).toContain('"svg",["m","viewBox","document"]')
  })

  it('reads a missing section and a cap as the root answers them, and a decline as no answer', () => {
    expect(lay(glueOf('["missing","section"]').glue, note)).toEqual({ missing: 'section' })
    // Nothing declines since D7a: a decline is an answer the shim does not know.
    expect(() => lay(glueOf('["declined","body"]').glue, note)).toThrow(/malformed/)
    const capped = glueOf('["refused","input-too-large","bodies"]').glue
    expect(lay(capped, note)).toEqual({ refused: { code: 'input-too-large', reason: 'bodies' } })
  })

  it('asks the highlighter for the fences the core needs, and throws without one', () => {
    const needs = JSON.stringify(['needs', { code: [['ts', 'x']] }])
    expect(() => lay(glueOf(needs).glue, note)).toThrow(/malformed highlight/)
    const { glue, sent } = glueOf(needs, JSON.stringify(['ok', { nodes: [] }, [], []]))
    expect(lay(glue, note, () => undefined)).toEqual({
      scene: { nodes: [] },
      blockLines: [],
      degradations: [],
    })
    expect(JSON.stringify(sent[1])).toContain('"codeTokens",["s",["s","ts","x",null]]')
  })

  it('sends a comment no fence tokens a note left in the memo, and no cache surface', () => {
    const needs = JSON.stringify(['needs', { code: [['ts', 'return 1']] }])
    const ok = JSON.stringify(['ok', { nodes: [] }, [], []])
    const { glue, sent } = glueOf(needs, ok, ok)
    const memo = new FenceTokenMemo()
    const fonts = new FontHandles(glue, errors)
    const tokens = () => [[{ text: 'return 1' }]]
    const fenced = { ...note, body: '```ts\nreturn 1\n```', section: undefined }
    layoutMarkdown(glue, errors, fenced, tokens, memo, fonts, undefined, 9)
    expect(JSON.stringify(sent[1])).toContain('"codeTokens"')
    expect(JSON.stringify(sent[1])).toContain('"cache",9')
    const said = { ...comment, body: 'return 1' }
    layoutMarkdown(glue, errors, said, tokens, memo, fonts, undefined, 9)
    expect(JSON.stringify(sent[2])).not.toContain('"codeTokens"')
    expect(JSON.stringify(sent[2])).not.toContain('"cache"')
  })

  it('refuses an answer that carries anchors or is not one', () => {
    const anchored = JSON.stringify(['ok', { nodes: [] }, [['e', {}]], []])
    expect(() => lay(glueOf(anchored).glue, note)).toThrow('malformed answer')
    expect(() => lay(glueOf('["missing","part"]').glue, note)).toThrow('malformed')
  })
})
