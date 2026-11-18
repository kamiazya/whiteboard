import { describe, expect, it } from 'vitest'
import { highlightCode } from '../highlight/lowlight.js'
import type {
  MarkdownCommentRequest,
  MarkdownLayoutCore,
  MarkdownNoteRequest,
} from '../markdown-core.js'
import { constantRatioMeasureText, describeMeasure, measureSpecOf } from '../measure.js'
import { referenceSeams } from '../references/seams.js'
import { overlayReferences, referenceSeamsFromWire, referenceWire } from '../references/wire.js'
import { refusalScene } from '../refusal.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { testLayoutCore } from '../test-utils/test-layout-core.js'
import { CoreUnaskable } from './canvas-switch.js'
import {
  layoutCommentDocument,
  layoutMarkdownDocument,
  type MarkdownDocumentOptions,
  markdownLayoutRequest,
} from './markdown-switch.js'

const measure = createFakeMeasure()
const body = '# Plan\n\nFirst $x^2$ here.\n\n## Detail\n\nMore words.'
const base: MarkdownDocumentOptions = { core: testLayoutCore(), measure, maxWidth: 400 }

/** A note's scene, as a canned answer a fake core gives. */
const laid = layoutMarkdownDocument(body, base)
if (laid === undefined) throw new Error('the note has no section to miss')
const reference = laid

type Answering = (
  request: MarkdownNoteRequest | MarkdownCommentRequest,
) => ReturnType<MarkdownLayoutCore['layoutMarkdown']>

const realCore = testLayoutCore()

function coreOf(answer: Answering) {
  const requests: (MarkdownNoteRequest | MarkdownCommentRequest)[] = []
  const highlighters: unknown[] = []
  const measurers: unknown[] = []
  const core = fakeLayoutCore({
    // A refusal is drawn as the real core's notice.
    query: realCore.query,
    markdown: {
      layoutMarkdown: (request, highlight, measurer) => {
        requests.push(request)
        highlighters.push(highlight)
        measurers.push(measurer)
        return answer(request)
      },
    },
  })
  return { core, requests, highlighters, measurers }
}

const agreeing: Answering = () => ({ scene: reference, degradations: [] })

function run(answer: Answering, options: Partial<MarkdownDocumentOptions> = {}, text = body) {
  const { core, requests, highlighters } = coreOf(answer)
  const scene = layoutMarkdownDocument(text, { ...base, ...options, core })
  return { scene, requests, highlighters }
}

describe('a markdown note through the core', () => {
  it('answers with the core, handing it the default highlighter', () => {
    const moved = { nodes: reference.nodes.slice(1) }
    const { scene, requests, highlighters } = run(() => ({ scene: moved, degradations: [] }))
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

  it('draws a note the core refuses as the refusal at its width', () => {
    const refused = { code: 'input-too-large', reason: 'bodies' } as const
    const heard: unknown[] = []
    const onRefused = (refusal: unknown) => heard.push(refusal)
    const drawn = run(() => ({ refused }), { mode: 'dark', onRefused })
    expect(drawn.scene).toEqual(refusalScene(refused, { measure, mode: 'dark', maxWidth: 400 }))
    expect(heard).toEqual([refused])
  })

  it('answers undefined for a section the core reports missing, as the TypeScript does', () => {
    expect(layoutMarkdownDocument(body, { ...base, section: 'Nowhere' })).toBeUndefined()
    const { scene } = run(() => ({ missing: 'section' }), { section: 'Nowhere' })
    expect(scene).toBeUndefined()
  })

  it('hands the fragments the core asked for to the listener', () => {
    const heard: unknown[] = []
    run(
      () => ({
        scene: reference,
        degradations: [],
        fragmentsAsked: [{ kind: 'math', value: 'x^2' }],
      }),
      { onFragmentsAsked: (asks) => heard.push(asks) },
    )
    expect(heard).toEqual([[{ kind: 'math', value: 'x^2' }]])
  })

  it('throws what the core throws: there is no TypeScript to answer in its place', () => {
    const err = new Error('shim')
    expect(() =>
      run(() => {
        throw err
      }),
    ).toThrow(err)
  })

  it('throws for options no request can carry, asking the core nothing', () => {
    const fromGraph = referenceSeams(new Map([['b', { documentId: 'D', body: 'x' }]]))
    const withContent = referenceSeamsFromWire(
      overlayReferences(referenceWire(new Map()), { labels: new Map() }),
    )
    const carrying = referenceSeamsFromWire({
      ...referenceWire(new Map()),
      extras: [['p', { markdown: { type: 'root', children: [] } }]],
    })
    const cases = [
      [{ references: fromGraph }, 'references'],
      [{ references: carrying }, 'reference-content'],
    ] as const
    for (const [options, reason] of cases) {
      const { core, requests } = coreOf(agreeing)
      expect(() => layoutMarkdownDocument(body, { ...base, ...options, core }), reason).toThrow(
        new CoreUnaskable(reason),
      )
      expect(requests, reason).toEqual([])
    }
    expect(run(agreeing, { references: withContent }).requests).toHaveLength(1)
  })
})

describe("a comment's prose through the core", () => {
  const prose = 'Please **tighten** this, and `rename` it.'
  const lay = (answer: Answering, density?: 'compact') => {
    const { core, requests } = coreOf(answer)
    const scene = layoutCommentDocument(prose, {
      measure,
      maxWidth: 260,
      ...(density === undefined ? {} : { density }),
      core,
    })
    return { scene, requests }
  }
  const sceneOf = { nodes: [] }

  it("answers with the core, handing it a comment's request", () => {
    const { scene, requests } = lay(() => ({ scene: sceneOf, degradations: [] }), 'compact')
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
  })

  it('draws a comment the core refuses as the refusal at its width', () => {
    const refused = { code: 'malformed', reason: 'host-measure' } as const
    const drawn = lay(() => ({ refused }))
    expect(drawn.scene).toEqual(refusalScene(refused, { measure, mode: 'light', maxWidth: 260 }))
  })

  it('draws a refusal the host measurer caused without asking that measurer again', () => {
    const refused = { code: 'malformed', reason: 'host-measure' } as const
    const failing = describeMeasure(
      () => {
        throw new Error('no canvas context')
      },
      { kind: 'host' },
    )
    const { core } = coreOf(() => ({ refused }))
    const scene = layoutCommentDocument(prose, { measure: failing, maxWidth: 260, core })
    const drawn = refusalScene(refused, {
      measure: constantRatioMeasureText,
      mode: 'light',
      maxWidth: 260,
    })
    expect(scene).toEqual(drawn)
  })

  it('throws what the core throws, and an answer a comment cannot have', () => {
    const err = new Error('boom')
    expect(() =>
      lay(() => {
        throw err
      }),
    ).toThrow(err)
    expect(() => lay(() => ({ missing: 'section' }))).toThrow(/missing its section/)
  })

  it('names a measurer nobody named as the host, and hands the core that measurer', () => {
    const { core, requests, measurers } = coreOf(() => ({ scene: sceneOf, degradations: [] }))
    const unnamed = (...args: Parameters<typeof measure>) => measure(...args)
    layoutCommentDocument(prose, { measure: unnamed, maxWidth: 260, core })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ kind: 'comment', measure: { kind: 'host' } })
    expect(measurers).toEqual([unnamed])
  })
})
