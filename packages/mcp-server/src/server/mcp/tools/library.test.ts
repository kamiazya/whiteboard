import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setExternalUrlLookupForTest } from '../../validators.js'

const apiGetSnapshotMock = vi.fn()
const apiPostLoroUpdateMock = vi.fn()

vi.mock('./annotate.js', () => ({
  apiGetSnapshot: apiGetSnapshotMock,
  apiPostLoroUpdate: apiPostLoroUpdateMock,
}))

let nanoidCounter = 0
vi.mock('nanoid', () => ({
  nanoid: () => `id-${nanoidCounter++}`,
}))

const {
  libraryListItemsTool,
  libraryInsertItemTool,
  libraryInsertBatchTool,
  libraryInstallTool,
  libraryUninstallTool,
  libraryListInstalledTool,
  userLibrarySaveTool,
  userLibraryListTool,
  userLibraryRemoveTool,
  userLibraryMetadataGetTool,
  userLibraryMetadataSetTool,
  userLibraryMetadataDeleteTool,
} = await import('./library.js')
const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

const SAMPLE_LIBRARY = {
  type: 'excalidrawlib',
  version: 2,
  libraryItems: [{ id: 'item-1', elements: [] }],
}

const INSERT_LIBRARY = {
  type: 'excalidrawlib',
  version: 2,
  libraryItems: [
    {
      id: 'item-1',
      name: 'rect+label',
      elements: [
        { id: 'rect-1', type: 'rectangle', x: 10, y: 20, width: 120, height: 80 },
        {
          id: 'text-1',
          type: 'text',
          x: 20,
          y: 30,
          width: 80,
          height: 20,
          containerId: 'rect-1',
        },
      ],
    },
    {
      id: 'item-2',
      name: 'node',
      elements: [{ id: 'rect-2', type: 'rectangle', x: 0, y: 0, width: 40, height: 40 }],
    },
  ],
}

let tempDir: string

function readUpdateElements(update: Uint8Array): Array<Record<string, unknown>> {
  const doc = new LoroDoc()
  doc.import(update)
  return doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
}

describe('session library tools', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    tempDir = await mkdtemp(join(tmpdir(), 'library-tool-test-'))
    nanoidCounter = 0
    apiGetSnapshotMock.mockReset()
    apiPostLoroUpdateMock.mockReset()
    __setExternalUrlLookupForTest(async () => [{ address: '93.184.216.34', family: 4 }])
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    __setExternalUrlLookupForTest()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('library_list_items rejects unsafe library urls before fetch', async () => {
    const tool = libraryListItemsTool()
    globalThis.fetch = vi.fn() as typeof globalThis.fetch

    await expect(
      tool.execute({ libraryUrl: 'http://localhost/lib.excalidrawlib' }, client),
    ).rejects.toThrow(/private or local/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('library_list_items rejects credentialed urls before fetch', async () => {
    const tool = libraryListItemsTool()
    globalThis.fetch = vi.fn() as typeof globalThis.fetch

    await expect(
      tool.execute({ libraryUrl: 'https://user:pass@example.com/lib.excalidrawlib' }, client),
    ).rejects.toThrow(/credentials/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('library_install validates the source then persists via the daemon route', async () => {
    const tool = libraryInstallTool('sess-1')
    let calls = 0
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls += 1
      if (calls === 1) {
        expect(input.toString()).toBe('https://example.com/lib.excalidrawlib')
        return new Response(JSON.stringify(SAMPLE_LIBRARY), { status: 200 })
      }
      expect(input.toString()).toBe('http://localhost:3099/api/workspaces/sess-1/libraries')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(JSON.stringify({ url: 'https://example.com/lib.excalidrawlib' }))
      return new Response(JSON.stringify({ urls: ['https://example.com/lib.excalidrawlib'] }), {
        status: 200,
      })
    }) as typeof globalThis.fetch

    await expect(
      tool.execute({ libraryUrl: 'https://example.com/lib.excalidrawlib' }, client),
    ).resolves.toEqual({
      libraryUrl: 'https://example.com/lib.excalidrawlib',
      itemCount: 1,
      installedUrls: ['https://example.com/lib.excalidrawlib'],
    })
  })

  it('library_uninstall removes via the daemon route', async () => {
    const tool = libraryUninstallTool('sess-1')
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/workspaces/sess-1/libraries')
      expect(init?.method).toBe('DELETE')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(JSON.stringify({ url: 'https://example.com/lib.excalidrawlib' }))
      return new Response(JSON.stringify({ urls: [] }), { status: 200 })
    }) as typeof globalThis.fetch

    await expect(
      tool.execute({ libraryUrl: 'https://example.com/lib.excalidrawlib' }, client),
    ).resolves.toEqual({ installedUrls: [] })
  })

  it('library_list_installed reads via the daemon route', async () => {
    const tool = libraryListInstalledTool('sess-1')
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      expect(input.toString()).toBe('http://localhost:3099/api/workspaces/sess-1/libraries')
      return new Response(JSON.stringify({ urls: ['https://example.com/lib.excalidrawlib'] }), {
        status: 200,
      })
    }) as typeof globalThis.fetch

    await expect(tool.execute({}, client)).resolves.toEqual({
      installedUrls: ['https://example.com/lib.excalidrawlib'],
    })
  })

  it('library_install rejects unsafe library urls before fetch', async () => {
    const tool = libraryInstallTool('sess-1')
    globalThis.fetch = vi.fn() as typeof globalThis.fetch

    await expect(
      tool.execute({ libraryUrl: 'http://localhost/lib.excalidrawlib' }, client),
    ).rejects.toThrow(/private or local/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('library_insert_batch resolves the source once and inserts multiple items with one snapshot/update', async () => {
    const tool = libraryInsertBatchTool()
    const doc = new LoroDoc()
    let postedUpdate: Uint8Array | null = null
    apiGetSnapshotMock.mockResolvedValue(doc)
    apiPostLoroUpdateMock.mockImplementation(
      async (_client: unknown, _workspaceId: string, _slug: string, update: Uint8Array) => {
        postedUpdate = update
      },
    )
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      expect(input.toString()).toBe('http://localhost:3099/api/user-libraries/icons')
      return new Response(JSON.stringify(INSERT_LIBRARY), { status: 200 })
    }) as typeof globalThis.fetch

    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        userLibraryName: 'icons',
        scale: 1,
        items: [
          { itemIndex: 0, target: { x: 100, y: 200 } },
          { itemIndex: 1, target: { x: 300, y: 400 } },
        ],
      },
      client,
    )

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(apiGetSnapshotMock).toHaveBeenCalledTimes(1)
    expect(apiPostLoroUpdateMock).toHaveBeenCalledTimes(1)
    expect(res).toEqual({
      source: 'user:icons',
      insertedItemCount: 2,
      insertedElementCount: 3,
      items: [
        { itemIndex: 0, insertedCount: 2, elementIds: ['id-0', 'id-1'] },
        { itemIndex: 1, insertedCount: 1, elementIds: ['id-2'] },
      ],
    })
    expect(postedUpdate).not.toBeNull()
    const elements = readUpdateElements(postedUpdate!)
    expect(elements).toHaveLength(3)
  })

  it('library_insert_item applies explicit scale to inserted geometry', async () => {
    const tool = libraryInsertItemTool()
    const libraryPath = join(tempDir, 'icons.excalidrawlib')
    let postedUpdate: Uint8Array | null = null
    await writeFile(libraryPath, JSON.stringify(INSERT_LIBRARY))
    apiGetSnapshotMock.mockResolvedValue(new LoroDoc())
    apiPostLoroUpdateMock.mockImplementation(
      async (_client: unknown, _workspaceId: string, _slug: string, update: Uint8Array) => {
        postedUpdate = update
      },
    )

    await tool.execute(
      {
        canvasId: 'sid/slug',
        libraryPath,
        itemIndex: 0,
        target: { x: 0, y: 0 },
        scale: 0.5,
      },
      client,
    )

    const elements = readUpdateElements(postedUpdate!)
    expect(elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'rectangle', x: 0, y: 0, width: 60, height: 40 }),
        expect.objectContaining({ type: 'text', x: 5, y: 5, width: 40, height: 10 }),
      ]),
    )
  })

  it('library_insert_batch falls back to metadata.scales for user libraries', async () => {
    const tool = libraryInsertBatchTool()
    let postedUpdate: Uint8Array | null = null
    apiGetSnapshotMock.mockResolvedValue(new LoroDoc())
    apiPostLoroUpdateMock.mockImplementation(
      async (_client: unknown, _workspaceId: string, _slug: string, update: Uint8Array) => {
        postedUpdate = update
      },
    )
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url === 'http://localhost:3099/api/user-libraries/icons') {
        return new Response(JSON.stringify(INSERT_LIBRARY), { status: 200 })
      }
      if (url === 'http://localhost:3099/api/user-libraries/icons/metadata') {
        return new Response(
          JSON.stringify({
            version: 1,
            revision: 1,
            aliases: {},
            notes: {},
            scales: { '1': 0.5 },
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof globalThis.fetch

    await tool.execute(
      {
        canvasId: 'sid/slug',
        userLibraryName: 'icons',
        items: [{ itemIndex: 1, target: { x: 10, y: 20 } }],
      },
      client,
    )

    const [element] = readUpdateElements(postedUpdate!)
    expect(element).toMatchObject({ x: 10, y: 20, width: 20, height: 20 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('library_insert_batch lets explicit item scale override metadata scale', async () => {
    const tool = libraryInsertBatchTool()
    let postedUpdate: Uint8Array | null = null
    apiGetSnapshotMock.mockResolvedValue(new LoroDoc())
    apiPostLoroUpdateMock.mockImplementation(
      async (_client: unknown, _workspaceId: string, _slug: string, update: Uint8Array) => {
        postedUpdate = update
      },
    )
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url === 'http://localhost:3099/api/user-libraries/icons') {
        return new Response(JSON.stringify(INSERT_LIBRARY), { status: 200 })
      }
      if (url === 'http://localhost:3099/api/user-libraries/icons/metadata') {
        return new Response(
          JSON.stringify({
            version: 1,
            revision: 1,
            aliases: {},
            notes: {},
            scales: { '1': 0.5 },
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof globalThis.fetch

    await tool.execute(
      {
        canvasId: 'sid/slug',
        userLibraryName: 'icons',
        items: [{ itemIndex: 1, target: { x: 10, y: 20 }, scale: 2 }],
      },
      client,
    )

    const [element] = readUpdateElements(postedUpdate!)
    expect(element).toMatchObject({ x: 10, y: 20, width: 80, height: 80 })
  })

  it('library_insert_batch fails on invalid itemIndex without partial insert', async () => {
    const tool = libraryInsertBatchTool()
    apiGetSnapshotMock.mockResolvedValue(new LoroDoc())
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(INSERT_LIBRARY), { status: 200 })) as typeof globalThis.fetch

    await expect(
      tool.execute(
        {
          canvasId: 'sid/slug',
          userLibraryName: 'icons',
          items: [
            { itemIndex: 0, target: { x: 0, y: 0 } },
            { itemIndex: 99, target: { x: 100, y: 100 } },
          ],
        },
        client,
      ),
    ).rejects.toThrow(/itemIndex 99 out of range/)

    expect(apiGetSnapshotMock).not.toHaveBeenCalled()
    expect(apiPostLoroUpdateMock).not.toHaveBeenCalled()
  })

  it('library_insert_batch applies batch and per-item groupAs to inserted elements', async () => {
    const tool = libraryInsertBatchTool()
    const doc = new LoroDoc()
    let postedUpdate: Uint8Array | null = null
    apiGetSnapshotMock.mockResolvedValue(doc)
    apiPostLoroUpdateMock.mockImplementation(
      async (_client: unknown, _workspaceId: string, _slug: string, update: Uint8Array) => {
        postedUpdate = update
      },
    )
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(INSERT_LIBRARY), { status: 200 })) as typeof globalThis.fetch

    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        userLibraryName: 'icons',
        groupAs: 'trial-sheet',
        items: [
          { itemIndex: 0, target: { x: 0, y: 0 }, groupAs: 'selected-icon' },
          { itemIndex: 1, target: { x: 200, y: 0 } },
        ],
      },
      client,
    )

    const elements = readUpdateElements(postedUpdate!)
    const grouped = new Map(elements.map((element) => [element.id as string, element.groupIds as string[]]))
    expect(grouped.get(res.items[0].elementIds[0])).toEqual(['trial-sheet', 'selected-icon'])
    expect(grouped.get(res.items[0].elementIds[1])).toEqual(['trial-sheet', 'selected-icon'])
    expect(grouped.get(res.items[1].elementIds[0])).toEqual(['trial-sheet'])
  })

  it('library_insert_item keeps the existing single-item response shape', async () => {
    const tool = libraryInsertItemTool()
    const libraryPath = join(tempDir, 'icons.excalidrawlib')
    await writeFile(libraryPath, JSON.stringify(INSERT_LIBRARY))
    apiGetSnapshotMock.mockResolvedValue(new LoroDoc())
    apiPostLoroUpdateMock.mockResolvedValue(undefined)

    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        libraryPath,
        itemIndex: 1,
        target: { x: 50, y: 60 },
      },
      client,
    )

    expect(apiGetSnapshotMock).toHaveBeenCalledTimes(1)
    expect(apiPostLoroUpdateMock).toHaveBeenCalledTimes(1)
    expect(res).toEqual({
      source: libraryPath,
      itemIndex: 1,
      insertedCount: 1,
      elementIds: ['id-0'],
    })
  })
})

describe('user library tools', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    __setExternalUrlLookupForTest(async () => [{ address: '93.184.216.34', family: 4 }])
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    __setExternalUrlLookupForTest()
  })

  it('user_library_save sends content to the daemon route', async () => {
    const tool = userLibrarySaveTool()
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/user-libraries/icons')
      expect(init?.method).toBe('PUT')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(JSON.stringify({ content: SAMPLE_LIBRARY }))
      return new Response(JSON.stringify({ name: 'icons', itemCount: 1 }), { status: 200 })
    }) as typeof globalThis.fetch

    await expect(tool.execute({ name: 'icons', content: SAMPLE_LIBRARY }, client)).resolves.toEqual({
      name: 'icons',
      itemCount: 1,
    })
  })

  it('user_library_list reads via the daemon route', async () => {
    const tool = userLibraryListTool()
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      expect(input.toString()).toBe('http://localhost:3099/api/user-libraries')
      return new Response(
        JSON.stringify({ libraries: [{ name: 'icons', path: '/tmp/icons.excalidrawlib', itemCount: 1 }] }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    await expect(tool.execute({}, client)).resolves.toEqual({
      libraries: [{ name: 'icons', path: '/tmp/icons.excalidrawlib', itemCount: 1 }],
    })
  })

  it('user_library_remove deletes via the daemon route', async () => {
    const tool = userLibraryRemoveTool()
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/user-libraries/icons')
      expect(init?.method).toBe('DELETE')
      return new Response(JSON.stringify({ removed: 'icons', remaining: [] }), { status: 200 })
    }) as typeof globalThis.fetch

    await expect(tool.execute({ name: 'icons' }, client)).resolves.toEqual({
      removed: 'icons',
      remaining: [],
    })
  })

  it('user_library_save rejects unsafe fromUrl before fetch', async () => {
    const tool = userLibrarySaveTool()
    globalThis.fetch = vi.fn() as typeof globalThis.fetch

    await expect(
      tool.execute({ name: 'icons', fromUrl: 'http://localhost/lib.excalidrawlib' }, client),
    ).rejects.toThrow(/private or local/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('user_library_save rejects .local fromUrl before fetch', async () => {
    const tool = userLibrarySaveTool()
    globalThis.fetch = vi.fn() as typeof globalThis.fetch

    await expect(
      tool.execute({ name: 'icons', fromUrl: 'https://diagram.local/lib.excalidrawlib' }, client),
    ).rejects.toThrow(/private or local/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('user_library_metadata_get reads via the daemon route', async () => {
    const tool = userLibraryMetadataGetTool()
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      expect(input.toString()).toBe('http://localhost:3099/api/user-libraries/icons/metadata')
      return new Response(
        JSON.stringify({
          version: 1,
          revision: 3,
          aliases: { cloud_run: 13 },
          notes: { '13': 'preferred icon' },
          scales: { '13': 1.25 },
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    await expect(tool.execute({ name: 'icons' }, client)).resolves.toEqual({
      version: 1,
      revision: 3,
      aliases: { cloud_run: 13 },
      notes: { '13': 'preferred icon' },
      scales: { '13': 1.25 },
    })
  })

  it('user_library_metadata_set sends merge payload to the daemon route', async () => {
    const tool = userLibraryMetadataSetTool()
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/user-libraries/icons/metadata')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(
        JSON.stringify({
          revision: 2,
          aliases: { cloud_run: 13 },
          notes: { '13': 'preferred icon' },
        }),
      )
      return new Response(
        JSON.stringify({
          version: 1,
          revision: 3,
          aliases: { cloud_run: 13 },
          notes: { '13': 'preferred icon' },
          scales: {},
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    await expect(
      tool.execute(
        {
          name: 'icons',
          revision: 2,
          aliases: { cloud_run: 13 },
          notes: { '13': 'preferred icon' },
        },
        client,
      ),
    ).resolves.toEqual({
      version: 1,
      revision: 3,
      aliases: { cloud_run: 13 },
      notes: { '13': 'preferred icon' },
      scales: {},
    })
  })

  it('user_library_metadata_delete sends delete payload to the daemon route', async () => {
    const tool = userLibraryMetadataDeleteTool()
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/user-libraries/icons/metadata')
      expect(init?.method).toBe('DELETE')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(
        JSON.stringify({
          revision: 3,
          aliasKeys: ['cloud_run'],
          noteKeys: ['13'],
        }),
      )
      return new Response(
        JSON.stringify({
          version: 1,
          revision: 4,
          aliases: {},
          notes: {},
          scales: {},
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    await expect(
      tool.execute(
        {
          name: 'icons',
          revision: 3,
          aliasKeys: ['cloud_run'],
          noteKeys: ['13'],
        },
        client,
      ),
    ).resolves.toEqual({
      version: 1,
      revision: 4,
      aliases: {},
      notes: {},
      scales: {},
    })
  })

  it('user_library_metadata_set surfaces daemon conflict responses', async () => {
    const tool = userLibraryMetadataSetTool()
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'conflict', message: 'revision mismatch' }), { status: 409 }),
    ) as typeof globalThis.fetch

    await expect(
      tool.execute({ name: 'icons', revision: 0, aliases: { cloud_run: 13 } }, client),
    ).rejects.toThrow(/revision mismatch/)
  })
})
