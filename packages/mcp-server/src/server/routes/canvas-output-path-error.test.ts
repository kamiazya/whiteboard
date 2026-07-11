import { describe, it, expect } from 'vitest'
import { OutputPathError } from '../output-path.js'
import { toCanvasOutputPathErrorBody } from './canvas-output-path-error.js'

const RAW_PATH = '/home/user/secret/project.excalidraw'

describe('toCanvasOutputPathErrorBody', () => {
  it('maps output_exists → 409 with fixed message', () => {
    const err = new OutputPathError('output_exists', `${RAW_PATH} already exists`)
    const { status, body } = toCanvasOutputPathErrorBody(err)
    expect(status).toBe(409)
    expect(body.error).toBe('output_exists')
    expect(body.message).toBe('Output file already exists.')
    expect(body.message).not.toContain(RAW_PATH)
  })

  it('maps invalid_output_path → 400 naming the allowed workspace exports root, without leaking the rejected path', () => {
    const err = new OutputPathError('invalid_output_path', `${RAW_PATH} is outside allowed dir`)
    const { status, body } = toCanvasOutputPathErrorBody(err, 'ws1')
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_output_path')
    expect(body.message).toContain('ws1/exports')
    expect(body.message).not.toContain(RAW_PATH)
  })

  it('falls back to 400 + generic message for an unrecognized code', () => {
    const err = { code: 'future_code', message: RAW_PATH } as unknown as OutputPathError
    const { status, body } = toCanvasOutputPathErrorBody(err, 'ws1')
    expect(status).toBe(400)
    expect(body.message).toBe('Export output path rejected.')
    expect(body.message).not.toContain(RAW_PATH)
  })

  it('preserves err.code in body.error for each known code', () => {
    expect(
      toCanvasOutputPathErrorBody(new OutputPathError('output_exists', 'x'), 'ws1').body.error,
    ).toBe('output_exists')
    expect(
      toCanvasOutputPathErrorBody(new OutputPathError('invalid_output_path', 'x'), 'ws1').body
        .error,
    ).toBe('invalid_output_path')
  })
})
