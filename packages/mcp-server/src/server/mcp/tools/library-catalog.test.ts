import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SAMPLE_CATALOG = [
  {
    id: 'r-icons',
    name: 'R Icons',
    description: 'R and RStudio icons.',
    authors: [{ name: 'Jumping Rivers', url: 'https://jumpingrivers.com' }],
    source: 'jumpingrivers/r.excalidrawlib',
    preview: 'jumpingrivers/r.png',
    created: '2021-08-22',
    updated: '2021-08-22',
    version: 1,
  },
  {
    id: 'kubernetes-icons',
    name: 'Kubernetes Icons',
    description: 'K8s workload / networking icons.',
    authors: [{ name: 'K8s Community' }],
    source: 'k8s/icons.excalidrawlib',
    preview: 'k8s/icons.png',
    created: '2022-01-01',
    updated: '2023-06-01',
    version: 2,
  },
  {
    id: 'software-architecture',
    name: 'Software Architecture',
    description: 'Database, browser, mobile stencils for architecture diagrams.',
    authors: [{ name: 'Youri Tjang' }],
    source: 'youritjang/software-architecture.excalidrawlib',
    preview: 'youritjang/software-architecture.png',
    created: '2021-03-01',
    updated: '2021-03-01',
    version: 1,
  },
]

describe('libraryCatalogListTool', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: number

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    fetchCalls = 0
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      fetchCalls += 1
      expect(url.toString()).toBe('https://libraries.excalidraw.com/libraries.json')
      return new Response(JSON.stringify(SAMPLE_CATALOG), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch
    const mod = await import('./library-catalog.js')
    mod.__resetCatalogCacheForTest?.()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('case 248', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({})
    expect(res.totalCount).toBe(3)
    expect(res.returnedCount).toBe(3)
    expect(res.items[0].url).toBe(
      'https://libraries.excalidraw.com/libraries/jumpingrivers/r.excalidrawlib',
    )
    expect(res.items[0].previewUrl).toBe(
      'https://libraries.excalidraw.com/libraries/jumpingrivers/r.png',
    )
  })

  it('case 249', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({ query: 'k8s' })
    expect(res.returnedCount).toBe(1)
    expect(res.items[0].id).toBe('kubernetes-icons')
  })

  it('case 250', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({ query: 'youri' })
    expect(res.returnedCount).toBe(1)
    expect(res.items[0].id).toBe('software-architecture')
  })

  it('case 251', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({ limit: 2 })
    expect(res.totalCount).toBe(3)
    expect(res.returnedCount).toBe(2)
    expect(res.items).toHaveLength(2)
  })

  it('case 252', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const tool = libraryCatalogListTool()
    await tool.execute({})
    await tool.execute({ query: 'icons' })
    expect(fetchCalls).toBe(1)
  })

  it('case 253', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({ query: 'icons', limit: 1 })
    expect(res.totalCount).toBe(2)
    expect(res.returnedCount).toBe(1)
  })

  it('case 254', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({ query: 'icons kubernetes' })
    expect(res.returnedCount).toBe(1)
    expect(res.items[0].id).toBe('kubernetes-icons')
  })

  it('case 255', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({ query: 'icons snowflake' })
    expect(res.returnedCount).toBe(0)
  })

  it('case 256', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({ query: 'youri architecture' })
    expect(res.returnedCount).toBe(1)
    expect(res.items[0].id).toBe('software-architecture')
  })

  it('case 257', async () => {
    const { libraryCatalogListTool } = await import('./library-catalog.js')
    const res = await libraryCatalogListTool().execute({ query: '  icons   kubernetes  ' })
    expect(res.returnedCount).toBe(1)
  })
})
