import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { listGroups } from './element-ops.js'

const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

describe('annotate_batch', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>
  let postedUpdate: Uint8Array | null = null

  beforeEach(() => {
    originalFetch = globalThis.fetch
    postedUpdate = null
    const emptyDoc = new LoroDoc()
    const snapshot = emptyDoc.export({ mode: 'snapshot' })

    fetchMock = vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
      const u = url.toString()
      if (u.endsWith('/exists')) {
        return new Response(JSON.stringify({ exists: true }), { status: 200 })
      }
      if (u.endsWith('/snapshot')) {
        return new Response(snapshot, { status: 200 })
      }
      if (u.endsWith('/update')) {
        postedUpdate = new Uint8Array(init!.body as ArrayBuffer)
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected fetch: ${u}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('case 315', async () => {
    const { annotateBatchTool } = await import('./annotate-batch.js')
    const tool = annotateBatchTool()

    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        annotations: [
          { type: 'rectangle', target: { x: 100, y: 100 }, coords: 'absolute' },
          { type: 'text', target: { x: 200, y: 200 }, text: 'hi', coords: 'absolute' },
          { type: 'arrow', target: { x: 300, y: 300 }, coords: 'absolute' },
        ],
      },
      client,
    )

    expect(res.elementIds).toHaveLength(3)
    // 1 canvases GET (existence check) + 1 snapshot GET + 1 update POST
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(postedUpdate).not.toBeNull()
    expect(postedUpdate!.byteLength).toBeGreaterThan(0)
  })

  it('case 316', async () => {
    const { annotateBatchTool } = await import('./annotate-batch.js')
    const tool = annotateBatchTool()
    const res = await tool.execute({ canvasId: 'sid/slug', annotations: [] }, client)
    expect(res.elementIds).toEqual([])
  })

  it('rejects an unknown canvasId before touching snapshot/update endpoints', async () => {
    const { annotateBatchTool } = await import('./annotate-batch.js')
    const tool = annotateBatchTool()
    let touchedWriteEndpoint = false
    const fakeClient = {
      port: 3099,
      baseUrl: 'http://localhost:3099',
      request: async (path: string) => {
        if (path.endsWith('/exists')) {
          return new Response(JSON.stringify({ exists: false }), { status: 200 })
        }
        touchedWriteEndpoint = true
        throw new Error(`Unexpected request: ${path}`)
      },
      touch: async () => undefined,
    }
    await expect(
      tool.execute(
        {
          canvasId: 'unknown-ws/sticky-demo',
          annotations: [{ type: 'rectangle', target: { x: 0, y: 0 }, coords: 'absolute' }],
        },
        fakeClient,
      ),
    ).rejects.toThrow(/canvas_create/)
    expect(touchedWriteEndpoint).toBe(false)
  })
  describe('warnings (box_with_label overflow)', () => {
    it('case 317', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            { type: 'rectangle', target: { x: 0, y: 0 }, coords: 'absolute' },
            {
              type: 'box_with_label',
              target: { x: 100, y: 100 },
              coords: 'absolute',
              width: 50,
              height: 30,
              autoFit: false,
              text: 'This label is way too long for a 50px wide box',
            },
          ],
        },
        client,
      )
      expect(res.warnings).toBeDefined()
      expect(res.warnings).toHaveLength(1)
      expect(res.warnings![0]).toMatchObject({
        index: 1,
        overflow: true,
      })
      expect(res.warnings![0].requiredHeight).toBeGreaterThan(20)
    })

    it('case 318', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'box_with_label',
              target: { x: 0, y: 0 },
              coords: 'absolute',
              width: 400,
              height: 60,
              text: 'OK',
            },
          ],
        },
        client,
      )
      expect(res.warnings ?? []).toEqual([])
    })

    it('case 319', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'rectangle',
              target: { x: 0, y: 0 },
              coords: 'absolute',
              width: 100,
              height: 100,
            },
            {
              type: 'rectangle',
              target: { x: 20, y: 20 }, // Heavy overlap
              coords: 'absolute',
              width: 100,
              height: 100,
            },
          ],
        },
        client,
      )
      expect(res.overlaps.length).toBeGreaterThan(0)
      const overlapWarnings = (res.warnings ?? []).filter((w) => /overlap/.test(w.message ?? ''))
      expect(overlapWarnings.map((w) => w.index).sort()).toEqual([0, 1])
    })

    it('case 320', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'box_with_label',
              target: { x: 0, y: 0 },
              coords: 'absolute',
              width: 300,
              height: 40, // Clearly too short for 5 lines
              text: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'],
            },
          ],
        },
        client,
      )
      expect(res.warnings).toBeDefined()
      expect(res.warnings).toHaveLength(1)
      expect(res.warnings![0]).toMatchObject({ index: 0 })
      expect(res.warnings![0].autoExpandedBy).toBeGreaterThan(0)
      expect(res.warnings![0].actualHeight).toBeGreaterThan(40)
      expect(res.warnings![0].overflow ?? false).toBe(false)
    })

    it('case 321', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'text',
              target: { x: 0, y: 0 },
              text: 'very long text in a text element',
              coords: 'absolute',
            },
            { type: 'rectangle', target: { x: 600, y: 600 }, coords: 'absolute' },
          ],
        },
        client,
      )
      const boxWarnings = (res.warnings ?? []).filter(
        (w) => w.overflow !== undefined || w.autoExpandedBy !== undefined,
      )
      expect(boxWarnings).toEqual([])
    })

    it('case 322', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'box_with_label',
              target: { x: 100, y: 200 },
              coords: 'absolute',
              width: 240,
              height: 120,
              text: 'main',
              subText: 'caption',
            },
          ],
        },
        client,
      )

      expect(res.warnings ?? []).toEqual([])

      const updateDoc = new LoroDoc()
      updateDoc.import(postedUpdate!)
      const elements = updateDoc.getMovableList('elements').toJSON() as Array<{
        type: string
        y: number
        height: number
        text?: string
        textAlign?: string
        containerId?: string | null
      }>
      const rect = elements.find((el) => el.type === 'rectangle')
      const main = elements.find((el) => el.type === 'text' && el.text === 'main')
      const sub = elements.find((el) => el.type === 'text' && el.text === 'caption')

      expect(rect).toBeDefined()
      expect(main).toBeDefined()
      expect(sub).toBeDefined()
      expect(main?.containerId ?? null).toBeNull()
      expect(main?.textAlign).toBe('center')
      expect(sub?.textAlign).toBe('center')
      expect(sub!.y).toBeGreaterThanOrEqual(rect!.y)
      expect(sub!.y + sub!.height).toBeLessThanOrEqual(rect!.y + rect!.height)
    })
  })
  describe('warnings (group missingMemberIds)', () => {
    it('case 323', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'group',
              memberIds: ['ghost-1', 'ghost-2'],
            },
          ],
        },
        client,
      )
      expect(res.warnings).toBeDefined()
      expect(res.warnings).toHaveLength(1)
      expect(res.warnings![0]).toMatchObject({
        index: 0,
        missingMemberIds: ['ghost-1', 'ghost-2'],
      })
    })

    it('case 324', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [{ type: 'group', memberIds: [] }],
        },
        client,
      )
      expect(res.warnings ?? []).toEqual([])
    })
  })
  describe('structured result shape (annotations[])', () => {
    it('case 325', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            { type: 'rectangle', target: { x: 0, y: 0 }, coords: 'absolute' },
            {
              type: 'box_with_label',
              target: { x: 100, y: 100 },
              coords: 'absolute',
              width: 200,
              height: 60,
              text: 'hello',
            },
            {
              type: 'arrow',
              target: { x: 0, y: 0 },
              endTarget: { x: 50, y: 50 },
              coords: 'absolute',
              label: 'mid',
            },
          ],
        },
        client,
      )
      expect(res.annotations).toBeDefined()
      expect(res.annotations).toHaveLength(3)
      // [0] rectangle
      expect(res.annotations![0].type).toBe('rectangle')
      expect(res.annotations![0].elementId).toBeDefined()
      // [1] box_with_label
      expect(res.annotations![1].type).toBe('box_with_label')
      expect(res.annotations![1].rectId).toBeDefined()
      expect(res.annotations![1].textId).toBeDefined()
      // [2] arrow + label
      expect(res.annotations![2].type).toBe('arrow')
      expect(res.annotations![2].arrowId).toBeDefined()
      expect(res.annotations![2].labelId).toBeDefined()
      const expectedIds = [
        res.annotations![0].elementId!,
        res.annotations![1].rectId!,
        res.annotations![1].textId!,
        res.annotations![2].arrowId!,
        res.annotations![2].labelId!,
      ]
      expect(res.elementIds).toEqual(expectedIds)
    })

    it('case 326', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [{ type: 'rectangle', target: { x: 0, y: 0 }, coords: 'absolute' }],
        },
        client,
      )
      expect(res.annotations![0].type).toBe('rectangle')
    })
  })
  describe('suite 9', () => {
    it('case 327', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const props = tool.inputSchema.properties as Record<
        string,
        { items?: { properties?: Record<string, { enum?: string[] }> } }
      >
      const typeEnum = props.annotations.items?.properties?.type?.enum
      expect(typeEnum).toContain('group')
    })

    it('case 328', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const props = tool.inputSchema.properties as Record<
        string,
        { items?: { properties?: Record<string, unknown> } }
      >
      const itemProps = props.annotations.items?.properties
      expect(itemProps?.memberIds).toBeDefined()
      expect(itemProps?.padding).toBeDefined()
      expect(itemProps?.title).toBeDefined()
    })
  })

  describe('suite 10', () => {
    it('case 329', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const props = tool.inputSchema.properties as Record<
        string,
        { items?: { properties?: Record<string, unknown> } }
      >
      const itemProps = props.annotations.items?.properties
      expect(itemProps?.fontSize).toBeDefined()
      expect(itemProps?.rowSpan).toBeDefined()
      expect(itemProps?.colSpan).toBeDefined()
      expect(itemProps?.title).toBeDefined()
    })

    it('case 330', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const props = tool.inputSchema.properties as Record<
        string,
        { properties?: Record<string, unknown> }
      >
      const layoutProps = props.layout?.properties
      expect(layoutProps?.colWidths).toBeDefined()
      expect(layoutProps?.rowHeights).toBeDefined()
    })
  })

  // Task #60: binding-name DSL
  describe('binding-name DSL (name / startBoxName / endBoxName)', () => {
    it('case 331', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'box_with_label',
              name: 'A',
              target: { x: 0, y: 0 },
              coords: 'absolute',
              width: 100,
              height: 50,
              text: 'A',
            },
            {
              type: 'box_with_label',
              name: 'B',
              target: { x: 300, y: 0 },
              coords: 'absolute',
              width: 100,
              height: 50,
              text: 'B',
            },
            {
              type: 'arrow',
              target: { x: 0, y: 0 },
              endTarget: { x: 0, y: 0 },
              coords: 'absolute',
              startBoxName: 'A',
              endBoxName: 'B',
            },
          ],
        },
        client,
      )
      expect(res.annotations).toHaveLength(3)
      const boxA = res.annotations![0]
      const boxB = res.annotations![1]
      const arrow = res.annotations![2]
      expect(arrow.type).toBe('arrow')
      expect(arrow.arrowId).toBeDefined()
      expect(boxA.rectId).toBeDefined()
      expect(boxB.rectId).toBeDefined()
    })
    it('case 332', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'box_with_label',
              name: 'plugin',
              target: { x: 0, y: 0 },
              coords: 'absolute',
              width: 100,
              height: 50,
              text: 'plugin',
            },
            {
              type: 'box_with_label',
              name: 'npm',
              target: { x: 0, y: 100 },
              coords: 'absolute',
              width: 100,
              height: 50,
              text: 'npm',
            },
            {
              type: 'arrow',
              name: 'plugin-to-npm',
              target: { x: 0, y: 0 },
              endTarget: { x: 0, y: 0 },
              coords: 'absolute',
              startBoxName: 'plugin',
              endBoxName: 'npm',
              label: 'npx -y @latest',
            },
          ],
        },
        client,
      )
      expect(res.byName).toBeDefined()
      expect(res.byName!.plugin?.rectId).toBeDefined()
      expect(res.byName!.plugin?.textId).toBeDefined()
      expect(res.byName!['plugin-to-npm']?.arrowId).toBeDefined()
      expect(res.byName!['plugin-to-npm']?.labelId).toBeDefined()
      expect(Object.keys(res.byName!).sort()).toEqual(['npm', 'plugin', 'plugin-to-npm'])
    })

    it('case 333', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'rectangle',
              target: { x: 0, y: 0 },
              coords: 'absolute',
              width: 100,
              height: 50,
            },
          ],
        },
        client,
      )
      expect(res.byName).toEqual({})
    })

    it('case 334', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'arrow',
              target: { x: 0, y: 0 },
              endTarget: { x: 100, y: 100 },
              coords: 'absolute',
              startBoxName: 'ghost',
            },
          ],
        },
        client,
      )
      expect(res.warnings).toBeDefined()
      const w = res.warnings!.find((x) => x.index === 0 && x.unresolvedBindingName)
      expect(w).toBeDefined()
      expect(w!.unresolvedBindingName).toContain('ghost')
    })

    it('case 335', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const props = tool.inputSchema.properties as Record<
        string,
        { items?: { properties?: Record<string, unknown> } }
      >
      const itemProps = props.annotations.items?.properties
      expect(itemProps?.name).toBeDefined()
      expect(itemProps?.startBoxName).toBeDefined()
      expect(itemProps?.endBoxName).toBeDefined()
    })
  })
  describe('suite 11', () => {
    it('case 336', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const props = tool.inputSchema.properties as Record<
        string,
        { items?: { properties?: Record<string, { enum?: string[] }> } }
      >
      const itemProps = props.annotations.items?.properties
      expect(itemProps?.subTextPosition).toBeDefined()
      expect(itemProps?.subTextPosition?.enum).toEqual(['top', 'inside-bottom'])
    })
  })

  describe('grid spans with variable widths/heights', () => {
    it('case 337', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          layout: {
            cols: 4,
            rows: 3,
            colWidths: [200, 400, 500, 540],
            rowHeights: [80, 120, 160],
            gap: 20,
            origin: { x: 40, y: 100 },
          },
          annotations: [
            {
              type: 'box_with_label',
              row: 1,
              col: 2,
              rowSpan: 2,
              colSpan: 2,
              text: 'Dialog',
            },
          ],
        },
        client,
      )
      const updateDoc = new LoroDoc()
      updateDoc.import(postedUpdate!)
      const elements = updateDoc.getMovableList('elements').toJSON() as Array<
        Record<string, unknown>
      >
      const rect = elements.find((el) => el.type === 'rectangle')
      expect(rect).toMatchObject({
        x: 680,
        y: 200,
        width: 1060,
        height: 300,
      })
      expect(res.warnings ?? []).toEqual([])
    })

    it('case 338', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          layout: {
            cols: 2,
            rows: 2,
            cellW: 100,
            cellH: 60,
            gap: 10,
            origin: { x: 0, y: 0 },
          },
          annotations: [
            {
              type: 'box_with_label',
              row: 1,
              col: 1,
              rowSpan: 2,
              colSpan: 2,
              text: 'Tail',
            },
          ],
        },
        client,
      )
      const updateDoc = new LoroDoc()
      updateDoc.import(postedUpdate!)
      const elements = updateDoc.getMovableList('elements').toJSON() as Array<
        Record<string, unknown>
      >
      const rect = elements.find((el) => el.type === 'rectangle')
      expect(rect).toMatchObject({
        x: 110,
        y: 70,
        width: 100,
        height: 60,
      })
      expect(res.warnings).toEqual([
        expect.objectContaining({ index: 0, message: expect.stringMatching(/clipped/i) }),
      ])
    })
  })

  describe('dryRun + overlap detection', () => {
    it('case 339', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          dryRun: true,
          annotations: [
            {
              type: 'rectangle',
              target: { x: 0, y: 0 },
              coords: 'absolute',
              width: 120,
              height: 80,
            },
            {
              type: 'rectangle',
              target: { x: 60, y: 20 },
              coords: 'absolute',
              width: 120,
              height: 80,
            },
          ],
        } as never,
        client,
      )
      expect(postedUpdate).toBeNull()
      expect(res.placements).toHaveLength(2)
      expect(res.overlaps).toEqual([expect.objectContaining({ a: 0, b: 1 })])
    })
  })

  describe('arrow text as label alias', () => {
    it('case 341 — text field on arrow is treated as label (creates midpoint labelId)', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'arrow',
              target: { x: 0, y: 0 },
              endTarget: { x: 100, y: 0 },
              coords: 'absolute',
              text: 'gRPC · p50 2ms',
            },
          ],
        },
        client,
      )
      expect(res.annotations).toHaveLength(1)
      expect(res.annotations![0].type).toBe('arrow')
      expect(res.annotations![0].arrowId).toBeDefined()
      // text on arrow should produce a midpoint label element
      expect(res.annotations![0].labelId).toBeDefined()
      expect(res.elementIds).toHaveLength(2)
    })

    it('case 341b — arrow + both text and label: label wins over text alias', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'arrow',
              target: { x: 0, y: 0 },
              endTarget: { x: 100, y: 0 },
              coords: 'absolute',
              text: 'alias-value',
              label: 'explicit-value',
            },
          ],
        },
        client,
      )
      expect(res.annotations![0].labelId).toBeDefined()
    })

    it('case 341c — arrow + text as string[] produces midpoint labelId', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          annotations: [
            {
              type: 'arrow',
              target: { x: 0, y: 0 },
              endTarget: { x: 100, y: 0 },
              coords: 'absolute',
              text: ['line1', 'line2'],
            },
          ],
        },
        client,
      )
      expect(res.annotations![0].labelId).toBeDefined()
      expect(res.elementIds).toHaveLength(2)
    })
  })

  describe('groupAs', () => {
    it('case 340', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          groupAs: 'plan-a-row',
          annotations: [
            { type: 'rectangle', target: { x: 0, y: 0 }, coords: 'absolute' },
            { type: 'text', target: { x: 0, y: 100 }, coords: 'absolute', text: 'Option A' },
          ],
        } as never,
        client,
      )
      const updateDoc = new LoroDoc()
      updateDoc.import(postedUpdate!)
      expect(listGroups(updateDoc)).toEqual([
        {
          groupId: 'plan-a-row',
          memberIds: res.elementIds,
        },
      ])
    })

    it('applies per-item groupAs in addition to the batch-level groupAs', async () => {
      const { annotateBatchTool } = await import('./annotate-batch.js')
      const tool = annotateBatchTool()
      const res = await tool.execute(
        {
          canvasId: 'sid/slug',
          groupAs: 'plan-a-row',
          annotations: [
            {
              type: 'rectangle',
              target: { x: 0, y: 0 },
              coords: 'absolute',
              groupAs: 'selected-option',
            },
            { type: 'text', target: { x: 0, y: 100 }, coords: 'absolute', text: 'Option A' },
          ],
        } as never,
        client,
      )
      const updateDoc = new LoroDoc()
      updateDoc.import(postedUpdate!)
      const groups = listGroups(updateDoc)
      // Every element belongs to the shared batch group ...
      expect(groups.find((g) => g.groupId === 'plan-a-row')?.memberIds).toEqual(res.elementIds)
      // ... and only the first item's element additionally belongs to its own sub-group.
      expect(groups.find((g) => g.groupId === 'selected-option')?.memberIds).toEqual([
        res.elementIds[0],
      ])
    })
  })
})
