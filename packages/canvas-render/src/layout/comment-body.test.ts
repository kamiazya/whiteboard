// The one producer of a comment's prose. What it has to hold is that a
// SECOND surface drawing the same comment gets the bubble's answer rather
// than the document's — the failure this exists to prevent is silent, since
// document typography on a comment looks like a design choice.
import { describe, expect, it } from 'vitest'
import type { SceneNode, TextRunNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { MARKDOWN_THEME_DOCUMENT, MARKDOWN_THEME_NODE } from '../theme/markdown-theme.js'
import { COMMENT_TEXT_MAX_WIDTH_PX, layoutCommentBody } from './comment-body.js'

const measure = createFakeMeasure()

/** The measurer plus the one field every body layout requires. */
const base = { measure, fontFamily: 'sans-serif' } as const

function runs(nodes: readonly SceneNode[]): TextRunNode[] {
  const out: TextRunNode[] = []
  const stack = [...nodes]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) continue
    if (node.kind === 'textRun') out.push(node)
    // A block carries its runs under `runs`; nested blocks (list items,
    // table cells) carry blocks under `children`.
    for (const key of ['runs', 'children'] as const) {
      const nested = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(nested)) stack.push(...(nested as SceneNode[]))
    }
  }
  return out
}

it('reads the body as markdown, so emphasis is emphasis rather than four asterisks', () => {
  const scene = layoutCommentBody('**tighten** this', { ...base })
  const text = runs(scene.nodes)
    .map((run) => run.text)
    .join('')
  expect(text).toContain('tighten')
  expect(text).not.toContain('**')
})

/**
 * The discriminating case, and it has to be a HEADING: the node and document
 * themes agree on body size (16px) and differ on heading sizes (24 vs 30 at
 * h1) and block gap (12 vs 16). A test written on a paragraph passes under
 * either theme and says nothing.
 */
it('lays a heading out at the bubble metrics, not the document ones', () => {
  const scene = layoutCommentBody('# Heading', { ...base })
  const heading = runs(scene.nodes)[0]
  expect(heading?.appearance?.fontSize).toBe(MARKDOWN_THEME_NODE.headingFontSizePx[1])
  expect(MARKDOWN_THEME_DOCUMENT.headingFontSizePx[1]).not.toBe(
    MARKDOWN_THEME_NODE.headingFontSizePx[1],
  )
})

it('wraps to the comment measure when the surface names none', () => {
  const long = 'wrap '.repeat(60)
  const scene = layoutCommentBody(long, { ...base })
  for (const run of runs(scene.nodes)) {
    expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(COMMENT_TEXT_MAX_WIDTH_PX + 1)
  }
})

it('takes the measure a wider surface names, and stays otherwise identical', () => {
  const scene = layoutCommentBody('# Heading', { ...base, maxWidth: 480 })
  expect(runs(scene.nodes)[0]?.appearance?.fontSize).toBe(MARKDOWN_THEME_NODE.headingFontSizePx[1])
})

describe('a body that will not parse', () => {
  const boom = () => {
    throw new Error('mid-edit')
  }

  it('still draws the text, and says so once', () => {
    const failures: unknown[] = []
    const scene = layoutCommentBody('half a sentence', {
      ...base,
      parseBody: boom,
      onParseFailure: (err) => failures.push(err),
    })
    expect(
      runs(scene.nodes)
        .map((run) => run.text)
        .join(''),
    ).toContain('half a sentence')
    expect(failures).toHaveLength(1)
  })

  it('degrades without a reporter too — an unreported failure still draws', () => {
    const scene = layoutCommentBody('half a sentence', { ...base, parseBody: boom })
    expect(runs(scene.nodes)).not.toHaveLength(0)
  })
})
