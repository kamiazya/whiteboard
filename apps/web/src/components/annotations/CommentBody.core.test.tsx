import {
  constantRatioMeasureText,
  type MarkdownLayoutCore,
  refusalCopy,
} from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore, fakePicture } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentLayoutCore } from '../../lib/spatial/layout-core.js'
import { CommentBody } from './CommentBody.js'

vi.mock('../../lib/spatial/layout-core.js', () => ({
  currentLayoutCore: vi.fn(),
  layoutCoreReady: vi.fn(),
  // The body redraws when the core loads; nothing here announces one.
  layoutCoreGeneration: () => 0,
  subscribeLayoutCore: () => () => undefined,
}))

afterEach(cleanup)

/** A core recording each body it is handed and answering one run. */
function recordingCore() {
  const asked: Parameters<MarkdownLayoutCore['layoutMarkdown']>[0][] = []
  const core = fakeLayoutCore({
    markdown: {
      layoutMarkdown: (request) => {
        asked.push(request)
        return {
          scene: {
            nodes: [
              {
                kind: 'textRun',
                text: 'from the core',
                bbox: { x: 0, y: 0, w: 80, h: 16 },
                baseline: 12,
                font: { family: 'Roboto', sizePx: 12, weight: 400, style: 'normal' },
              } as never,
            ],
          },
          degradations: [],
          ...fakePicture(request, '<text>the core drew this</text>'),
        }
      },
    },
  })
  return { core, asked }
}

describe("a comment's prose through the core", () => {
  beforeEach(() => vi.mocked(currentLayoutCore).mockReset())

  it('hands the core the comment at the density its surface has, and draws its answer', () => {
    const { core, asked } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    const { container } = render(
      <CommentBody body="Please **tighten** this" compact measure={constantRatioMeasureText} />,
    )
    expect(asked).toEqual([
      {
        kind: 'comment',
        body: 'Please **tighten** this',
        maxWidth: 198,
        measure: { kind: 'ratio' },
        density: 'compact',
        // The keyed projection is asked in the same call, at the body's padding.
        svg: { padding: 1, form: 'keyed' },
      },
    ])
    // The body paints the core's picture, never one drawn here from its scene.
    expect(container.textContent).toContain('the core drew this')
    expect(container.textContent).not.toContain('from the core')
  })

  it('draws the core-unavailable notice in a realm whose core did not load', () => {
    // After a failed load the realm's core refuses every layout as
    // `core-unavailable`; the prose is not drawn by anything in its place.
    const unavailable = { code: 'malformed', reason: 'core-unavailable' } as const
    vi.mocked(currentLayoutCore).mockReturnValue(
      fakeLayoutCore({
        markdown: { layoutMarkdown: () => ({ refused: unavailable }) },
        // It refuses the notice too, so the words are said in HTML.
        query: { layoutQuery: () => ({ refused: unavailable }) },
      }),
    )
    const { container } = render(
      <CommentBody body="Please **tighten** this" measure={constantRatioMeasureText} />,
    )
    const { title, detail } = refusalCopy(unavailable)
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`${title}${detail}`)
    expect(container.textContent).not.toContain('tighten')
  })
})
