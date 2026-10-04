import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spatialRenderStyleSchema } from '@kamiazya/whiteboard-canvas-render'
import { unknownStyleRefusal } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { exportRequestSchema } from '../../shared/api-contracts/export.js'
import { exportSvgRequestSchema } from '../../shared/api-contracts/export-svg.js'
import {
  defaultExportPath,
  documentMissingBody,
  readExportBody,
  resolveRequestedOutputPath,
} from './export-request.js'

const schema = z
  .object({ scale: z.number().min(1).optional(), style: spatialRenderStyleSchema.optional() })
  .strict()

// The body is read from a real request, so the cases that are about the
// JSON and the schema go through a mounted route with a style-free body.
async function readFrom(requestSchema: z.ZodType<{ style?: string }>, rawText: string) {
  const app = new Hono()
  app.post('/', async (c) => {
    const read = await readExportBody(c, requestSchema)
    return 'refusal' in read ? read.refusal : c.json({ body: read.data })
  })
  const res = await app.request('/', { method: 'POST', body: rawText })
  return { status: res.status, json: (await res.json()) as unknown }
}

describe('readExportBody: the optional JSON body', () => {
  it('reads an empty body as the schema defaults, since every export option has one', async () => {
    expect(await readFrom(schema, '')).toEqual({ status: 200, json: { body: {} } })
  })

  it('refuses a body that is present and not JSON before the schema sees it', async () => {
    expect(await readFrom(schema, '{not json')).toEqual({
      status: 400,
      json: { error: 'invalid_body', message: 'the request body is not valid JSON' },
    })
  })

  it('refuses a body the schema rejects, naming the stray key', async () => {
    expect(await readFrom(schema, '{"zzz":1}')).toEqual({
      status: 400,
      json: expect.objectContaining({
        error: 'invalid_request',
        message: expect.stringContaining('zzz'),
      }),
    })
  })

  it('answers the parsed body when it fits', async () => {
    expect(await readFrom(schema, '{"scale":2}')).toEqual({
      status: 200,
      json: { body: { scale: 2 } },
    })
  })
})

describe('resolveRequestedOutputPath', () => {
  it('reads no path or an empty one as "use the default exports directory"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    await expect(resolveRequestedOutputPath({}, 'ws', dir)).resolves.toEqual({
      outputPath: undefined,
    })
    await expect(resolveRequestedOutputPath({ outputPath: '' }, 'ws', dir)).resolves.toEqual({
      outputPath: undefined,
    })
  })

  it('accepts an absolute path inside the exports directory that nothing occupies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    const outputPath = join(dir, 'board.png')
    await expect(resolveRequestedOutputPath({ outputPath }, 'ws', dir)).resolves.toEqual({
      outputPath,
    })
  })

  it('refuses a path outside the exports directory with a status and a body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    const outside = join(tmpdir(), 'export-request-elsewhere.png')
    const result = await resolveRequestedOutputPath({ outputPath: outside }, 'ws', dir)
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it('refuses an occupied path unless overwrite is asked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    const outputPath = join(dir, 'taken.png')
    await writeFile(outputPath, 'x')
    const refused = await resolveRequestedOutputPath({ outputPath }, 'ws', dir)
    expect('error' in refused).toBe(true)
    await expect(
      resolveRequestedOutputPath({ outputPath, overwrite: true }, 'ws', dir),
    ).resolves.toEqual({ outputPath })
  })
})

describe('the shared bodies', () => {
  it('names the missing document by workspace and path', () => {
    expect(documentMissingBody('ws', 'notes/plan')).toEqual({
      error: 'not_found',
      message: 'Document not found: ws/notes/plan',
    })
  })

  it('makes two default paths taken in the same instant distinct', () => {
    const a = defaultExportPath('/exports', 'board', 'png')
    const b = defaultExportPath('/exports', 'board', 'png')
    expect(a).toMatch(/^\/exports\/board-.*\.png$/)
    expect(a).not.toBe(b)
  })
})

describe.each([
  ['png', exportRequestSchema],
  ['svg', exportSvgRequestSchema],
] as const)('readExportBody (%s)', (_format, requestSchema) => {
  it.each([
    'clean',
    'document',
    'visual.sketch',
    'visual.neon',
  ])('lets style %s through', async (style) => {
    expect(await readFrom(requestSchema, JSON.stringify({ style }))).toEqual({
      status: 200,
      json: { body: { style } },
    })
  })

  it('lets an empty body through', async () => {
    expect(await readFrom(requestSchema, '')).toEqual({ status: 200, json: { body: {} } })
  })

  it('refuses a style naming no registered theme, with every registered id', async () => {
    const parsed = await readFrom(requestSchema, JSON.stringify({ style: 'visual.nope' }))
    expect(parsed.status).toBe(400)
    expect(parsed.json).toMatchObject({
      error: 'invalid_request',
      message: expect.stringContaining('"visual.nope"'),
    })
    expect(parsed.json).toMatchObject({
      message: expect.stringContaining('visual.sketch, visual.neon'),
    })
  })

  it('refuses with the same text wb_scene_render does', async () => {
    const style = 'visual.nope'
    const refusal = unknownStyleRefusal(style)
    expect(refusal).toBeDefined()
    expect(await readFrom(requestSchema, JSON.stringify({ style }))).toEqual({
      status: 400,
      json: { error: 'invalid_request', message: refusal },
    })
  })

  it('keeps the body check first: a body that is not JSON is refused as such', async () => {
    expect(await readFrom(requestSchema, '{nope')).toEqual({
      status: 400,
      json: { error: 'invalid_body', message: 'the request body is not valid JSON' },
    })
  })
})
