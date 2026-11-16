import {
  type CoreMismatch,
  constantRatioMeasureText,
  type LayoutCore,
  type MarkdownBodyRequest,
} from '@kamiazya/whiteboard-canvas-render'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentLayoutCore } from '../../lib/spatial/layout-core.js'
import { CommentBody } from './CommentBody.js'

vi.mock('../../lib/spatial/layout-core.js', () => ({
  currentLayoutCore: vi.fn(),
  layoutCoreReady: vi.fn(),
}))

afterEach(cleanup)

/** A core whose markdown switch reads `rust`, recording each body it is handed and answering one run. */
function recordingCore() {
  const asked: MarkdownBodyRequest[] = []
  const reports: CoreMismatch[] = []
  const core: LayoutCore = {
    routing: { routeLayout: () => ({ routes: [], anchors: new Map() }) as never },
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
    impl: { routeLayout: 'ts', layoutMarkdown: 'rust' },
    onMismatch: (report) => reports.push(report),
  }
  return { core, asked, reports }
}

describe("a comment's prose through the core", () => {
  beforeEach(() => vi.mocked(currentLayoutCore).mockReset())

  it('hands the core the comment at the density its surface has, and draws its answer', () => {
    const { core, asked, reports } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    const { container } = render(
      <CommentBody body="Please **tighten** this" compact measure={constantRatioMeasureText} />,
    )
    expect(reports).toEqual([])
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

  it('draws the TypeScript where no core is loaded', () => {
    vi.mocked(currentLayoutCore).mockReturnValue(undefined)
    const { container } = render(
      <CommentBody body="Please **tighten** this" measure={constantRatioMeasureText} />,
    )
    expect(container.textContent).toContain('tighten')
    expect(container.textContent).not.toContain('from the core')
  })
})
