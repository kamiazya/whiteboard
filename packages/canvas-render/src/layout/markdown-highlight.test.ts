// Syntax highlighting enters through an INJECTED SEAM, the same class as
// `renderMath` / `renderDiagram` / `resolveEmbed`: canvas-render is allowed
// two third-party dependencies and a highlighter is not going to be the
// third. The seam carries ROLES rather than colours, so the palette stays
// with the one appearance producer instead of moving into each composition
// root, and it is TOTAL from this side — a throw, an unknown language or a
// line count that disagrees with the source all degrade to plain code.
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const options = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }
const SYNTAX = {
  keyword: '#9333ea',
  string: '#059669',
  number: '#ea580c',
  comment: '#767d87',
}
const root: MdastRoot = {
  type: 'root',
  children: [{ type: 'code', lang: 'ts', meta: null, value: 'const x = 1\n// note' }],
}

const codeRuns = (opts: Record<string, unknown>) => {
  const scene = layoutMdastBlocks(root, { ...options, ...opts })
  const code = scene.nodes.find((node) => node.kind === 'codeBlock')
  if (code === undefined || code.kind !== 'codeBlock') throw new Error('expected a codeBlock')
  return code.runs ?? []
}

describe('highlightCode is a seam, and the palette stays here', () => {
  it('splits a line into runs whose fills come from the SYNTAX palette', () => {
    const runs = codeRuns({
      syntax: SYNTAX,
      highlightCode: () => [
        [
          { text: 'const', role: 'keyword' as const },
          { text: ' x = ' },
          { text: '1', role: 'number' as const },
        ],
        [{ text: '// note', role: 'comment' as const }],
      ],
    })
    expect(runs.map((run) => run.text)).toEqual(['const', ' x = ', '1', '// note'])
    expect(runs.map((run) => run.appearance?.fill)).toEqual([
      SYNTAX.keyword,
      undefined,
      SYNTAX.number,
      SYNTAX.comment,
    ])
  })

  it('lays the runs of one source line on one line box, left to right', () => {
    const runs = codeRuns({
      syntax: SYNTAX,
      highlightCode: () => [
        [{ text: 'const', role: 'keyword' as const }, { text: ' x = 1' }],
        [{ text: '// note', role: 'comment' as const }],
      ],
    })
    expect(runs[0]?.bbox.y).toBe(runs[1]?.bbox.y)
    expect(runs[1]?.bbox.x).toBeGreaterThan(runs[0]?.bbox.x ?? 0)
    expect(runs[2]?.bbox.y).toBeGreaterThan(runs[0]?.bbox.y ?? 0)
  })

  it('degrades to plain code when the highlighter throws', () => {
    const runs = codeRuns({
      syntax: SYNTAX,
      highlightCode: () => {
        throw new Error('grammar blew up')
      },
    })
    expect(runs.map((run) => run.text)).toEqual(['const x = 1', '// note'])
  })

  it('degrades to plain code when the highlighter returns undefined', () => {
    const runs = codeRuns({ syntax: SYNTAX, highlightCode: () => undefined })
    expect(runs.map((run) => run.text)).toEqual(['const x = 1', '// note'])
  })

  it('refuses a tokenisation whose line count disagrees with the source', () => {
    // The source is the authority on how many lines a fence has; a grammar
    // that says otherwise would change the block's height.
    const runs = codeRuns({
      syntax: SYNTAX,
      highlightCode: () => [[{ text: 'const x = 1' }]],
    })
    expect(runs.map((run) => run.text)).toEqual(['const x = 1', '// note'])
  })

  it('still fits a highlighted line to the panel', () => {
    const wide: MdastRoot = {
      type: 'root',
      children: [{ type: 'code', lang: 'ts', meta: null, value: 'x'.repeat(400) }],
    }
    const scene = layoutMdastBlocks(wide, {
      ...options,
      maxWidth: 200,
      syntax: SYNTAX,
      highlightCode: () => [[{ text: 'x'.repeat(400), role: 'string' as const }]],
    })
    const code = scene.nodes.find((node) => node.kind === 'codeBlock')
    if (code === undefined || code.kind !== 'codeBlock') throw new Error('expected a codeBlock')
    for (const run of code.runs ?? []) {
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(code.bbox.x + code.bbox.w)
    }
  })
})
