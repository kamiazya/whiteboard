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
      return answers[sent.length - 1] ?? '["declined","x"]'
    },
    register_layout_fonts: () => '["ok",3]',
    release_layout_fonts: () => true,
    release_layout_cache: () => false,
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
    expect(lay(glue, note)).toEqual({ scene, degradations: [], fragmentsAsked: asks })
    const { glue: plain } = glueOf(JSON.stringify(['ok', scene, [], []]))
    expect(lay(plain, comment)).toEqual({ scene, degradations: [] })
  })

  it('reads a missing section, a decline and a cap as the root answers them', () => {
    expect(lay(glueOf('["missing","section"]').glue, note)).toEqual({ missing: 'section' })
    expect(lay(glueOf('["declined","body"]').glue, note)).toEqual({ declined: 'body' })
    const capped = glueOf('["refused","input-too-large","bodies"]').glue
    expect(lay(capped, note)).toEqual({ declined: 'bodies' })
  })

  it('asks the highlighter for the fences the core needs, and declines without one', () => {
    const needs = JSON.stringify(['needs', { code: [['ts', 'x']] }])
    expect(lay(glueOf(needs).glue, note)).toEqual({ declined: 'highlight' })
    const { glue, sent } = glueOf(needs, JSON.stringify(['ok', { nodes: [] }, [], []]))
    expect(lay(glue, note, () => undefined)).toEqual({ scene: { nodes: [] }, degradations: [] })
    expect(JSON.stringify(sent[1])).toContain('"codeTokens",["s",["s","ts","x",null]]')
  })

  it('refuses an answer that carries anchors or is not one', () => {
    const anchored = JSON.stringify(['ok', { nodes: [] }, [['e', {}]], []])
    expect(() => lay(glueOf(anchored).glue, note)).toThrow('malformed answer')
    expect(() => lay(glueOf('["missing","part"]').glue, note)).toThrow('malformed')
  })
})
