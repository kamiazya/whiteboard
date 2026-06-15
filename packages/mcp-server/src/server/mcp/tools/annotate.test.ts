import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { appendAnnotationToDoc } from './annotate.js'

const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

describe('annotate (single) warnings', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    const emptyDoc = new LoroDoc()
    const snapshot = emptyDoc.export({ mode: 'snapshot' })

    fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString()
      if (u.endsWith('/palette')) {
        return new Response(JSON.stringify({ palette: {} }), { status: 200 })
      }
      if (u.endsWith('/snapshot')) {
        return new Response(snapshot, { status: 200 })
      }
      if (u.endsWith('/update')) {
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected fetch: ${u}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('case 70', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'box_with_label',
        target: { x: 0, y: 0 },
        coords: 'absolute',
        width: 50,
        height: 30,
        autoFit: false,
        text: 'This label is way too long for a 50px wide box',
      },
      client,
    )
    expect(res.elementIds).toBeDefined()
    expect(res.warnings).toBeDefined()
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings![0]).toMatchObject({ overflow: true })
    expect(res.warnings![0].requiredHeight).toBeGreaterThan(20)
  })

  it('case 71', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'box_with_label',
        target: { x: 0, y: 0 },
        coords: 'absolute',
        width: 400,
        height: 60,
        text: 'OK',
      },
      client,
    )
    expect(res.warnings ?? []).toEqual([])
  })

  it('case 72', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'rectangle',
        target: { x: 0, y: 0 },
        coords: 'absolute',
      },
      client,
    )
    expect(res.elementId).toBeDefined()
    expect(res.warnings ?? []).toEqual([])
  })

  it('reports unknownPaletteKeys when a color token is not in the palette', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'rectangle',
        target: { x: 0, y: 0 },
        coords: 'absolute',
        color: 'role.client',
        backgroundColor: 'role.server',
      },
      client,
    )
    expect(res.unknownPaletteKeys).toEqual(expect.arrayContaining(['role.client', 'role.server']))
    expect(res.unknownPaletteKeys).toHaveLength(2)
  })

  it('omits unknownPaletteKeys when all color tokens resolve', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = url.toString()
      if (u.endsWith('/palette')) {
        return new Response(JSON.stringify({ palette: { 'role.client': '#ff0000' } }), {
          status: 200,
        })
      }
      if (u.endsWith('/snapshot')) {
        const emptyDoc = new (await import('loro-crdt')).LoroDoc()
        return new Response(emptyDoc.export({ mode: 'snapshot' }), { status: 200 })
      }
      if (u.endsWith('/update')) return new Response(null, { status: 204 })
      throw new Error(`Unexpected fetch: ${u}`)
    })
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'rectangle',
        target: { x: 0, y: 0 },
        coords: 'absolute',
        color: 'role.client',
      },
      client,
    )
    expect(res.unknownPaletteKeys).toBeUndefined()
  })
})
describe('suite 1', () => {
  function seedImage(doc: LoroDoc, id: string, x: number, y: number, w: number, h: number) {
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(list.length, new LoroMap())
    map.set('id', id)
    map.set('type', 'image')
    map.set('x', x)
    map.set('y', y)
    map.set('width', w)
    map.set('height', h)
    doc.commit()
  }

  it('case 73', () => {
    const doc = new LoroDoc()
    seedImage(doc, 'img-1', 100, 200, 400, 300)
    const result = appendAnnotationToDoc(doc, {
      type: 'text',
      coords: 'parent',
      imageId: 'img-1',
      target: { x: 0.5, y: 0.5 },
      text: 'tracked',
    })
    expect(result.type).toBe('text')
    expect(result.elementId).toBeDefined()
    const list = doc.getMovableList('elements')
    const added = list.get(list.length - 1) as LoroMap
    expect(added.get('parentId')).toBe('img-1')
    expect(added.get('relX')).toBe(0.5)
    expect(added.get('relY')).toBe(0.5)
    expect(added.get('x')).toBe(300)
    expect(added.get('y')).toBe(350)
  })

  it('case 74', () => {
    const doc = new LoroDoc()
    seedImage(doc, 'img-1', 100, 200, 400, 300)
    appendAnnotationToDoc(doc, {
      type: 'rectangle',
      coords: 'absolute',
      target: { x: 50, y: 60 },
    })
    const list = doc.getMovableList('elements')
    const added = list.get(list.length - 1) as LoroMap
    expect(added.get('parentId')).toBeUndefined()
    expect(added.get('relX')).toBeUndefined()
    expect(added.get('relY')).toBeUndefined()
  })

  it('case 75', () => {
    const doc = new LoroDoc()
    seedImage(doc, 'img-1', 100, 200, 400, 300)
    appendAnnotationToDoc(doc, {
      type: 'rectangle',
      coords: 'relative',
      imageId: 'img-1',
      target: { x: 0.5, y: 0.5 },
    })
    const list = doc.getMovableList('elements')
    const added = list.get(list.length - 1) as LoroMap
    expect(added.get('parentId')).toBeUndefined()
  })
})

describe('appendAnnotationToDoc - text fontSize', () => {
  it('case 76', () => {
    const doc = new LoroDoc()
    const result = appendAnnotationToDoc(doc, {
      type: 'text',
      coords: 'absolute',
      target: { x: 40, y: 80 },
      text: 'Option A',
      fontSize: 28,
    })
    expect(result.type).toBe('text')
    const list = doc.getMovableList('elements')
    const added = list.get(list.length - 1) as LoroMap
    expect(added.get('fontSize')).toBe(28)
  })
})
describe('annotate (single) structured result shape', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    const emptyDoc = new LoroDoc()
    const snapshot = emptyDoc.export({ mode: 'snapshot' })
    fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString()
      if (u.endsWith('/palette'))
        return new Response(JSON.stringify({ palette: {} }), { status: 200 })
      if (u.endsWith('/snapshot')) return new Response(snapshot, { status: 200 })
      if (u.endsWith('/update')) return new Response(null, { status: 204 })
      throw new Error(`Unexpected fetch: ${u}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('case 77', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      { canvasId: 'sid/slug', type: 'rectangle', target: { x: 0, y: 0 }, coords: 'absolute' },
      client,
    )
    expect(res.annotation).toBeDefined()
    expect(res.annotation!.type).toBe('rectangle')
    expect(res.annotation!.elementId).toBe(res.elementId)
  })

  it('case 78', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'box_with_label',
        target: { x: 0, y: 0 },
        coords: 'absolute',
        width: 200,
        height: 60,
        text: 'label',
      },
      client,
    )
    expect(res.annotation).toBeDefined()
    expect(res.annotation!.type).toBe('box_with_label')
    expect(res.annotation!.rectId).toBeDefined()
    expect(res.annotation!.textId).toBeDefined()
    expect(res.annotation!.rectId).not.toBe(res.annotation!.textId)
    expect(res.elementIds).toEqual([res.annotation!.rectId, res.annotation!.textId])
  })

  it('case 79', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'box_with_label',
        target: { x: 0, y: 0 },
        coords: 'absolute',
        width: 200,
        height: 60,
        text: 'main',
        subText: 'caption',
      },
      client,
    )
    expect(res.annotation!.type).toBe('box_with_label')
    expect(res.annotation!.rectId).toBeDefined()
    expect(res.annotation!.textId).toBeDefined()
    expect(res.annotation!.subTextId).toBeDefined()
  })

  it('case 80', () => {
    const doc = new LoroDoc()
    const result = appendAnnotationToDoc(doc, {
      type: 'box_with_label',
      target: { x: 100, y: 200 },
      coords: 'absolute',
      width: 240,
      height: 120,
      text: 'main',
      subText: 'caption',
    })

    expect(result.type).toBe('box_with_label')
    expect(result.rectId).toBeDefined()
    expect(result.textId).toBeDefined()
    expect(result.subTextId).toBeDefined()

    const elements = doc.getMovableList('elements').toJSON() as Array<{
      id: string
      y: number
      height: number
      textAlign?: string
      containerId?: string | null
    }>
    const rect = elements.find((el) => el.id === result.rectId)
    const main = elements.find((el) => el.id === result.textId)
    const sub = elements.find((el) => el.id === result.subTextId)

    expect(rect).toBeDefined()
    expect(main).toBeDefined()
    expect(sub).toBeDefined()
    expect(main?.containerId ?? null).toBeNull()
    expect(main?.textAlign).toBe('center')
    expect(sub?.textAlign).toBe('center')
    expect(sub!.y).toBeGreaterThanOrEqual(rect!.y)
    expect(sub!.y + sub!.height).toBeLessThanOrEqual(rect!.y + rect!.height)
  })

  it('case 81', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'arrow',
        target: { x: 0, y: 0 },
        endTarget: { x: 100, y: 100 },
        coords: 'absolute',
      },
      client,
    )
    expect(res.annotation!.type).toBe('arrow')
    expect(res.annotation!.arrowId).toBe(res.elementId)
    expect(res.annotation!.labelId).toBeUndefined()
  })

  it('case 82', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        type: 'arrow',
        target: { x: 0, y: 0 },
        endTarget: { x: 100, y: 100 },
        coords: 'absolute',
        label: 'flow',
      },
      client,
    )
    expect(res.annotation!.type).toBe('arrow')
    expect(res.annotation!.arrowId).toBeDefined()
    expect(res.annotation!.labelId).toBeDefined()
    expect(res.annotation!.arrowId).not.toBe(res.annotation!.labelId)
  })
})

describe('suite 2', () => {
  it('case 83', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>
    expect(props.coords.enum).toContain('parent')
  })
})
describe('suite 3', () => {
  it('case 84', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>
    expect(props.subTextPosition).toBeDefined()
    expect(props.subTextPosition.enum).toEqual(['top', 'inside-bottom'])
  })

  it('case 85', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const props = tool.inputSchema.properties as Record<string, unknown>
    expect(props.subText).toBeDefined()
  })
})

describe('suite 4', () => {
  it('case 86', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const props = tool.inputSchema.properties as Record<string, unknown>
    expect(props.fontSize).toBeDefined()
  })

  it('case 87', async () => {
    const { annotateTool } = await import('./annotate.js')
    const tool = annotateTool()
    const props = tool.inputSchema.properties as Record<string, unknown>
    expect(props.title).toBeDefined()
  })
})
describe('arrow auto-binding from startBoxId / endBoxId', () => {
  function seedTwoRects(): LoroDoc {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    // rect A: (0,0) 100x100 (center 50,50, right edge x=100)
    const a = list.insertContainer(0, new LoroMap())
    a.set('id', 'rectA')
    a.set('type', 'rectangle')
    a.set('x', 0)
    a.set('y', 0)
    a.set('width', 100)
    a.set('height', 100)
    // rect B: (200,0) 100x100 (center 250,50, left edge x=200)
    const b = list.insertContainer(1, new LoroMap())
    b.set('id', 'rectB')
    b.set('type', 'rectangle')
    b.set('x', 200)
    b.set('y', 0)
    b.set('width', 100)
    b.set('height', 100)
    return doc
  }

  it('case 88', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = seedTwoRects()
    appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 0, y: 0 },
      startBoxId: 'rectA',
      endBoxId: 'rectB',
    })
    const els = doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    const arrow = els.find((e) => e.type === 'arrow') as {
      x: number
      y: number
      width: number
      height: number
      points: [number, number][]
    }
    expect(arrow.x).toBe(100)
    expect(arrow.y).toBe(50)
    expect(arrow.width).toBe(100) // dx
    expect(arrow.height).toBe(0) // dy
    expect(arrow.points).toEqual([
      [0, 0],
      [100, 0],
    ])
  })

  it('case 89', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = seedTwoRects()
    appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 0, y: 50 },
      endBoxId: 'rectB',
    })
    const arrow = (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>).find(
      (e) => e.type === 'arrow',
    ) as { x: number; y: number; width: number; height: number }
    expect(arrow.x).toBe(0)
    expect(arrow.y).toBe(50)
    expect(arrow.width).toBe(200)
    expect(arrow.height).toBe(0)
  })

  it('case 90', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = seedTwoRects()
    appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 50, y: 50 },
      endTarget: { x: 300, y: 50 },
      startBoxId: 'rectA',
    })
    const arrow = (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>).find(
      (e) => e.type === 'arrow',
    ) as { x: number; y: number; width: number; height: number }
    expect(arrow.x).toBe(100)
    expect(arrow.y).toBe(50)
    expect(arrow.width).toBe(200)
    expect(arrow.height).toBe(0)
  })

  it('case 91', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = new LoroDoc()
    appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 0, y: 0 },
      startBoxId: 'does-not-exist',
      endBoxId: 'missing-too',
    })
    const arrow = (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>).find(
      (e) => e.type === 'arrow',
    ) as { x: number; y: number; width: number; height: number }
    // default stub (existing behavior): width=100, height=0 at origin (0,0)
    expect(arrow.x).toBe(0)
    expect(arrow.y).toBe(0)
    expect(arrow.width).toBe(100)
    expect(arrow.height).toBe(0)
  })
})

describe('arrow binding metadata for text / label targets', () => {
  it('case 92', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const text = list.insertContainer(0, new LoroMap())
    text.set('id', 'txt-1')
    text.set('type', 'text')
    text.set('x', 200)
    text.set('y', 100)
    text.set('width', 120)
    text.set('height', 24)

    const result = appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 0, y: 112 },
      endBoxId: 'txt-1',
    })
    expect(result.arrowId).toBeDefined()
    const textEl = (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>).find(
      (el) => el.id === 'txt-1',
    )
    expect(textEl?.boundElements).toContainEqual({
      id: result.arrowId,
      type: 'arrow',
    })
  })

  it('case 93', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const rect = list.insertContainer(0, new LoroMap())
    rect.set('id', 'box-1')
    rect.set('type', 'rectangle')
    rect.set('x', 200)
    rect.set('y', 100)
    rect.set('width', 140)
    rect.set('height', 80)
    const label = list.insertContainer(1, new LoroMap())
    label.set('id', 'box-1-label')
    label.set('type', 'text')
    label.set('x', 200)
    label.set('y', 100)
    label.set('width', 140)
    label.set('height', 80)
    label.set('containerId', 'box-1')

    const result = appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 0, y: 140 },
      endBoxId: 'box-1-label',
    })
    expect(result.arrowId).toBeDefined()
    const rectEl = (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>).find(
      (el) => el.id === 'box-1',
    )
    expect(rectEl?.boundElements).toContainEqual({
      id: result.arrowId,
      type: 'arrow',
    })
  })
})
describe('arrow routing ignores bound text of start/end boxes', () => {
  function seedBoxedLayout(): LoroDoc {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    // start box A at (0,0,100,100) with bound label
    const a = list.insertContainer(0, new LoroMap())
    a.set('id', 'A')
    a.set('type', 'rectangle')
    a.set('x', 0)
    a.set('y', 0)
    a.set('width', 100)
    a.set('height', 100)
    const aLabel = list.insertContainer(1, new LoroMap())
    aLabel.set('id', 'A-label')
    aLabel.set('type', 'text')
    aLabel.set('x', 0)
    aLabel.set('y', 0)
    aLabel.set('width', 100)
    aLabel.set('height', 100)
    aLabel.set('containerId', 'A')
    // middle obstacle C at (150, 150, 100, 100) -- blocks straight diagonal from A to B
    const c = list.insertContainer(2, new LoroMap())
    c.set('id', 'C')
    c.set('type', 'rectangle')
    c.set('x', 150)
    c.set('y', 150)
    c.set('width', 100)
    c.set('height', 100)
    // end box B at (300, 300, 100, 100) with bound label
    const b = list.insertContainer(3, new LoroMap())
    b.set('id', 'B')
    b.set('type', 'rectangle')
    b.set('x', 300)
    b.set('y', 300)
    b.set('width', 100)
    b.set('height', 100)
    const bLabel = list.insertContainer(4, new LoroMap())
    bLabel.set('id', 'B-label')
    bLabel.set('type', 'text')
    bLabel.set('x', 300)
    bLabel.set('y', 300)
    bLabel.set('width', 100)
    bLabel.set('height', 100)
    bLabel.set('containerId', 'B')
    return doc
  }

  it('case 94', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = seedBoxedLayout()
    appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 0, y: 0 },
      startBoxId: 'A',
      endBoxId: 'B',
    })
    const arrow = (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>).find(
      (e) => e.type === 'arrow',
    ) as { points: [number, number][] }
    expect(arrow.points.length).toBeGreaterThanOrEqual(3)
  })

  it('case 95', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    // A at (0, 0, 100, 100)
    const a = list.insertContainer(0, new LoroMap())
    a.set('id', 'A')
    a.set('type', 'rectangle')
    a.set('x', 0)
    a.set('y', 0)
    a.set('width', 100)
    a.set('height', 100)
    // B at (400, 400, 100, 100)
    const b = list.insertContainer(1, new LoroMap())
    b.set('id', 'B')
    b.set('type', 'rectangle')
    b.set('x', 400)
    b.set('y', 400)
    b.set('width', 100)
    b.set('height', 100)
    const label = list.insertContainer(2, new LoroMap())
    label.set('id', 'arrow-label-1')
    label.set('type', 'text')
    label.set('x', 200)
    label.set('y', 240)
    label.set('width', 120)
    label.set('height', 24)
    label.set('isArrowLabel', true)

    appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 0, y: 0 },
      startBoxId: 'A',
      endBoxId: 'B',
    })
    const arrow = (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>).find(
      (e) => e.type === 'arrow',
    ) as { points: [number, number][] }
    expect(arrow.points.length).toBeGreaterThanOrEqual(2)
    const lastPoint = arrow.points[arrow.points.length - 1]
    expect(typeof lastPoint[0]).toBe('number')
    expect(typeof lastPoint[1]).toBe('number')
    expect(arrow.points).not.toEqual([
      [0, 0],
      [100, 0],
    ])
  })

  it('case 96', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = new LoroDoc()
    appendAnnotationToDoc(doc, {
      type: 'arrow',
      coords: 'absolute',
      target: { x: 0, y: 0 },
      endTarget: { x: 200, y: 0 },
      label: 'my-edge',
    })
    const els = doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    const labelEl = els.find((e) => e.type === 'text' && e.text === 'my-edge')
    expect(labelEl).toBeDefined()
    expect(labelEl!.isArrowLabel).toBe(true)
  })
})

describe('box_with_label — height optional with autoFit', () => {
  it('succeeds without height when autoFit is on (default)', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = new LoroDoc()
    // height omitted — autoFit defaults to true so the box expands to fit the text
    const result = appendAnnotationToDoc(doc, {
      type: 'box_with_label',
      coords: 'absolute',
      target: { x: 0, y: 0 },
      width: 200,
      text: 'Auto-fit label',
    })
    expect(result.type).toBe('box_with_label')
    expect(result.rectId).toBeDefined()
    const els = doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    const rect = els.find((e) => e.id === result.rectId) as { height: number } | undefined
    expect(rect).toBeDefined()
    // autoFit should have expanded the height beyond 0
    expect(rect!.height).toBeGreaterThan(0)
  })

  it('throws when height is omitted and autoFit=false', async () => {
    const { appendAnnotationToDoc } = await import('./annotate.js')
    const doc = new LoroDoc()
    expect(() =>
      appendAnnotationToDoc(doc, {
        type: 'box_with_label',
        coords: 'absolute',
        target: { x: 0, y: 0 },
        width: 200,
        text: 'label',
        autoFit: false,
      }),
    ).toThrow('box_with_label requires title or text, plus width and height')
  })
})
