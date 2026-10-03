import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { exportRequestSchema } from '../../shared/api-contracts/export.js'
import { exportSvgRequestSchema } from '../../shared/api-contracts/export-svg.js'
import {
  defaultExportPath,
  documentMissingBody,
  parseExportBody,
  parseOptionalJsonBody,
  resolveRequestedOutputPath,
} from './export-request.js'

const schema = z.object({ scale: z.number().min(1).optional() }).strict()

describe('parseOptionalJsonBody', () => {
  it('reads an empty body as the schema defaults, since every export option has one', () => {
    expect(parseOptionalJsonBody('', schema)).toEqual({ body: {} })
  })

  it('refuses a body that is present and not JSON before the schema sees it', () => {
    const result = parseOptionalJsonBody('{not json', schema)
    expect(result).toEqual({ error: { error: 'invalid_request', message: 'malformed JSON' } })
  })

  it('refuses a body the schema rejects, naming the stray key', () => {
    expect(parseOptionalJsonBody('{"zzz":1}', schema)).toEqual({
      error: expect.objectContaining({
        error: 'invalid_request',
        message: expect.stringContaining('zzz'),
      }),
    })
  })

  it('answers the parsed body when it fits', () => {
    expect(parseOptionalJsonBody('{"scale":2}', schema)).toEqual({ body: { scale: 2 } })
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
] as const)('parseExportBody (%s)', (_format, requestSchema) => {
  it.each([
    'clean',
    'document',
    'visual.sketch',
    'visual.neon',
  ])('lets style %s through', (style) => {
    expect(parseExportBody(JSON.stringify({ style }), requestSchema)).toEqual({ body: { style } })
  })

  it('lets an empty body through', () => {
    expect(parseExportBody('', requestSchema)).toEqual({ body: {} })
  })

  it('refuses a style naming no registered theme, with every registered id', () => {
    const parsed = parseExportBody(JSON.stringify({ style: 'visual.nope' }), requestSchema)
    expect(parsed).toMatchObject({
      error: {
        error: 'invalid_request',
        message: expect.stringContaining('"visual.nope"'),
      },
    })
    expect(parsed).toMatchObject({
      error: { message: expect.stringContaining('visual.sketch, visual.neon') },
    })
  })

  it('keeps the body check first: malformed JSON is still malformed JSON', () => {
    expect(parseExportBody('{nope', requestSchema)).toEqual({
      error: { error: 'invalid_request', message: 'malformed JSON' },
    })
  })
})
