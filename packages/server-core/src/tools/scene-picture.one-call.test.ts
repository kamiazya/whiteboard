// A server picture is ONE core call (ADR-0054): `wb_scene_render` and the
// `canvas_view` picture ask the core for the SVG beside the scene, and the
// bytes are the ones the TypeScript backend draws of that scene in the
// envelope each tool always used — `sceneEnvelope`'s view box, and the derived
// envelope on the palette's paper. Every document is rendered through a core
// that records what it answered, so the old expression is judged on the very
// scene the tool drew.

import {
  type CanvasLayoutCore,
  type LayoutCore,
  renderSceneToSvg,
  resolveCanvasPalette,
  type Scene,
} from '@kamiazya/whiteboard-canvas-render'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import { fromJsonCanvas } from '@kamiazya/whiteboard-codec'
import {
  writeCommentThread,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { VISUAL_TAGS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import { sceneEnvelope } from '../render/compose-canvas-scene.js'
import { FakeDocumentStore, placeUnlessPlaced, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasRenderSvgTool } from './canvas-render-svg.js'
import { createCanvasViewTool } from './canvas-view.js'
import { canvasViewPicture } from './canvas-view-picture.js'
import { TAG_LIBRARY_PATH } from './tag-library.js'

const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'
const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const TAGS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8VA'
const EMPTY_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8VB'

const NOTE = [
  '# Weekly notes',
  '',
  'Shipped **it**, with `code` and $x^2$ inline.',
  '',
  '- one',
  '- [x] two',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const answer = 42',
  '```',
  '',
  '## The board',
  '',
  '![[board]]',
].join('\n')

async function seeded(): Promise<FakeDocumentStore> {
  const store = new FakeDocumentStore()
  const place = (documentId: string, path: string, kind: 'spatial' | 'markdown') =>
    store.documentIndex.seed({ workspaceId: WORKSPACE_ID, path, documentId, kind })
  place(BOARD_ID, 'board', 'spatial')
  place(NOTE_ID, 'notes', 'markdown')
  place(TAGS_ID, TAG_LIBRARY_PATH, 'markdown')
  place(EMPTY_ID, 'empty', 'spatial')
  await seedDoc(store, EMPTY_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
  })
  await seedDoc(store, BOARD_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [
        groupNode({ id: 'g1', x: 0, y: 0, width: 640, height: 320, label: 'Area' }),
        textNode({ id: 't1', x: 40, y: 40, width: 160, height: 80, text: '**hello** `x`' }),
        textNode({ id: 't2', x: 40, y: 200, width: 160, height: 60, text: 'b', tags: ['h:ok'] }),
        fileNode({ id: 'f1', x: 260, y: 40, width: 320, height: 240, file: NOTE_ID }),
        textNode({ id: 't3', x: 760, y: 80, width: 140, height: 60, text: 'c', tags: ['h:bad'] }),
      ],
      edges: [
        { id: 'e1', from: { node: 't1' }, to: { node: 't2' }, label: 'next' },
        { id: 'e2', from: { node: 't2' }, to: { node: 't3' } },
      ],
    })
    writeCommentThread(doc, {
      id: 'th',
      anchor: { kind: 'spatial', x: 100, y: 120, nodeId: 't1' },
      status: 'open',
      messages: [{ id: 'm', body: 'a pinned **remark**' }],
    })
  })
  await seedDoc(store, NOTE_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, NOTE)
  })
  await seedDoc(store, TAGS_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeFacets(doc, {
      [VISUAL_TAGS_KEY]: { keys: { h: { values: { ok: { color: '4' }, bad: { color: '1' } } } } },
    } as never)
  })
  await placeUnlessPlaced(store, WORKSPACE_ID, BOARD_ID)
  return store
}

interface Answered {
  readonly scene: Scene
  readonly svg: string
}

/** The test core, recording each SVG it answered with the scene beside it. */
function recordingCore(): { core: LayoutCore; answered: Answered[]; calls: () => number } {
  const real = testLayoutCore()
  const answered: Answered[] = []
  let calls = 0
  const record = <A extends object>(answer: A): A => {
    calls += 1
    if ('scene' in answer && 'svg' in answer) answered.push(answer as unknown as Answered)
    return answer
  }
  const layout: CanvasLayoutCore = {
    layoutSpatialCanvas: (...args) => record(real.layout.layoutSpatialCanvas(...args)),
  }
  const markdown: LayoutCore['markdown'] = {
    layoutMarkdown: (...args) => record(real.markdown.layoutMarkdown(...args)),
  }
  return { core: { ...real, layout, markdown }, answered, calls: () => calls }
}

async function depsOver(core: LayoutCore) {
  const store = await seeded()
  return makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    layoutCore: async () => core,
  })
}

const MARKS = ['next', 'data-wb-legend', 'remark', 'wb-glow', 'Weekly notes', 'Area'] as const

const STYLES = ['clean', 'document', 'visual.sketch', 'visual.neon'] as const

describe('a server picture in one core call', () => {
  test('wb_scene_render draws what renderSceneToSvg drew in the scene envelope', async () => {
    const { core, answered, calls } = recordingCore()
    const tool = createCanvasRenderSvgTool(await depsOver(core))
    let compared = 0
    const drawn = new Set<string>()
    // A part of each: a group's label, a heading; the empty board has none to name.
    const parts: Record<string, string | undefined> = { [BOARD_ID]: 'Area', [NOTE_ID]: 'The board' }
    for (const documentId of [BOARD_ID, NOTE_ID, EMPTY_ID]) {
      for (const style of STYLES) {
        for (const embedReferences of [false, true]) {
          for (const fragment of new Set([undefined, parts[documentId]])) {
            for (const comments of [false, true]) {
              const before = { answered: answered.length, calls: calls() }
              const result = await tool.execute({
                workspaceId: WORKSPACE_ID,
                documentId,
                embedReferences,
                comments,
                style,
                ...(fragment === undefined ? {} : { fragment }),
              })
              const label = `${documentId} ${style} ${embedReferences} ${fragment} ${comments}`
              // One layout call answered the scene and its SVG together.
              expect(calls() - before.calls, label).toBe(1)
              expect(answered.length - before.answered, label).toBe(1)
              const { scene, svg } = answered.at(-1) as Answered
              expect(result.svg === svg, label).toBe(true)
              const envelope = sceneEnvelope(scene)
              const old = renderSceneToSvg(scene, { viewBox: envelope })
              expect(svg === old, label).toBe(true)
              expect([result.width, result.height], label).toEqual([envelope.w, envelope.h])
              for (const mark of MARKS) if (svg.includes(mark)) drawn.add(mark)
              compared += 1
            }
          }
        }
      }
    }
    expect(compared).toBe(80)
    // The documents reach what a picture draws: an edge label, a legend, a
    // comment, a theme's glow, the note's prose and an embedded board.
    expect([...drawn].sort()).toEqual([...MARKS].sort())
  })

  test('the canvas_view picture draws what renderSceneToSvg drew on the palette paper', async () => {
    const { core, answered } = recordingCore()
    const deps = await depsOver(core)
    let compared = 0
    for (const style of [undefined, 'document', 'visual.sketch', 'visual.neon'] as const) {
      const result = await createCanvasViewTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: BOARD_ID,
        ...(style === undefined ? {} : { style }),
      })
      const before = answered.length
      const picture = await canvasViewPicture(deps, result)
      expect(answered.length - before, String(style)).toBe(1)
      const { scene, svg } = answered.at(-1) as Answered
      expect(picture.svg === svg, String(style)).toBe(true)
      const canvas = fromJsonCanvas(result.scene)
      const background = resolveCanvasPalette(canvas, 'light', { style: result.style ?? 'clean' })
      const old = renderSceneToSvg(scene, { padding: 0, background: background.surface })
      expect(svg === old, String(style)).toBe(true)
      compared += 1
    }
    expect(compared).toBe(4)
  })
})
