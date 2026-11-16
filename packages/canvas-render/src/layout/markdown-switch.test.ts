import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import { describe, expect, it } from 'vitest'
import { highlightCode } from '../highlight/lowlight.js'
import type {
  MarkdownCommentRequest,
  MarkdownLayoutAnswer,
  MarkdownNoteRequest,
} from '../markdown-core.js'
import { constantRatioMeasureText, describeMeasure, measureSpecOf } from '../measure.js'
import { referenceSeams } from '../references/seams.js'
import { overlayReferences, referenceSeamsFromWire, referenceWire } from '../references/wire.js'
import { refusalScene } from '../refusal.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import { MARKDOWN_THEME_DOCUMENT } from '../theme/markdown-theme.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { COMMENT_TEXT_MAX_WIDTH_PX, layoutCommentBody } from './comment-body.js'
import type { CoreImpl, CoreMismatch, LayoutCore } from './edges/layout-core.js'
import { layoutMdastBlocks } from './markdown-body.js'
import {
  layoutCommentDocument,
  layoutMarkdownDocument,
  type MarkdownDocumentOptions,
  markdownLayoutRequest,
} from './markdown-switch.js'

const measure = createFakeMeasure()
const body = '# Plan\n\nFirst $x^2$ here.\n\n## Detail\n\nMore words.'
const base: MarkdownDocumentOptions = { measure, maxWidth: 400 }

/** What the TypeScript draws for `text`, as every surface laid a note out before the switch. */
const typescript = (text: string) =>
  layoutMdastBlocks(parseMarkdownBody(text), {
    measure,
    maxWidth: 400,
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    theme: MARKDOWN_THEME_DOCUMENT,
    canvasAppearance: createSpatialTheme({ mode: 'light' }),
  })
const reference = typescript(body)

type Answering = (request: MarkdownNoteRequest | MarkdownCommentRequest) => MarkdownLayoutAnswer

function coreOf(impl: CoreImpl, answer: Answering) {
  const requests: (MarkdownNoteRequest | MarkdownCommentRequest)[] = []
  const highlighters: unknown[] = []
  const mismatches: CoreMismatch[] = []
  const core: LayoutCore = {
    routing: {
      routeLayout: () => {
        throw new Error('the routing core is not asked here')
      },
    },
    markdown: {
      layoutMarkdown: (request, highlight) => {
        requests.push(request)
        highlighters.push(highlight)
        return answer(request)
      },
    },
    impl: { routeLayout: 'ts', layoutMarkdown: impl },
    onMismatch: (mismatch) => mismatches.push(mismatch),
  }
  return { core, requests, highlighters, mismatches }
}

const agreeing: Answering = () => ({ scene: reference, degradations: [] })

function run(
  impl: CoreImpl,
  answer: Answering,
  options: Partial<MarkdownDocumentOptions> = {},
  text = body,
) {
  const { core, requests, highlighters, mismatches } = coreOf(impl, answer)
  const scene = layoutMarkdownDocument(text, { ...base, ...options, core })
  return { scene, requests, highlighters, mismatches }
}

describe('a markdown note through the core switch', () => {
  it('lays a note out as layoutMdastBlocks does with no core, and under ts asks none', () => {
    expect(layoutMarkdownDocument(body, base)).toEqual(reference)
    const { scene, requests } = run('ts', agreeing)
    expect(scene).toEqual(reference)
    expect(requests).toEqual([])
    const { core } = coreOf('rust', agreeing)
    const unswitched: LayoutCore = { ...core, impl: { routeLayout: 'ts' } }
    expect(layoutMarkdownDocument(body, { ...base, core: unswitched })).toEqual(reference)
  })

  it('answers with the core under rust, handing it the default highlighter', () => {
    const moved = { nodes: reference.nodes.slice(1) }
    const { scene, requests, highlighters, mismatches } = run('rust', () => ({
      scene: moved,
      degradations: [],
    }))
    expect(scene).toBe(moved)
    expect(requests).toEqual([
      {
        kind: 'markdown',
        body,
        maxWidth: 400,
        measure: { kind: 'fake', factor: 0.6 },
        mode: 'light',
      },
    ])
    expect(highlighters).toEqual([highlightCode])
    expect(mismatches).toEqual([])
  })

  it('carries every option a surface varies as data', () => {
    const library = { health: { values: { ok: { color: '4' } } } }
    const wire = referenceWire(new Map([['b', { documentId: 'D', body: 'x' }]]))
    const references = referenceSeamsFromWire(wire)
    const fragments = [['math:x^2', { svg: '<g/>' }]] as const
    const ask = markdownLayoutRequest(body, {
      ...base,
      mode: 'dark',
      style: 'document',
      fontAvailable: () => true,
      tagLibrary: library,
      references,
      fragments,
      section: 'Detail',
    })
    expect(ask).toMatchObject({
      mode: 'dark',
      style: 'document',
      tagLibrary: library,
      references: wire,
      fragments,
      section: 'Detail',
    })
    expect('fontFamilies' in ask && ask.fontFamilies?.length).toBeGreaterThan(0)
    expect(markdownLayoutRequest(body, { ...base, onFragmentsAsked: () => {} })).toMatchObject({
      fragments: [],
    })
  })

  it('draws a note the core refuses as the refusal at its width under rust', () => {
    const refused = { code: 'input-too-large', reason: 'bodies' } as const
    const heard: unknown[] = []
    const drawn = run('rust', () => ({ refused }), {
      mode: 'dark',
      onRefused: (refusal) => heard.push(refusal),
    })
    expect(drawn.scene).toEqual(refusalScene(refused, { measure, mode: 'dark', maxWidth: 400 }))
    expect(drawn.mismatches).toEqual([{ fn: 'layoutMarkdown', kind: 'declined', reason: 'bodies' }])
    expect(heard).toEqual([refused])
    const oracle = run('differential', () => ({ refused }), { onRefused: (r) => heard.push(r) })
    expect(oracle.scene).toEqual(reference)
    expect(heard).toHaveLength(1)
  })

  it('answers undefined for a section the core reports missing, as the TypeScript does', () => {
    expect(layoutMarkdownDocument(body, { ...base, section: 'Nowhere' })).toBeUndefined()
    for (const impl of ['rust', 'differential'] as const) {
      const { scene, mismatches } = run(impl, () => ({ missing: 'section' }), {
        section: 'Nowhere',
      })
      expect(scene).toBeUndefined()
      expect(mismatches).toEqual([])
    }
  })

  it('hands the fragments the core asked for to the listener under rust', () => {
    const heard: unknown[] = []
    run(
      'rust',
      () => ({
        scene: reference,
        degradations: [],
        fragmentsAsked: [{ kind: 'math', value: 'x^2' }],
      }),
      { onFragmentsAsked: (asks) => heard.push(asks) },
    )
    expect(heard).toEqual([[{ kind: 'math', value: 'x^2' }]])
  })

  it('answers with the TypeScript under differential and reports where the core parts', () => {
    const agreed = run('differential', agreeing)
    expect(agreed.scene).toEqual(reference)
    expect(agreed.mismatches).toEqual([])
    const parted = run('differential', () => ({ scene: { nodes: [] }, degradations: [] }))
    expect(parted.scene).toEqual(reference)
    expect(parted.mismatches).toMatchObject([
      { fn: 'layoutMarkdown', kind: 'differs', at: '/scene/nodes/0', repro: { body } },
    ])
    const missing = run('differential', () => ({ missing: 'section' }))
    expect(missing.mismatches).toMatchObject([{ kind: 'differs', at: '/scene', rust: 'missing' }])
  })

  it('compares the fragments asked under differential', () => {
    const asked = { kind: 'math', value: 'x^2' } as const
    const heard: unknown[] = []
    const display = '$$\nx^2\n$$'
    const { mismatches } = run(
      'differential',
      () => ({ scene: typescript(display), degradations: [], fragmentsAsked: [] }),
      { fragments: [], onFragmentsAsked: (asks) => heard.push(asks) },
      display,
    )
    expect(mismatches).toMatchObject([{ kind: 'differs', at: '/asked/0', ts: asked }])
    expect(heard).toEqual([[asked]])
  })

  it('answers from the TypeScript what the core declines or throws on, reporting each', () => {
    const declined = run('rust', () => ({ declined: 'body' }))
    expect(declined.scene).toEqual(reference)
    expect(declined.mismatches).toEqual([
      { fn: 'layoutMarkdown', kind: 'declined', reason: 'body' },
    ])
    const thrown = run('rust', () => {
      throw new Error('shim')
    })
    expect(thrown.scene).toEqual(reference)
    expect(thrown.mismatches).toMatchObject([{ fn: 'layoutMarkdown', kind: 'refused' }])
  })

  it('reports a note the request gate skips by its class, asking the core nothing', () => {
    const unnamed: MarkdownDocumentOptions['measure'] = (text, font) => measure(text, font)
    const fromGraph = referenceSeams(new Map([['b', { documentId: 'D', body: 'x' }]]))
    const withContent = referenceSeamsFromWire(
      overlayReferences(referenceWire(new Map()), { labels: new Map() }),
    )
    const carrying = referenceSeamsFromWire({
      ...referenceWire(new Map()),
      extras: [['p', { markdown: { type: 'root', children: [] } }]],
    })
    const cases = [
      [{ measure: unnamed }, 'measure'],
      [{ references: fromGraph }, 'references'],
      [{ references: carrying }, 'reference-content'],
    ] as const
    for (const [options, reason] of cases) {
      const { requests, mismatches } = run('rust', agreeing, options)
      expect(requests, reason).toEqual([])
      expect(mismatches, reason).toEqual([{ fn: 'layoutMarkdown', kind: 'skipped', reason }])
    }
    expect(run('rust', agreeing, { references: withContent }).requests).toHaveLength(1)
  })
})

describe("a comment's prose through the core switch", () => {
  const prose = 'Please **tighten** this, and `rename` it.'
  /** What the TypeScript draws, as `CommentBody.tsx` laid a comment out before the switch. */
  const commentTs = (density: 'comfortable' | 'compact' = 'comfortable', maxWidth = 260) =>
    layoutCommentBody(prose, { measure, fontFamily: SPATIAL_THEME_FONT_FAMILY, maxWidth, density })
  const lay = (impl: CoreImpl, answer: Answering, density?: 'compact') => {
    const { core, requests, mismatches } = coreOf(impl, answer)
    const scene = layoutCommentDocument(prose, {
      measure,
      maxWidth: 260,
      ...(density === undefined ? {} : { density }),
      core,
    })
    return { scene, requests, mismatches }
  }
  const sceneOf = { nodes: [] }

  it('lays a comment out as layoutCommentBody does with no core, and under ts asks none', () => {
    expect(layoutCommentDocument(prose, { measure, maxWidth: 260 })).toEqual(commentTs())
    expect(layoutCommentDocument(prose, { measure })).toEqual(
      commentTs('comfortable', COMMENT_TEXT_MAX_WIDTH_PX),
    )
    const { scene, requests } = lay('ts', () => ({ scene: sceneOf, degradations: [] }))
    expect(scene).toEqual(commentTs())
    expect(requests).toEqual([])
  })

  it("answers with the core under rust, handing it a comment's request", () => {
    const { scene, requests, mismatches } = lay(
      'rust',
      () => ({ scene: sceneOf, degradations: [] }),
      'compact',
    )
    expect(scene).toBe(sceneOf)
    expect(requests).toEqual([
      {
        kind: 'comment',
        body: prose,
        maxWidth: 260,
        measure: measureSpecOf(measure),
        density: 'compact',
      },
    ])
    expect(mismatches).toEqual([])
  })

  it('answers with the TypeScript under differential and reports where the core parts', () => {
    const same = lay('differential', () => ({ scene: commentTs(), degradations: [] }))
    expect(same.scene).toEqual(commentTs())
    expect(same.mismatches).toEqual([])
    const differs = lay('differential', () => ({ scene: sceneOf, degradations: [] }))
    expect(differs.scene).toEqual(commentTs())
    expect(differs.mismatches.map((m) => [m.fn, m.kind])).toEqual([['layoutMarkdown', 'differs']])
  })

  it('draws a comment the core refuses as the refusal at its width under rust', () => {
    const refused = { code: 'malformed', reason: 'host-measure' } as const
    const drawn = lay('rust', () => ({ refused }))
    expect(drawn.scene).toEqual(refusalScene(refused, { measure, mode: 'light', maxWidth: 260 }))
    expect(drawn.mismatches).toEqual([
      { fn: 'layoutMarkdown', kind: 'declined', reason: 'host-measure' },
    ])
    expect(lay('differential', () => ({ refused })).scene).toEqual(commentTs())
  })

  it('draws a refusal the host measurer caused without asking that measurer again', () => {
    const refused = { code: 'malformed', reason: 'host-measure' } as const
    const failing = describeMeasure(
      () => {
        throw new Error('no canvas context')
      },
      { kind: 'host' },
    )
    const { core } = coreOf('rust', () => ({ refused }))
    const scene = layoutCommentDocument(prose, { measure: failing, maxWidth: 260, core })
    const drawn = refusalScene(refused, {
      measure: constantRatioMeasureText,
      mode: 'light',
      maxWidth: 260,
    })
    expect(scene).toEqual(drawn)
  })

  it('answers from the TypeScript what the core declines, throws on, or answers as a note', () => {
    const declined = lay('rust', () => ({ declined: 'body' }))
    expect(declined.scene).toEqual(commentTs())
    expect(declined.mismatches).toEqual([
      { fn: 'layoutMarkdown', kind: 'declined', reason: 'body' },
    ])
    const thrown = lay('rust', () => {
      throw new Error('boom')
    })
    expect(thrown.scene).toEqual(commentTs())
    expect(thrown.mismatches.map((m) => m.kind)).toEqual(['refused'])
    const missing = lay('rust', () => ({ missing: 'section' }))
    expect(missing.scene).toEqual(commentTs())
    expect(missing.mismatches.map((m) => m.kind)).toEqual(['refused'])
  })

  it('skips a measurer nobody named, asking the core nothing', () => {
    const { core, requests, mismatches } = coreOf('rust', () => ({
      scene: sceneOf,
      degradations: [],
    }))
    const unnamed = (...args: Parameters<typeof measure>) => measure(...args)
    const scene = layoutCommentDocument(prose, { measure: unnamed, maxWidth: 260, core })
    expect(scene).toEqual(commentTs())
    expect(requests).toEqual([])
    expect(mismatches).toEqual([{ fn: 'layoutMarkdown', kind: 'skipped', reason: 'measure' }])
  })
})
