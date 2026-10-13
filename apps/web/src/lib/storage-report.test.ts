import { describe, expect, it } from 'vitest'
import { readStorageReport } from './storage-report.js'

const bucket = { bytes: 1, files: 1 }
const report = {
  totalBytes: 5,
  fileCount: 5,
  byCategory: { blobs: bucket, files: bucket, exports: bucket, db: bucket, other: bucket },
}

describe('readStorageReport', () => {
  it('answers the parsed report from the storage route', async () => {
    const urls: string[] = []
    const fetchApi = (async (url: string) => {
      urls.push(url)
      return Response.json(report)
    }) as unknown as typeof globalThis.fetch
    await expect(readStorageReport(fetchApi)).resolves.toEqual({ report })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/\/api\//)
  })

  it('answers the status as the error for a non-ok response', async () => {
    const fetchApi = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch
    await expect(readStorageReport(fetchApi)).resolves.toEqual({ error: 'HTTP 503' })
  })

  it('answers a thrown fetch as its message rather than rejecting', async () => {
    const fetchApi = (async () => {
      throw new Error('offline')
    }) as unknown as typeof globalThis.fetch
    await expect(readStorageReport(fetchApi)).resolves.toEqual({ error: 'offline' })
  })
})
