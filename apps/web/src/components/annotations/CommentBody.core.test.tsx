import {
  constantRatioMeasureText,
  type MarkdownLayoutCore,
} from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentLayoutCore } from '../../lib/spatial/layout-core.js'
import { CommentBody } from './CommentBody.js'

vi.mock('../../lib/spatial/layout-core.js', () => ({
  currentLayoutCore: vi.fn(),
  layoutCoreReady: vi.fn(),
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
      },
    ])
    expect(container.textContent).toContain('from the core')
  })

  it('draws the TypeScript in a realm that holds no core', () => {
    vi.mocked(currentLayoutCore).mockReturnValue(undefined)
    const { container } = render(
      <CommentBody body="Please **tighten** this" measure={constantRatioMeasureText} />,
    )
    expect(container.textContent).toContain('tighten')
    expect(container.textContent).not.toContain('from the core')
  })
})
