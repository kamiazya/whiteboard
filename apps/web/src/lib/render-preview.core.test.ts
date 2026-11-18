// @vitest-environment node

import {
  constantRatioMeasureText,
  type MarkdownNoteRequest,
  referenceSeamsFromWire,
  referenceWire,
  type Scene,
} from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore, fakePicture } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingFragmentTable } from './fragment-requests.js'
import { layoutMarkdownOutline, renderMarkdownPreview } from './render-preview.js'
import { currentLayoutCore } from './spatial/layout-core.js'

vi.mock('./spatial/layout-core.js', () => ({
  currentLayoutCore: vi.fn(),
  layoutCoreReady: vi.fn(),
}))

const measure = constantRatioMeasureText
/** One run the TypeScript would never draw for these bodies, so the answer is plainly the core's. */
const CORE_SCENE = {
  nodes: [
    {
      kind: 'textRun',
      text: 'from the core',
      bbox: { x: 0, y: 0, w: 100, h: 20 },
      baseline: 16,
      font: { family: 'Roboto', sizePx: 16, weight: 400, style: 'normal' },
    },
  ],
} as unknown as Scene

/** A core recording every note it is handed. */
function recordingCore() {
  const asked: MarkdownNoteRequest[] = []
  const core = fakeLayoutCore({
    markdown: {
      layoutMarkdown: (request) => {
        // A note's layout only: a comment never reaches these surfaces.
        if (request.kind === 'markdown') asked.push(request)
        return {
          scene: CORE_SCENE,
          degradations: [],
          ...fakePicture(request, '<text>the core drew this</text>'),
        }
      },
    },
  })
  return { core, asked }
}

describe('the preview pane lays its note out through the core', () => {
  beforeEach(() => vi.mocked(currentLayoutCore).mockReset())

  it('hands the core the whole note as the page draws it, and paints its answer', () => {
    const { core, asked } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    const table = recordingFragmentTable([])
    const { keyed } = renderMarkdownPreview('# Title\n\n$$x$$', {
      measure,
      maxWidth: 480,
      theme: 'dark',
      fragments: table,
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      kind: 'markdown',
      body: '# Title\n\n$$x$$',
      maxWidth: 480,
      mode: 'dark',
      style: 'document',
      measure: { kind: 'ratio' },
      fragments: [],
      // The keyed projection is asked in the same call, at the pane's padding.
      svg: { padding: 8, form: 'keyed' },
    })
    // The page paints the core's picture, never one drawn here from its scene.
    expect(keyed.svg).toContain('the core drew this')
    expect(keyed.svg).not.toContain('from the core')
  })

  it('hands the core the references as their wire', () => {
    const { core, asked } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    const wire = referenceWire(new Map([['other', { body: 'hi', name: 'Other' }]]))
    renderMarkdownPreview('[[other]]', {
      measure,
      maxWidth: 480,
      references: referenceSeamsFromWire(wire),
    })
    expect(asked[0]?.references).toBe(wire)
  })

  it('reports the fragments the core could not answer to the table', () => {
    const { core } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue({
      ...core,
      markdown: {
        layoutMarkdown: (request) => ({
          scene: CORE_SCENE,
          degradations: [],
          fragmentsAsked: [{ kind: 'math', value: 'x' }],
          ...fakePicture(request, ''),
        }),
      },
    })
    const table = recordingFragmentTable([])
    renderMarkdownPreview('$$x$$', { measure, maxWidth: 480, fragments: table })
    expect([...table.asked.values()]).toEqual([{ kind: 'math', value: 'x' }])
  })

  it('lays the outline rail out through the core too', () => {
    const { core, asked } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    const { blocks } = layoutMarkdownOutline('# Title', { measure, maxWidth: 320 })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'markdown', maxWidth: 320, mode: 'light' })
    expect(blocks).toHaveLength(1)
  })
})
