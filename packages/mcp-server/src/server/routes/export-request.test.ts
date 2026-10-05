import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spatialRenderStyleSchema } from '@kamiazya/whiteboard-canvas-render'
import { unknownStyleRefusal } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { exportRequestSchema } from '../../shared/api-contracts/export.js'
import { exportSvgRequestSchema } from '../../shared/api-contracts/export-svg.js'
import {
  documentMissingBody,
  readExportBody,
  resolveRequestedOutputPath,
  writeExportFile,
} from './export-request.js'

/** A layout whose every workspace exports into `dir`. */
const exportsAt = (dir: string) => ({ exportsDir: () => dir })

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
    await expect(resolveRequestedOutputPath({}, 'ws', exportsAt(dir))).resolves.toEqual({
      outputPath: undefined,
    })
    await expect(
      resolveRequestedOutputPath({ outputPath: '' }, 'ws', exportsAt(dir)),
    ).resolves.toEqual({
      outputPath: undefined,
    })
  })

  it('accepts an absolute path inside the exports directory that nothing occupies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    const outputPath = join(dir, 'board.png')
    await expect(resolveRequestedOutputPath({ outputPath }, 'ws', exportsAt(dir))).resolves.toEqual(
      {
        outputPath,
      },
    )
  })

  it('refuses a path outside the exports directory with a status and a body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    const outside = join(tmpdir(), 'export-request-elsewhere.png')
    const result = await resolveRequestedOutputPath({ outputPath: outside }, 'ws', exportsAt(dir))
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it('refuses an occupied path unless overwrite is asked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    const outputPath = join(dir, 'taken.png')
    await writeFile(outputPath, 'x')
    const refused = await resolveRequestedOutputPath({ outputPath }, 'ws', exportsAt(dir))
    expect('error' in refused).toBe(true)
    await expect(
      resolveRequestedOutputPath({ outputPath, overwrite: true }, 'ws', exportsAt(dir)),
    ).resolves.toEqual({ outputPath })
  })

  // A failure that is not a judgement on the path is the file system's, and
  // answering it as a 400 would blame the caller for it.
  it('rethrows a file-system failure rather than refusing the path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    await writeFile(join(dir, 'a-file'), 'x')
    const throughAFile = join(dir, 'a-file', 'board.png')
    await expect(
      resolveRequestedOutputPath({ outputPath: throughAFile }, 'ws', exportsAt(dir)),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('the shared bodies', () => {
  it('names the missing document by workspace and path', () => {
    expect(documentMissingBody('ws', 'notes/plan')).toEqual({
      error: 'not_found',
      message: 'Document not found: ws/notes/plan',
    })
  })
})

describe('writeExportFile', () => {
  it('lands two default exports taken in the same instant at distinct paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const target = {
      outputPath: undefined,
      layout: exportsAt(dir),
      workspaceId: 'ws',
      path: 'board',
      extension: 'png',
    }

    const a = await writeExportFile('first', target)
    const b = await writeExportFile('second', target)

    expect(a.startsWith(join(dir, 'board-'))).toBe(true)
    expect(a.endsWith('.png')).toBe(true)
    expect(a).not.toBe(b)
    await expect(readFile(a, 'utf-8')).resolves.toBe('first')
    await expect(readFile(b, 'utf-8')).resolves.toBe('second')
  })

  it('writes a caller-chosen path as it is, creating its directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-request-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const outputPath = join(dir, 'nested', 'board.svg')

    const written = await writeExportFile('<svg/>', {
      outputPath,
      layout: exportsAt(dir),
      workspaceId: 'ws',
      path: 'board',
      extension: 'svg',
    })

    expect(written).toBe(outputPath)
    await expect(readFile(outputPath, 'utf-8')).resolves.toBe('<svg/>')
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
